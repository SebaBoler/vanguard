# Subsystem 2 — Named Workflows (HCL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the HCL flow format as a tested core library and replace the `plan`-boolean flow hack with real name-driven dispatch, delivering Flow B (`planner → implementer → adversary → repairer`) as a selectable named flow.

**Architecture:** A new `src/flows/` module owns the HCL library: parse (`@cdktf/hcl2json`) → typed `FlowDoc` → lower to `PipelineStage[]`, plus a total-or-throw emitter. Flow B ships as a static TS-backed `FLOWS` entry; HCL fidelity is proven by a round-trip test, not wired into the live registry (live `.vanguard/flows` discovery is deferred to S5). Flow selection threads as a **name string** through `RunOptions` and resolves to `FLOWS[flow].build()` inside `runSourcedIssue`.

**Tech Stack:** TypeScript (strict, ESM, explicit `.js` extensions, Node 24+), Vitest, `@cdktf/hcl2json` (devDependency, WASM, parse-only).

## Global Constraints

- CLI is a frozen public contract — every change additive; `--plan` unchanged (alias for `--flow plan`).
- A flow only ever produces `PipelineStage[]`; nothing downstream of `assembleReviewPipeline` changes.
- Flow selection threads as a **name string**, never a closure (sync CLI parser; `run-start.flow` needs the key).
- `FLOWS` stays static; `capabilities()` stays no-arg/pure; `validateCreateRun` stays synchronous. No live repo-flow discovery in S2.
- `@cdktf/hcl2json` is a **devDependency** — the shipped runtime never loads the WASM.
- Never modify `.github/workflows/`. Run `pnpm typecheck` + `pnpm test` before completion.
- Co-locate tests as `*.test.ts`. Explicit return types; `const`; early returns.

---

### Task 1: Add `@cdktf/hcl2json` devDep + CJS-from-ESM smoke test

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `src/flows/parse.ts` (stub re-export), `src/flows/hcl2json.smoke.test.ts`

**Interfaces:**
- Produces: `import { parse } from '@cdktf/hcl2json'` proven callable from ESM.

- [ ] **Step 1: Install as devDependency**

Run: `pnpm add -D @cdktf/hcl2json@0.21.0`
Expected: added under `devDependencies` in `package.json`.

- [ ] **Step 2: Write the smoke test**

```ts
// src/flows/hcl2json.smoke.test.ts
import { test, expect } from 'vitest';
import { parse } from '@cdktf/hcl2json';

test('hcl2json parses a labeled block from ESM', async () => {
  const json = await parse('t.hcl', 'flow "x" { label = "y" }');
  expect(json).toHaveProperty('flow');
  expect((json as { flow: { x: unknown[] } }).flow.x).toBeDefined();
});
```

- [ ] **Step 3: Run it**

Run: `pnpm test src/flows/hcl2json.smoke.test.ts`
Expected: PASS. If `import { parse }` fails at runtime, fall back to `import hcl2json from '@cdktf/hcl2json'; const { parse } = hcl2json;` and note it in `parse.ts`.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/flows/hcl2json.smoke.test.ts
git commit -m "chore(flows): add @cdktf/hcl2json devDep + ESM smoke test"
```

---

### Task 2: `FlowDoc` types + `parseFlowHcl`

**Files:**
- Create: `src/flows/types.ts`, `src/flows/parse.ts`, `src/flows/parse.test.ts`

**Interfaces:**
- Produces:
```ts
export interface StageDecl { name: string; ref?: string; overrides: StageOverrides; meta?: Record<string, unknown>; }
export interface StageOverrides { model?: string; effort?: 'low'|'medium'|'high'; maxTurns?: number; provider?: string; resumePrevious?: boolean; }
export interface LoopDecl { stages: string[]; until: string; max: number; }
export interface FlowDoc { name: string; label: string; stages: StageDecl[]; loops: LoopDecl[]; meta?: Record<string, unknown>; }
export function parseFlowHcl(src: string): Promise<FlowDoc>;
```

**Notes on hcl2json shape:** labeled blocks become label-keyed objects: `{ flow: { "flow-b": [ { label:["…"], stage: { planner:[{model:["opus"],…}], … }, loop:[{…}] } ] } }`. Scalars arrive as single-element arrays. Stage source order = object key insertion order (safe within `stage`; do NOT rely on cross-block-type order — that's why `loops` is a separate field, spec F9). Unknown keys in a stage/flow/loop body (outside the override table + `ref`/`label`/`meta`) → throw.

- [ ] **Step 1: Write failing tests** (`parse.test.ts`)

```ts
import { test, expect } from 'vitest';
import { parseFlowHcl } from './parse.js';

