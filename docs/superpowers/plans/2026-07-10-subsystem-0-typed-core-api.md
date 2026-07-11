# Subsystem 0 — Typed Core API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop app a typed API over Vanguard core — structured run config in, structured events out — without shelling out and scraping stdout, and without touching the CLI's public surface.

**Architecture:** Add an optional `onEvent` callback threaded through the pipeline runner (`runBudgetedStages`) and `runSourcedIssue`; absent ⇒ byte-identical CLI behavior, present ⇒ structured `RunEvent`s. Add a pure `capabilities()` surface (providers/flows/transports/defaults). Expose both to the desktop via a persistent `vanguard __sidecar` child process speaking newline-delimited JSON over stdio (no bundled Node binary, no network port).

**Tech Stack:** TypeScript (strict, ESM, Node 24+), Vitest, Rust/Tauri 2 (desktop), `execa` (test git fixtures).

## Global Constraints

- Node `>=24`; ESM with explicit `.js` import extensions on every relative import.
- **CLI is additive-only** — never rename, remove, or change an existing flag/subcommand/behavior. New hidden subcommand `__sidecar` is additive and acceptable.
- **Never modify files under `.github/workflows/`.**
- `pnpm typecheck` and `pnpm test` must pass before a task is done.
- Match surrounding style: explicit return types, `const`, early returns, minimal diffs.
- Back-compat invariant: when `onEvent` is `undefined`, no behavioral change — all existing `console.log` output preserved.

---

## File Structure

- `src/pipeline/events.ts` *(new)* — the `RunEvent` union. Zero imports (uses `string` for stage names to avoid coupling).
- `src/pipeline/pipeline.ts` *(modify)* — add `onEvent?` to `RunStagesOptions`; emit `stage-start` / `stage-end` / `cost` in `runBudgetedStages`.
- `src/pipeline/pipeline.test.ts` *(modify)* — event-ordering test using the existing `costingAgent` / `threeStages` / `ctx` harness.
- `src/runners/source-adapter.ts` *(modify)* — add `onEvent?` to `RunIssueDeps`; emit `run-start` / `run-end`; thread `onEvent` into `runStages`.
- `src/api/capabilities.ts` *(new)* — `capabilities()` + the tiny `FLOWS` registry.
- `src/api/capabilities.test.ts` *(new)* — asserts providers/flows/transports/defaults.
- `src/sidecar/sidecar.ts` *(new)* — `runSidecar(lines, write, deps)`: DI-based stdio JSON loop.
- `src/sidecar/deps.ts` *(new)* — `productionDeps()`: wires the real `capabilities()` + `createRun` → source runners.
- `src/sidecar/sidecar.test.ts` *(new)* — drives the loop with stub deps (capabilities, createRun event stream, malformed input, unknown method).
- `src/cli/args.ts` *(modify)* — parse `__sidecar` → `{ kind: 'sidecar' }`.
- `src/cli/index.ts` *(modify)* — dispatch `kind: 'sidecar'` → `runSidecar(...)`.
- `apps/desktop/src-tauri/src/sidecar.rs` *(new)* — spawn/hold `vanguard __sidecar`; `api_capabilities`, `api_create_run` commands.
- `apps/desktop/src-tauri/src/lib.rs` *(modify)* — `mod sidecar;` + register commands.
- `apps/desktop/src/ipc.ts` *(modify)* — `apiCapabilities()`, `apiCreateRun(params)` typed wrappers.

**Deviation from spec (deliberate, laziness):** the spec described "Tauri bundles core as a Node sidecar binary." For v0 we instead spawn `vanguard __sidecar` from PATH — the desktop already assumes `vanguard` is on PATH (`spawn.rs` runs `sh -c "vanguard …"`). No `externalBin`, no bundled Node runtime. Add real bundling only when distributing to machines without `vanguard` installed.

---

### Task 1: RunEvent type + runner event seam (`stage-start`/`stage-end`/`cost`)

**Files:**
- Create: `src/pipeline/events.ts`
- Modify: `src/pipeline/pipeline.ts` (`RunStagesOptions` ~`:51`, `runBudgetedStages` `:219`)
- Test: `src/pipeline/pipeline.test.ts` (inside `describe('runBudgetedStages', …)` ~`:151`)