const FLOW_B = `flow "flow-b" {
  label = "Plan → implement → adversary → repair"
  stage "planner"     { model = "opus" effort = "high" max_turns = 10 resume_previous = false }
  stage "implementer" { model = "sonnet" max_turns = 30 resume_previous = false }
}`;

test('parses a valid flow into FlowDoc', async () => {
  const doc = await parseFlowHcl(FLOW_B);
  expect(doc.name).toBe('flow-b');
  expect(doc.label).toMatch(/adversary/);
  expect(doc.stages.map((s) => s.name)).toEqual(['planner', 'implementer']);
  expect(doc.stages[0]?.overrides).toEqual({ model: 'opus', effort: 'high', maxTurns: 10, resumePrevious: false });
});

test('rejects an unknown override key', async () => {
  await expect(parseFlowHcl('flow "f" { label="l" stage "planner" { bogus = 1 } }')).rejects.toThrow(/unknown.*bogus/i);
});

test('rejects until = user_accept (interactive gate deferred)', async () => {
  await expect(parseFlowHcl('flow "f" { label="l" loop { stages=["a"] until="user_accept" max=3 } }')).rejects.toThrow(/interactive gate/i);
});

test('captures a meta block verbatim without interpreting it', async () => {
  const doc = await parseFlowHcl('flow "f" { label="l" meta { x = "y" } stage "planner" { model="opus" } }');
  expect(doc.meta).toEqual({ x: 'y' });
});

test('rejects a syntactically invalid flow', async () => {
  await expect(parseFlowHcl('flow "f" {')).rejects.toThrow();
});
```

- [ ] **Step 2: Run — verify fail** (`pnpm test src/flows/parse.test.ts`) — Expected: FAIL (parseFlowHcl not implemented).

- [ ] **Step 3: Implement** `types.ts` (the interfaces above) and `parse.ts`:
  - `const OVERRIDE_KEYS = new Set(['model','effort','max_turns','provider','resume_previous'])`.
  - unwrap hcl2json single-element arrays via a `scalar(v)` helper.
  - map snake_case → camelCase for overrides; validate `effort ∈ {low,medium,high}`, `max_turns` positive int, `provider` non-empty (full `PROVIDER_NAMES` check happens at lower time where the import is cheap — keep parse dependency-light).
  - `loop.until === 'user_accept'` → `throw new Error('interactive gate not yet supported (needs pause/resume — future subsystem)')`.
  - unknown key in any body → `throw new Error(\`unknown key "\${k}" in \${blockType} "\${label}"\`)`.
  - `meta` block → store raw object, no validation.

- [ ] **Step 4: Run — verify pass.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(flows): parse HCL flow files into a typed FlowDoc`

---

### Task 3: `STAGE_LIBRARY` + drift guard

**Files:**
- Create: `src/flows/library.ts`, `src/flows/library.test.ts`

**Interfaces:**
- Consumes: `planImplementAdversaryStages` (`src/pipeline/pipeline.ts:839`).
- Produces: `export const STAGE_LIBRARY: Record<string, () => PipelineStage>;`

**Design:** the library is derived from `planImplementAdversaryStages()` **only** (spec §2 / F8). Build it by indexing that builder's output by name — no new prompt text, single source of truth.

- [ ] **Step 1: Write failing tests**

```ts
import { test, expect } from 'vitest';
import { STAGE_LIBRARY } from './library.js';
import { planImplementAdversaryStages } from '../pipeline/pipeline.js';

test('library exposes Flow B stages resolving to real records', () => {
  for (const name of ['planner', 'implementer', 'adversary', 'repairer']) {
    const rec = STAGE_LIBRARY[name]?.();
    expect(rec?.promptTemplate.length).toBeGreaterThan(0);
    expect(rec?.name).toBe(name);
  }
});

test('library records match the source builder verbatim (drift guard)', () => {
  const byName = new Map(planImplementAdversaryStages().map((s) => [s.name, s]));
  for (const [name, factory] of Object.entries(STAGE_LIBRARY)) {
    expect(factory()).toEqual(byName.get(name));
  }
});
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** `library.ts`:

```ts
import { planImplementAdversaryStages, type PipelineStage } from '../pipeline/pipeline.js';

/** Name → record for the composable stages HCL flows reference. Source of truth: planImplementAdversaryStages (spec §2). */
export const STAGE_LIBRARY: Record<string, () => PipelineStage> = Object.fromEntries(
  planImplementAdversaryStages().map((s) => [s.name, (): PipelineStage => ({ ...s })]),
);
```

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit** `feat(flows): stage library derived from planImplementAdversaryStages`

---

### Task 4: `lowerFlow` — library + overrides + `ref` resolve + path guard

**Files:**
- Create: `src/flows/lower.ts`, `src/flows/lower.test.ts`, fixture `src/flows/__fixtures__/repo/.vanguard/flows/custom.ts`

**Interfaces:**
- Consumes: `FlowDoc` (Task 2), `STAGE_LIBRARY` (Task 3), `PROVIDER_NAMES` (`src/agents/registry.ts`).
- Produces: `export function lowerFlow(doc: FlowDoc, opts: { repoPath: string }): Promise<PipelineStage[]>;`

**Behavior:** per stage — base record = library lookup, else `ref` resolve, else throw. Apply overrides via last-writer-wins spread (mirror `resolveRouting`). `ref` = `"relpath#export"`, resolved against `<repoPath>/.vanguard/`; the resolved absolute path must stay inside `<repoPath>/.vanguard/` (use `path.resolve` + prefix check) else throw; dynamic-import and read the named export (a `PipelineStage` or `() => PipelineStage`). Validate `override.provider ∈ PROVIDER_NAMES`.

- [ ] **Step 1: Write fixture** `custom.ts`:
```ts
import type { PipelineStage } from '../../../../../pipeline/pipeline.js';
export const myStage: PipelineStage = { name: 'custom', promptTemplate: 'do {{TITLE}}', maxTurns: 5 };
```

- [ ] **Step 2: Write failing tests** (`lower.test.ts`): library stage + overrides applied; order preserved; `ref` stage resolves to the fixture record; `ref = "../../etc/passwd#x"` throws `/escape|outside/`; unknown stage name (no library, no ref) throws; bad provider throws. Use `path.join(__dirname,'__fixtures__/repo')` as repoPath (derive `__dirname` via `fileURLToPath(import.meta.url)`).

- [ ] **Step 3: Run — verify fail.**

- [ ] **Step 4: Implement** `lower.ts` (dynamic import via `await import(pathToFileURL(abs).href)`; apply overrides only when `!== undefined`).

- [ ] **Step 5: Run — verify pass.**

- [ ] **Step 6: Commit** `feat(flows): lower a FlowDoc to PipelineStage[] with ref + path guard`

---

### Task 5: `emitFlowHcl` — canonical, total-or-throw

**Files:**
- Create: `src/flows/emit.ts`, `src/flows/emit.test.ts`

**Interfaces:**
- Produces: `export function emitFlowHcl(stages: PipelineStage[], opts: { name: string; label: string }): string;`

**Behavior:** emit `flow "<name>" { label = "…" <stages> }`. Per stage emit `stage "<name>" { <overrides> }` in fixed key order (`model, effort, max_turns, provider, resume_previous`), 2-space indent. **Identity fields** (`promptTemplate`, `systemPrompt`) are NOT emitted (re-supplied by the library on parse). A field present on the record that is neither identity nor in the override table (`stageCostFraction`, `timeoutMs`, `onStageBudgetExceeded`, `fallback`, `copyBack`, `resumeUntilComplete`, `stageCostFloorUsd`, `maxRepairIterations`, etc.) → `throw new Error(\`cannot emit field "\${k}"…\`)`. Escape `"`/`\` in string values.

- [ ] **Step 1: Write failing tests**

```ts
import { test, expect } from 'vitest';
import { emitFlowHcl } from './emit.js';
import type { PipelineStage } from '../pipeline/pipeline.js';

test('emits canonical HCL for a library-shaped stage', () => {
  const stages: PipelineStage[] = [{ name: 'planner', promptTemplate: 'p', systemPrompt: 's', model: 'opus', effort: 'high', maxTurns: 10, resumePrevious: false }];
  const hcl = emitFlowHcl(stages, { name: 'f', label: 'L' });
  expect(hcl).toContain('flow "f"');
  expect(hcl).toContain('stage "planner"');
  expect(hcl).toContain('model = "opus"');
  expect(hcl).not.toContain('promptTemplate');
});

test('throws on a non-representable field rather than dropping it', () => {
  const stages: PipelineStage[] = [{ name: 'implementer', promptTemplate: 'p', stageCostFraction: 0.6 }];
  expect(() => emitFlowHcl(stages, { name: 'f', label: 'L' })).toThrow(/cannot emit.*stageCostFraction/);
});
```

- [ ] **Step 2–4:** Run fail → implement `emit.ts` (iterate a fixed `EMITTABLE`/`IDENTITY` set; any other key present → throw) → run pass.

- [ ] **Step 5: Commit** `feat(flows): total-or-throw canonical HCL emitter`

---

### Task 6: Round-trip + Flow-A parse/emit + generated `flow-b.hcl`

**Files:**
- Create: `src/flows/roundtrip.test.ts`, `src/flows/flow-b.hcl`, `src/flows/__fixtures__/flow-a.hcl`, `scripts/gen-flow-b.ts`

**Interfaces:**
- Consumes: all of Tasks 2–5 + `planImplementAdversaryStages`.

- [ ] **Step 1: Write the round-trip + codegen tests** (`roundtrip.test.ts`)

```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planImplementAdversaryStages } from '../pipeline/pipeline.js';
import { emitFlowHcl } from './emit.js';
import { parseFlowHcl } from './parse.js';
import { lowerFlow } from './lower.js';