**Interfaces:**
- Produces: `RunEvent` union; `RunStagesOptions.onEvent?: (e: RunEvent) => void`.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('runBudgetedStages', () => { … })` block (it already defines `costingAgent` and `threeStages`), and add `RunEvent` to the top-of-file import from `./events.js`:

```ts
// add near the other imports at the top of pipeline.test.ts:
import type { RunEvent } from './events.js';

// add inside describe('runBudgetedStages', ...):
it('emits ordered stage + cost events when onEvent is set', async () => {
  const wm = new WorktreeManager(repo);
  const ctx = await prepareContext({ taskId: 'ev', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
  const events: RunEvent[] = [];
  await runBudgetedStages(ctx, threeStages, {
    agent: costingAgent(0.01),
    maxCostUsd: 1,
    onEvent: (e) => events.push(e),
  });
  expect(events.map((e) => e.type)).toEqual([
    'stage-start', 'stage-end', 'cost',
    'stage-start', 'stage-end', 'cost',
    'stage-start', 'stage-end', 'cost',
  ]);
  expect(events.filter((e) => e.type === 'stage-start').map((e) => (e as { name: string }).name)).toEqual(['a', 'b', 'c']);
  const lastCost = events.filter((e) => e.type === 'cost').at(-1) as { usdSpent: number } | undefined;
  expect(lastCost?.usdSpent).toBeCloseTo(0.03);
  await disposeContext(ctx);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pipeline/pipeline.test.ts -t "emits ordered stage"`
Expected: FAIL — `Cannot find module './events.js'` (or `onEvent` type error).

- [ ] **Step 3: Create the RunEvent type**

Create `src/pipeline/events.ts`:

```ts
/**
 * Structured run events emitted by the pipeline runner and source-adapter when a caller passes
 * `onEvent`. Stage names are plain strings (matching StageOutcome.name) to keep this module
 * import-free. Consumed by the sidecar; the CLI never sets onEvent, so its behavior is unchanged.
 */
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number; usdCap: number }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean; partial?: boolean; reason?: string };
```

- [ ] **Step 4: Add `onEvent` to `RunStagesOptions` and emit in `runBudgetedStages`**

In `src/pipeline/pipeline.ts`, add the import near the other type imports:

```ts
import type { RunEvent } from './events.js';
```

Add the field to `RunStagesOptions` (currently ends with `fork?: ForkOptions;`):

```ts
export interface RunStagesOptions {
  agent: AgentProvider;
  variables?: Record<string, string>;
  signal?: AbortSignal;
  maxCostUsd?: number;
  /** When set, run the implementer stage via forkAndSelect instead of a single pass. */
  fork?: ForkOptions;
  /** When set, receives structured run events (stage lifecycle + cost). Absent ⇒ no events, no behavior change. */
  onEvent?: (e: RunEvent) => void;
}
```

Inside `runBudgetedStages`, just after `let spentUsd = 0;` and before `for (const stage of stages) {`, add:

```ts
  const emit = opts.onEvent ?? ((): void => {});
  let index = 0;
  const of = stages.length;
```

At the very top of the loop body, immediately after the `if (spentUsd >= maxCostUsd) { … }` freeze guard, add:

```ts
    emit({ type: 'stage-start', name: stage.name, index, of });
```

In the **fork path**, immediately after `spentUsd = roundUsd(spentUsd + forkStageCost);` (before the post-stage cap check / `continue`), add:

```ts
      emit({ type: 'stage-end', name: stage.name, index, of, outcome: result.completed ? 'completed' : result.exitReason });
      emit({ type: 'cost', usdSpent: spentUsd, usdCap: maxCostUsd });
      index += 1;
```

> In the fork path the winning result is `result` (a `RunResult`, from `forkResult.winner`) — `result.completed` / `result.exitReason` are the fields.

In the **normal path**, immediately after `spentUsd = roundUsd(spentUsd + stageCost);` (before the post-stage `onStageBudgetExceeded` check), add:

```ts
    emit({ type: 'stage-end', name: stage.name, index, of, outcome: result.completed ? 'completed' : result.exitReason });
    emit({ type: 'cost', usdSpent: spentUsd, usdCap: maxCostUsd });
    index += 1;
```

(Do not add a second `index += 1` — the fork path `continue`s, so each iteration increments exactly once.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/pipeline/pipeline.test.ts -t "emits ordered stage"`
Expected: PASS.

- [ ] **Step 6: Verify no regression + types**

Run: `pnpm vitest run src/pipeline/pipeline.test.ts && pnpm typecheck`
Expected: all pipeline tests PASS (the existing "completes when under budget" / "freezes" tests still green — proves `onEvent` absent = unchanged), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/events.ts src/pipeline/pipeline.ts src/pipeline/pipeline.test.ts
git commit -m "feat(pipeline): optional onEvent seam emits stage + cost events"
```

---

### Task 2: Thread `onEvent` through `runSourcedIssue` (`run-start`/`run-end`)

**Files:**
- Modify: `src/runners/source-adapter.ts` (`RunIssueDeps` `:103`, `runSourcedIssue` `:213`, `runStages` call `:~289`, three `return` sites `:~372/:~387/:~441`)

**Interfaces:**
- Consumes: `RunEvent` (Task 1), `RunStagesOptions.onEvent` (Task 1).
- Produces: `RunIssueDeps.onEvent?: (e: RunEvent) => void`.

This task has no unit test — `runSourcedIssue` provisions a Docker sandbox and cannot be unit-tested without the full stack. Its correctness rests on (a) the back-compat invariant (we only *add* emits guarded by `onEvent`, and never touch existing `console.log`), verified by the existing `src/cli/run.test.ts` staying green, and (b) manual dogfood in Task 5. This is acceptable: the change is three guarded callback calls plus one options field.

- [ ] **Step 1: Add the import and the deps field**

In `src/runners/source-adapter.ts`, add near the other type imports:

```ts
import type { RunEvent } from '../pipeline/events.js';
```

Add to `RunIssueDeps` (currently ends with `reviewGate?: boolean;`):

```ts
  /** When set, receives structured run events. Absent ⇒ no events (CLI path). Threaded to runStages + run-start/run-end. */
  onEvent?: (e: RunEvent) => void;
```

- [ ] **Step 2: Emit `run-start` and pass `onEvent` into `runStages`**

Find the `const outcomes = await runStages(ctx, pipeline, { … });` call. Immediately **before** it, add:

```ts
      deps.onEvent?.({
        type: 'run-start',
        taskId: adapter.taskId(task),
        flow: deps.plan === true ? 'plan' : 'default',
        provider: agents.agent.name,
        stages: pipeline.map((s) => s.name),
      });
```

Add `onEvent` to the `runStages` options object (alongside `agent`, `variables`, the optional `fork`):

```ts
        ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
```

- [ ] **Step 3: Emit `run-end` at each return site**

At `return { task, secretBlocked: true };`, insert immediately above:

```ts
        deps.onEvent?.({ type: 'run-end', secretBlocked: true });
```

At `return { task };` (no-changes path), insert immediately above:

```ts
        deps.onEvent?.({ type: 'run-end' });
```

At `return { task, prUrl: pr.prUrl };` (success path), insert immediately above:

```ts
      deps.onEvent?.({ type: 'run-end', prUrl: pr.prUrl });
```

- [ ] **Step 4: Verify back-compat + types**

Run: `pnpm vitest run src/cli/run.test.ts src/runners && pnpm typecheck`
Expected: PASS — existing runner/CLI tests unchanged (proves `onEvent` undefined = no behavior change), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/runners/source-adapter.ts
git commit -m "feat(runners): thread onEvent through runSourcedIssue (run-start/run-end)"
```

---

### Task 3: Capabilities API + FLOWS registry

**Files:**
- Create: `src/api/capabilities.ts`
- Test: `src/api/capabilities.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_NAMES` (`src/agents/registry.ts:159`), `implementReviewSimplifyStages` / `planImplementReviewStages` (`src/pipeline/pipeline.ts:452/:702`).
- Produces: `capabilities(): Capabilities`; `FLOWS: Record<string, { label: string; build: () => PipelineStage[] }>`; types `Capabilities`, `FlowInfo`.

- [ ] **Step 1: Write the failing test**

Create `src/api/capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { capabilities, FLOWS } from './capabilities.js';
import { PROVIDER_NAMES } from '../agents/registry.js';

describe('capabilities', () => {
  it('lists every registered provider', () => {
    expect(capabilities().providers).toEqual([...PROVIDER_NAMES]);
  });

  it('lists flows including the default, each with a label', () => {
    const names = capabilities().flows.map((f) => f.name);
    expect(names).toContain('default');
    expect(capabilities().flows.every((f) => f.label.length > 0)).toBe(true);
  });

  it('exposes the three task transports and sane defaults', () => {
    const caps = capabilities();
    expect(caps.transports).toEqual(['github', 'gitlab', 'linear']);
    expect(caps.defaults).toEqual({ provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' });
  });

  it('every FLOWS entry builds a non-empty stage array', () => {
    for (const [, flow] of Object.entries(FLOWS)) {
      expect(flow.build().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/api/capabilities.test.ts`
Expected: FAIL — `Cannot find module './capabilities.js'`.

- [ ] **Step 3: Implement the capabilities surface**

Create `src/api/capabilities.ts`:

```ts
import { PROVIDER_NAMES } from '../agents/registry.js';
import { implementReviewSimplifyStages, planImplementReviewStages, type PipelineStage } from '../pipeline/pipeline.js';

/** A selectable flow: its stable key and a human label for the UI. */
export interface FlowInfo {
  name: string;
  label: string;
}

/** What the run builder renders from — providers, flows, transports, and initial field defaults. */
export interface Capabilities {
  providers: string[];
  flows: FlowInfo[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

/**
 * Name-addressable flow registry. v0 registers only the TS-authored flows that already exist;
 * Subsystem 2 populates HCL-loaded flows (A/B). Kept intentionally tiny — this is not the HCL loader.
 */
export const FLOWS: Record<string, { label: string; build: () => PipelineStage[] }> = {
  default: { label: 'Implement → review → simplify', build: implementReviewSimplifyStages },
  plan: { label: 'Plan → implement → review', build: planImplementReviewStages },
};

/** Pure capability surface for the typed API. No side effects. */
export function capabilities(): Capabilities {
  return {
    providers: [...PROVIDER_NAMES],
    flows: Object.entries(FLOWS).map(([name, f]) => ({ name, label: f.label })),
    transports: ['github', 'gitlab', 'linear'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  };
}
```

> If `PipelineStage` is not exported from `pipeline.ts`, add `export` to its `interface PipelineStage` declaration (it is a public composition type; exporting is additive and safe).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/api/capabilities.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/capabilities.ts src/api/capabilities.test.ts
git commit -m "feat(api): capabilities() surface + tiny FLOWS registry"
```

---

### Task 4: Sidecar stdio loop + hidden `__sidecar` subcommand

**Files:**
- Create: `src/sidecar/sidecar.ts`, `src/sidecar/deps.ts`
- Test: `src/sidecar/sidecar.test.ts`
- Modify: `src/cli/args.ts` (parser), `src/cli/index.ts` (dispatch `:20`)

**Interfaces:**
- Consumes: `capabilities()`, `FLOWS` (Task 3); `RunEvent` (Task 1); `RunIssueResult` (`src/runners/source-adapter.ts:164`).
- Produces: `runSidecar(lines, write, deps)`; `SidecarDeps`; `CreateRunParams`; `productionDeps()`.

The loop is DI-based so the event-streaming path is unit-testable without Docker: tests inject a stub `createRun`. The **production** `createRun` (real `runSourcedIssue` wiring) is thin and smoke-verified in Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/sidecar/sidecar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runSidecar, type SidecarDeps } from './sidecar.js';
import type { RunEvent } from '../pipeline/events.js';

async function* lines(...ls: string[]): AsyncIterable<string> {
  for (const l of ls) yield l;
}

function collect(): { write: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { write: (l) => out.push(l), out };
}

const stubDeps = (over: Partial<SidecarDeps> = {}): SidecarDeps => ({
  capabilities: () => ({ providers: ['claude'], flows: [{ name: 'default', label: 'D' }], transports: ['github', 'gitlab', 'linear'], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } }),
  createRun: async (_params, onEvent): Promise<{ prUrl?: string }> => {
    onEvent({ type: 'stage-start', name: 'implementer', index: 0, of: 1 } as RunEvent);
    return { prUrl: 'https://example/pr/1' };
  },
  ...over,
});

describe('runSidecar', () => {
  it('answers capabilities with a correlated result line', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'c1', method: 'capabilities' })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0].id).toBe('c1');
    expect(parsed[0].result.providers).toEqual(['claude']);
  });

  it('streams events then a result for createRun', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'r1', method: 'createRun', params: { issueRef: 'gh-1', flow: 'default', provider: 'claude' } })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ id: 'r1', event: { type: 'stage-start' } });
    expect(parsed[1]).toMatchObject({ id: 'r1', result: { prUrl: 'https://example/pr/1' } });
  });

  it('returns an error line for malformed JSON, does not throw', async () => {
    const { write, out } = collect();
    await runSidecar(lines('{not json'), write, stubDeps());
    expect(JSON.parse(out[0]).error.kind).toBe('bad-request');
  });

  it('returns an error line for an unknown method', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'x', method: 'nope' })), write, stubDeps());
    expect(JSON.parse(out[0])).toMatchObject({ id: 'x', error: { kind: 'bad-request' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/sidecar/sidecar.test.ts`
Expected: FAIL — `Cannot find module './sidecar.js'`.

- [ ] **Step 3: Implement the loop**

Create `src/sidecar/sidecar.ts`:

```ts
import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';
import type { RunIssueResult } from '../runners/source-adapter.js';

/** Typed projection of a run request — a subset of RunOptions plus the issue ref and transport. */
export interface CreateRunParams {
  issueRef: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

export interface SidecarDeps {
  capabilities: () => Capabilities;
  createRun: (params: CreateRunParams, onEvent: (e: RunEvent) => void) => Promise<RunIssueResult>;
}

interface Request {
  id?: string;
  method?: string;
  params?: unknown;
}

/**
 * Stdio JSON loop. Reads one request per line, writes correlated event/result/error lines.
 * DI on `deps` so the createRun event stream is testable without a real sandbox.
 */
export async function runSidecar(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  deps: SidecarDeps,
): Promise<void> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line === '') continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      write(JSON.stringify({ error: { message: 'invalid JSON', kind: 'bad-request' } }));
      continue;
    }
    const id = req.id;
    try {
      if (req.method === 'capabilities') {
        write(JSON.stringify({ id, result: deps.capabilities() }));
      } else if (req.method === 'createRun') {
        const params = req.params as CreateRunParams;
        const result = await deps.createRun(params, (e) => write(JSON.stringify({ id, event: e })));
        write(JSON.stringify({ id, result }));
      } else {
        write(JSON.stringify({ id, error: { message: `unknown method: ${String(req.method)}`, kind: 'bad-request' } }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write(JSON.stringify({ id, error: { message, kind: 'internal' } }));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/sidecar/sidecar.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Wire production deps**

Create `src/sidecar/deps.ts`. This is the thin, smoke-verified bridge from typed params to the existing source runners. It mirrors how `src/cli/run.ts` assembles deps, but injects `onEvent`:

```ts
import { capabilities } from '../api/capabilities.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { runGithubIssue, githubDepsFromEnv } from '../runners/github.js';
import { runGitlabIssue, gitlabDepsFromEnv } from '../runners/gitlab.js';
import { runLinearIssue } from '../runners/linear.js';
import type { SidecarDeps, CreateRunParams } from './sidecar.js';
import type { RunEvent } from '../pipeline/events.js';
import type { RunIssueResult } from '../runners/source-adapter.js';

/**
 * Production wiring: build a sandbox context + provider auth from env, then dispatch to the same
 * source runner the CLI uses, with onEvent threaded in. Smoke-verified (needs Docker + creds), not
 * unit-tested. Keep this thin — logic belongs in the runners, not here.
 */
export function productionDeps(): SidecarDeps {
  return {
    capabilities,
    createRun: async (params: CreateRunParams, onEvent: (e: RunEvent) => void): Promise<RunIssueResult> => {
      const transport = params.transport ?? 'github';
      const provider = params.provider;
      const auth = agentAuthFromEnv(provider !== undefined ? { provider } : {});
      const ctx = await startSandboxContext({
        egress: true,
        ...(auth !== undefined ? { auth } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
      try {
        const common = {
          onEvent,
          ...(provider !== undefined ? { provider } : {}),
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.baseBranch !== undefined ? { baseBranch: params.baseBranch } : {}),
          ...(params.flow === 'plan' ? { plan: true } : {}),
          proxyUrl: ctx.proxyUrl,
          network: ctx.network,
          llmProxy: ctx.llmProxy,
          ...(auth !== undefined ? { auth } : {}),
        };
        if (transport === 'gitlab') return await runGitlabIssue(params.issueRef, { ...gitlabDepsFromEnv(), ...common });
        if (transport === 'linear') return await runLinearIssue(params.issueRef, { ...common });
        return await runGithubIssue(params.issueRef, { ...githubDepsFromEnv(), ...common });
      } finally {
        await ctx.destroy();
      }
    },
  };
}
```

> The exact deps-assembly shape (which `*DepsFromEnv` helpers exist, the `runLinearIssue` deps type) must match the current `src/cli/run.ts` — read it and mirror it precisely. If a runner's deps object differs, adjust the spread; the only new field this task introduces anywhere is `onEvent`.

- [ ] **Step 6: Add the hidden `__sidecar` subcommand**

In `src/cli/args.ts`, in the command parser, add a branch that maps the first token `__sidecar` to `{ kind: 'sidecar' }` (add `'sidecar'` to the `Command` union `kind` type). Follow the file's existing parse style; the command takes no flags.

In `src/cli/index.ts`, add near the other dispatch branches (after the `help`/`error` guards):

```ts
  if (command.kind === 'sidecar') {
    const { runSidecar } = await import('../sidecar/sidecar.js');
    const { productionDeps } = await import('../sidecar/deps.js');
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    await runSidecar(rl, process.stdout.write.bind(process.stdout) as unknown as (l: string) => void, productionDeps());
    return;
  }
```

> `write` must append a newline per record. Wrap it: `(l: string) => process.stdout.write(l + '\n')`. Use that exact wrapper instead of the bind above.

- [ ] **Step 7: Verify parser + dispatch + full suite**

Run: `pnpm vitest run src/sidecar src/cli/args.test.ts && pnpm typecheck && pnpm test`
Expected: sidecar + args tests PASS; full suite green.

- [ ] **Step 8: Manual smoke — the real subcommand answers capabilities**

Run:
```bash
pnpm build && echo '{"id":"c1","method":"capabilities"}' | node dist/cli/index.js __sidecar
```
Expected: one JSON line — `{"id":"c1","result":{"providers":[...],"flows":[...],"transports":["github","gitlab","linear"],"defaults":{...}}}`.

- [ ] **Step 9: Commit**

```bash
git add src/sidecar src/cli/args.ts src/cli/index.ts src/cli/args.test.ts
git commit -m "feat(sidecar): __sidecar stdio JSON loop over capabilities + createRun"
```

---

### Task 5: Desktop — spawn `vanguard __sidecar`, typed IPC

**Files:**
- Create: `apps/desktop/src-tauri/src/sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`mod` list `:1-10`, `generate_handler!` `:129`)
- Modify: `apps/desktop/src/ipc.ts`

**Interfaces:**
- Consumes: the `__sidecar` protocol (Task 4).
- Produces: Tauri commands `api_capabilities`, `api_create_run`; TS `apiCapabilities()`, `apiCreateRun(params)`.

No unit test — Rust + child process + Tauri runtime. Verified by the smoke step. This matches spec AC#5.

- [ ] **Step 1: Rust sidecar supervisor**

Create `apps/desktop/src-tauri/src/sidecar.rs`. Spawn `vanguard __sidecar` once, hold its stdin/stdout behind a mutex, mirror the process/credential-inheritance approach in `spawn.rs`. Minimum viable:

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, State};

pub struct Sidecar(pub Mutex<Option<SidecarProc>>);

pub struct SidecarProc {
    child: Child,
    stdin: ChildStdin,
}

fn ensure(state: &State<Sidecar>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let mut child = Command::new("vanguard")
        .arg("__sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vanguard __sidecar: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    *guard = Some(SidecarProc { child, stdin });
    Ok(())
}

/// Write one request line, read lines until the matching `result`/`error`. `on_event` fires per event line.
fn request(
    state: &State<Sidecar>,
    req: serde_json::Value,
    mut on_event: impl FnMut(serde_json::Value),
) -> Result<serde_json::Value, String> {
    ensure(state)?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let proc = guard.as_mut().ok_or("sidecar down")?;
    let stdout = proc.child.stdout.take().ok_or("no stdout")?;
    writeln!(proc.stdin, "{}", req.to_string()).map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("sidecar closed".into());
        }
        let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        if v.get("event").is_some() {
            on_event(v);
        } else {
            proc.child.stdout = Some(reader.into_inner());
            return Ok(v);
        }
    }
}

#[tauri::command]
pub fn api_capabilities(state: State<Sidecar>) -> Result<serde_json::Value, String> {
    let resp = request(&state, serde_json::json!({ "id": "cap", "method": "capabilities" }), |_| {})?;
    resp.get("result").cloned().ok_or_else(|| "no result".into())
}

#[tauri::command]
pub fn api_create_run(
    app: tauri::AppHandle,
    state: State<Sidecar>,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = request(
        &state,
        serde_json::json!({ "id": "run", "method": "createRun", "params": params }),
        |ev| {
            let _ = app.emit("api:event", ev);
        },
    )?;
    resp.get("result").cloned().ok_or_else(|| resp.get("error").map(|e| e.to_string()).unwrap_or_else(|| "no result".into()))
}
```

> This is a single-in-flight design (one run at a time), matching the v0 protocol. Read `spawn.rs` and reuse its env/`sh`-inheritance conventions so the sidecar sees the same PATH/credentials the CLI shell-out does. Register the `Sidecar` state in `run()` with `.manage(Sidecar(Mutex::new(None)))`.

- [ ] **Step 2: Register the module + commands**

In `apps/desktop/src-tauri/src/lib.rs`: add `mod sidecar;` to the module list, add `.manage(sidecar::Sidecar(std::sync::Mutex::new(None)))` in `run()`, and add `sidecar::api_capabilities, sidecar::api_create_run` to the `generate_handler!` macro list.

- [ ] **Step 3: TS wrappers**

In `apps/desktop/src/ipc.ts`, add (mirroring the existing `invoke` wrappers):

```ts
export interface Capabilities {
  providers: string[];
  flows: { name: string; label: string }[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

export interface CreateRunParams {
  issueRef: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

export function apiCapabilities(): Promise<Capabilities> {
  return invoke<Capabilities>('api_capabilities');
}

export function apiCreateRun(params: CreateRunParams): Promise<{ prUrl?: string; secretBlocked?: boolean }> {
  return invoke('api_create_run', { params });
}
```

Run events arrive via the existing Tauri event channel — subscribe with `listen('api:event', …)` from `@tauri-apps/api/event` where the run UI needs them (that consumption is Subsystem 1; this task only exposes the wrappers).

- [ ] **Step 4: Smoke verify (manual)**

Run: `cd apps/desktop && pnpm start` (from a terminal with creds/PATH). In the app devtools console:
```js
await window.__TAURI__.core.invoke('api_capabilities')
```
Expected: a structured object with `providers`, `flows` (incl. `default`), `transports: ['github','gitlab','linear']`, `defaults`. No stdout parsing involved.

Also confirm the Rust side builds: `cd apps/desktop/src-tauri && cargo build` (expected: compiles; `cargo clippy` clean).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/sidecar.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/ipc.ts
git commit -m "feat(desktop): typed api_capabilities/api_create_run over vanguard __sidecar"
```

---

## Self-Review

**Spec coverage:**
- Event seam (spec §"The event seam") → Tasks 1–2. ✓ (run-start/run-end at adapter, stage/cost at runner — matches spec's split.)
- 5-variant `RunEvent`, no `verdict`/`Finding` → Task 1. ✓
- Capability surface + FLOWS fenced to default/plan → Task 3. ✓
- Sidecar stdio protocol, `id` correlation, `capabilities`/`createRun` only (no `cancelRun`) → Task 4. ✓
- Hidden `__sidecar` entry, not a documented subcommand → Task 4. ✓
- Desktop client, keep existing `spawnRun` path → Task 5 (adds alongside; does not remove `spawn_run`). ✓
- Back-compat invariant (`onEvent` undefined = identical) → Tasks 1, 2 verification steps. ✓
- Acceptance criteria 1–6 → AC1 Task 3; AC2 Task 2 step 4; AC3 Task 1; AC4 Task 4; AC5 Task 5 step 4; AC6 every task's typecheck+test gate. ✓

**Deviations (intentional, noted):** run-start/run-end emit from `runSourcedIssue` not `runBudgetedStages` (cleaner: the adapter knows flow/provider/PR; the runner knows only stages) — spec allowed this split. Desktop uses PATH `vanguard __sidecar` instead of a bundled Node binary (laziness; noted in File Structure).

**Placeholder scan:** none — every code step shows real code; the two "read and mirror `run.ts`" notes are precision instructions for existing-shape matching, not deferred logic.

**Type consistency:** `RunEvent` (5 variants) identical across Tasks 1/2/4. `Capabilities`/`CreateRunParams` identical in Tasks 3/4 (core) and Task 5 (TS mirror). `onEvent: (e: RunEvent) => void` identical on `RunStagesOptions` (Task 1) and `RunIssueDeps` (Task 2).