const KEYS = ['name', 'model', 'effort', 'maxTurns', 'resumePrevious', 'promptTemplate', 'systemPrompt'] as const;
const pick = (s: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(KEYS.map((k) => [k, s[k]]));

test('Flow B round-trips through emit → parse → lower', async () => {
  const src = planImplementAdversaryStages();
  const hcl = emitFlowHcl(src, { name: 'flow-b', label: 'L' });
  const lowered = await lowerFlow(await parseFlowHcl(hcl), { repoPath: '/nonexistent' });
  expect(lowered.map(pick)).toEqual(src.map(pick));
});

test('checked-in flow-b.hcl equals the emitter output (codegen diff)', () => {
  const disk = readFileSync(fileURLToPath(new URL('./flow-b.hcl', import.meta.url)), 'utf8');
  expect(disk.trimEnd()).toBe(emitFlowHcl(planImplementAdversaryStages(), { name: 'flow-b', label: 'Plan → implement → adversary → repair' }).trimEnd());
});

test('flow-a.hcl parses and re-emits (positive deferred-flow path)', async () => {
  const src = readFileSync(fileURLToPath(new URL('./__fixtures__/flow-a.hcl', import.meta.url)), 'utf8');
  const doc = await parseFlowHcl(src.replace('user_accept', 'reviewer_pass')); // avoid the load-time gate for the positive path
  expect(doc.loops[0]?.stages).toContain('planner');
});
```

- [ ] **Step 2: Write `scripts/gen-flow-b.ts`** — writes `emitFlowHcl(planImplementAdversaryStages(), {name:'flow-b', label:'…'})` to `src/flows/flow-b.hcl`. Run it once to generate the file: `pnpm tsx scripts/gen-flow-b.ts` (or `node --import tsx`). Commit the generated `flow-b.hcl`.

- [ ] **Step 3: Write `__fixtures__/flow-a.hcl`** — a hand-authored Flow A sketch (planner⇄user_review loop, then implementer→adversary→repairer) for the positive parse/emit test.

- [ ] **Step 4: Run — all pass.** The codegen-diff test is the CI guard against `flow-b.hcl` drift.

- [ ] **Step 5: Commit** `test(flows): round-trip Flow B + generated flow-b.hcl + Flow-A parse`

---

### Task 7: Register Flow B in `FLOWS`

**Files:**
- Modify: `src/api/capabilities.ts:25`
- Modify/Create: `src/api/capabilities.test.ts`

**Interfaces:**
- Consumes: `planImplementAdversaryStages`.

- [ ] **Step 1: Write failing test** — `capabilities().flows` includes `{ name: 'flow-b', label: /adversary/ }`; `FLOWS['flow-b'].build()` returns 4 stages `['planner','implementer','adversary','repairer']`.

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** — add import + entry:
```ts
import { implementReviewSimplifyStages, planImplementReviewStages, planImplementAdversaryStages, type PipelineStage } from '../pipeline/pipeline.js';
// …
'flow-b': { label: 'Plan → implement → adversary → repair', build: planImplementAdversaryStages },
```

- [ ] **Step 4: Run — verify pass.** Also `pnpm test src/sidecar/sidecar.test.ts` — validator now accepts `flow:'flow-b'` (static key).

- [ ] **Step 5: Commit** `feat(api): register flow-b in the FLOWS registry`

---

### Task 8: Dispatch generalization — RunOptions.flow + `:277` + `run-start.flow` + sidecar

**Files:**
- Modify: `src/runners/source-adapter.ts` (`:39` RunOptions, `:83` pickRunOptions, `:277` dispatch, `:289` event), import `FLOWS` from `../api/capabilities.js`
- Modify: `src/sidecar/deps.ts:73`
- Modify: `src/runners/source-adapter.test.ts` (pickRunOptions field test)

**Interfaces:**
- Consumes: `FLOWS`.
- Produces: `RunOptions.flow?: string` threaded to the dispatch.

- [ ] **Step 1: Write failing test** (`source-adapter.test.ts`) — extend the existing `runSourcedIssue` mocked-context test: pass `deps.flow = 'flow-b'`, spy `onEvent`, assert the `run-start` event has `flow:'flow-b'` and `stages` = `['planner','implementer','adversary','repairer']` (plus any appended review stages). Add a case asserting `deps.plan === true` still yields `flow:'plan'`. Add `flow` to the `pickRunOptions` "copies all defined options" test.

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement:**
  - `RunOptions`: add `/** Named flow key (FLOWS). Set via --flow; --plan is an alias for 'plan'. */ flow?: string;`
  - `pickRunOptions`: add `...(cmd.flow !== undefined ? { flow: cmd.flow } : {})`.
  - `:277` dispatch:
    ```ts
    const flow = deps.flow ?? (deps.plan === true ? 'plan' : undefined);
    if (flow !== undefined && !Object.hasOwn(FLOWS, flow)) throw new Error(`unknown flow "${flow}"`);
    const baseStages = flow !== undefined ? FLOWS[flow]!.build() : adapter.stages();
    ```
  - `:289` event: `flow: flow ?? 'default',`
  - `deps.ts:73`: `...(params.flow !== undefined ? { flow: params.flow } : {}),` (drop the `plan` mapping — the sidecar always passes `flow` through now; `validateCreateRun` already gated it).

- [ ] **Step 4: Run — verify pass** (`pnpm test src/runners/source-adapter.test.ts src/sidecar`).

- [ ] **Step 5: Commit** `feat(runner): name-driven flow dispatch replaces the plan boolean`

---

### Task 9: `--flow` CLI flag + `--plan` alias + conflict + run/watch migration

**Files:**
- Modify: `src/cli/args.ts` (flag decl ~`:375`, run call site `:713`, watch call site `:832`, help text)
- Modify: `src/cli/args.test.ts`

**Interfaces:**
- Consumes: `FLOWS` (for the valid-names error message + validation).

- [ ] **Step 1: Write failing tests** (`args.test.ts`, mirror the existing `:617` `--plan` test):
  - `parseCli(['run','--github','o/r#1','--flow','flow-b'],'/work')` → run command with `flow:'flow-b'`.
  - `--plan` → `flow:'plan'` (or keeps `plan:true` that maps downstream — assert whichever the impl chooses; prefer setting `flow:'plan'` so `:277` reads a single field).
  - `--plan --flow flow-b` together → `{ kind: 'error' }` (or `help` with a message) mentioning conflict.
  - `--flow bogus` → error listing valid names.
  - `watch --plan` and `watch --flow flow-b` carry the flag through (mirror `:620`).

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement:**
  - add `flow: { type: 'string' }` to the `run` and `watch` options objects.
  - after parse: if `values.plan && values.flow` → conflict error; if `values.flow && !Object.hasOwn(FLOWS, values.flow)` → error listing `Object.keys(FLOWS)`; normalize `--plan` to `flow='plan'` when `flow` unset.
  - thread `flow` into both the run (`:713`) and watch (`:832`) command shapes so `pickRunOptions` copies it.
  - add `--flow <name>` to help text next to `--plan`.

- [ ] **Step 4: Run — verify pass** (`pnpm test src/cli/args.test.ts`).

- [ ] **Step 5: Full gate.** Run `pnpm typecheck && pnpm test`. Expected: all green.

- [ ] **Step 6: Commit** `feat(cli): additive --flow flag; --plan aliases to --flow plan`

---

## Self-review checklist (run after implementation, before reviews)

1. **Spec coverage:** AC1→T1/parse; AC2→T2/lower; AC3+AC4-emit→T4/T5; AC5 meta→T1; AC6 dispatch→T6/Task8; AC7 CLI→Task9; AC8 codegen→T8/Task6; AC9 gate→Task9 Step5. ✅ each maps.
2. **`@cdktf/hcl2json` is in `devDependencies`, not `dependencies`.**
3. **`capabilities()` still no-arg; `validateCreateRun` still sync; `FLOWS` still static.** (No S5 scope crept in.)
4. **`.github/workflows/` untouched.**
5. **`--plan` behavior byte-identical** — `FLOWS.plan.build === planImplementReviewStages`.
