# Subsystem 1 — Structured Run Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. React work follows the one-component-per-file rule.

**Goal:** Replace the raw-CLI New Run textarea with structured fields (from `apiCapabilitiesCached()`), launch via `apiCreateRun`, and render a live event strip driven by a last-wins reducer over the `{runId,event}` stream — with re-attach, cancel, and a single-in-flight guard.

**Architecture:** One Inspector-level `typedRun` object (single-in-flight; no runId-keyed rows). A pure `typedRunReducer` folds events last-wins-per-key. Components are one-per-file: `EnumSelect`, `NewRunForm` (rewritten), `RunStrip`. A 3-line Rust guard rejects a second concurrent run.

**Tech Stack:** React 19, TypeScript strict, Vitest + Testing Library, Tauri 2 (`listen`), chunks-ui via `@/ui`, Rust.

## Global Constraints

- One component per file; keep files focused (one-component rule).
- CLI additive-only; `spawnRun`/`command.ts`/Fleet untouched.
- Never modify `.github/workflows/`.
- `pnpm typecheck`, `pnpm test`, desktop `tsc` + tests, `cargo build`/`clippy` green before done.
- Terminal state comes from the **event** (reducer owns it); the `apiCreateRun` promise only clears the launching spinner.
- Reducer is **last-write-wins per key**; drops payloads whose `runId` ≠ the adopted run.

---

## File Structure

- `apps/desktop/src/ui/index.ts` *(modify)* — re-export `Select` from chunks-ui (the seam lacks it).
- `apps/desktop/src/features/inspector/EnumSelect.tsx` *(new)* — thin wrapper over `Select` compound; used for transport/provider/flow.
- `apps/desktop/src/features/inspector/typedRunReducer.ts` *(new)* — pure reducer + `TypedRunState` type.
- `apps/desktop/src/features/inspector/typedRunReducer.test.ts` *(new)*.
- `apps/desktop/src/features/inspector/NewRunForm.tsx` *(rewrite)* — structured fields + validation + read-only preview → `onRun(params)`.
- `apps/desktop/src/features/inspector/NewRunForm.test.tsx` *(new)*.
- `apps/desktop/src/features/inspector/RunStrip.tsx` *(new)* — renders `TypedRunState`.
- `apps/desktop/src/features/inspector/RunStrip.test.tsx` *(new)*.
- `apps/desktop/src/features/inspector/Inspector.tsx` *(modify)* — `typedRun` state, `listen('api:event')`, `startTypedRun`, button guard, filter `active` by taskId, swap `RunStrip` into the content view.
- `apps/desktop/src-tauri/src/sidecar.rs` *(modify)* — busy-guard in `api_create_run`.

---

### Task 1: last-wins reducer (pure, TDD — the core)

**Files:** Create `typedRunReducer.ts` + `.test.ts`.

**Interfaces:**
- Produces: `TypedRunState` = `{ runId?: string; taskId?: string; flow?: string; provider?: string; stages: string[]; stageState: Record<number, 'pending'|'running'|'done'|'failed'>; usdSpent: number; terminal?: { kind: 'success'|'no-changes'|'secret-blocked'|'error'|'cancelled'; prUrl?: string; message?: string } }`; `initialTypedRun(): TypedRunState`; `reduceTypedRun(state, payload: { runId: string; event: RunEvent | { type: 'run-accepted' } }): TypedRunState`.

- [ ] **Step 1: Write the failing test**

Create `typedRunReducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialTypedRun, reduceTypedRun } from './typedRunReducer';

const ev = (runId: string, event: unknown) => ({ runId, event } as Parameters<typeof reduceTypedRun>[1]);

describe('reduceTypedRun', () => {
  it('adopts runId/taskId/stages and steps stage phases last-wins', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'run-accepted' }));
    expect(s.runId).toBe('r1');
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'default', provider: 'claude', stages: ['implementer', 'reviewer'] }));
    expect(s.taskId).toBe('t1');
    expect(s.stages).toEqual(['implementer', 'reviewer']);
    expect(s.stageState).toEqual({}); // nothing started
    s = reduceTypedRun(s, ev('r1', { type: 'stage-start', name: 'implementer', index: 0, of: 2 }));
    expect(s.stageState[0]).toBe('running');
    s = reduceTypedRun(s, ev('r1', { type: 'stage-end', name: 'implementer', index: 0, of: 2, outcome: 'completed' }));
    expect(s.stageState[0]).toBe('done'); // start→end overwrites the same key
  });

  it('cost is last-wins (cumulative), not summed', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.02 }));
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.05 }));
    expect(s.usdSpent).toBe(0.05); // NOT 0.07
  });

  it('is idempotent on replay (backlog + live overlap)', () => {
    let s = initialTypedRun();
    const seq = [
      ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }),
      ev('r1', { type: 'stage-start', name: 'a', index: 0, of: 1 }),
      ev('r1', { type: 'cost', usdSpent: 0.03 }),
    ];
    for (const e of seq) s = reduceTypedRun(s, e);
    let s2 = initialTypedRun();
    for (const e of [...seq, ...seq]) s2 = reduceTypedRun(s2, e); // replay
    expect(s2).toEqual(s);
  });

  it('drops payloads from a different runId', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }));
    s = reduceTypedRun(s, ev('r2', { type: 'cost', usdSpent: 99 })); // foreign
    expect(s.usdSpent).toBe(0);
  });

  it('maps every terminal', () => {
    const t = (event: unknown) => reduceTypedRun(reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' })), ev('r1', event)).terminal;
    expect(t({ type: 'run-end', prUrl: 'x' })).toEqual({ kind: 'success', prUrl: 'x' });
    expect(t({ type: 'run-end', secretBlocked: true })).toEqual({ kind: 'secret-blocked' });
    expect(t({ type: 'run-end' })).toEqual({ kind: 'no-changes' });
    expect(t({ type: 'run-error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(t({ type: 'run-cancelled' })).toEqual({ kind: 'cancelled' });
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/typedRunReducer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the reducer**

Create `typedRunReducer.ts`:

```ts
import type { RunEvent } from '../../../../src/pipeline/events';

type StagePhase = 'pending' | 'running' | 'done' | 'failed';

export interface TypedRunState {
  runId?: string;
  taskId?: string;
  flow?: string;
  provider?: string;
  stages: string[];
  stageState: Record<number, StagePhase>;
  usdSpent: number;
  terminal?: { kind: 'success' | 'no-changes' | 'secret-blocked' | 'error' | 'cancelled'; prUrl?: string; message?: string };
}

/** `run-accepted` is Rust-emitted and not in RunEvent; accept it as an extra variant here. */
type Incoming = RunEvent | { type: 'run-accepted' };

export function initialTypedRun(): TypedRunState {
  return { stages: [], stageState: {}, usdSpent: 0 };
}

/** Fold one `{runId, event}` payload, last-write-wins per key. Foreign runIds are dropped. */
export function reduceTypedRun(state: TypedRunState, payload: { runId: string; event: Incoming }): TypedRunState {
  // Adopt the first runId; thereafter drop anything that isn't ours.
  if (state.runId !== undefined && payload.runId !== state.runId) return state;
  const runId = state.runId ?? payload.runId;
  const e = payload.event;
  switch (e.type) {
    case 'run-accepted':
      return { ...state, runId };
    case 'run-start':
      return { ...state, runId, taskId: e.taskId, flow: e.flow, provider: e.provider, stages: e.stages };
    case 'stage-start':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: 'running' } };
    case 'stage-end':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: e.outcome === 'completed' ? 'done' : 'failed' } };
    case 'cost':
      return { ...state, runId, usdSpent: e.usdSpent }; // cumulative — last wins, never sum
    case 'run-end':
      return { ...state, runId, terminal: e.prUrl !== undefined ? { kind: 'success', prUrl: e.prUrl } : e.secretBlocked === true ? { kind: 'secret-blocked' } : { kind: 'no-changes' } };
    case 'run-error':
      return { ...state, runId, terminal: { kind: 'error', message: e.message } };
    case 'run-cancelled':
      return { ...state, runId, terminal: { kind: 'cancelled' } };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/typedRunReducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/inspector/typedRunReducer.ts apps/desktop/src/features/inspector/typedRunReducer.test.ts
git commit -m "feat(desktop): last-wins typed-run reducer over the event stream"
```

---

### Task 2: `Select` seam + `EnumSelect` wrapper

**Files:** Modify `ui/index.ts`; create `EnumSelect.tsx`.

**Interfaces:**
- Produces: `EnumSelect({ value, onValueChange, options, placeholder }): JSX` where `options: { value: string; label: string }[]`.

- [ ] **Step 1: Add `Select` to the seam**

`apps/desktop/src/ui/index.ts`, add `Select,` to the `from 'chunks-ui'` re-export block (alongside `Combobox`).

- [ ] **Step 2: Implement `EnumSelect`**

Create `EnumSelect.tsx` (base-ui Select compound; single reusable wrapper so `NewRunForm` stays clean):

```tsx
import { Select } from '@/ui';
import { ChevronsUpDown } from 'lucide-react';

export function EnumSelect({
  value,
  onValueChange,
  options,
  placeholder,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="flex min-w-40 items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs">
        <Select.Value placeholder={placeholder ?? 'Select…'} />
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup className="rounded border border-border bg-popover p-1 text-xs shadow-md">
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="cursor-pointer rounded px-2 py-1 hover:bg-muted data-[selected]:bg-muted">
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm tsc --noEmit`
Expected: clean. (If base-ui Select prop names differ — e.g. `Positioner`/`Popup` — adjust to the actual `Select.*` compound from `node_modules/chunks-ui/dist/index.d.ts`; the parts list is Root/Trigger/Value/Icon/Portal/Positioner/Popup/Item/ItemText/ItemIndicator.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/ui/index.ts apps/desktop/src/features/inspector/EnumSelect.tsx
git commit -m "feat(desktop): Select seam + EnumSelect wrapper for enum fields"
```

---

### Task 3: rewrite `NewRunForm` — structured fields + validation

**Files:** Rewrite `NewRunForm.tsx`; create `NewRunForm.test.tsx`.

**Interfaces:**
- Consumes: `Capabilities` (ipc), `EnumSelect` (Task 2).
- Produces: `NewRunForm({ capabilities, project, onRun, onCancel })` where `onRun(params: { issueRef; repoPath; transport?; provider?; flow?; maxTurns?; baseBranch? })`. Note the prop shape CHANGES from `(defaultCommand, presets, onRun(command))` — update the Inspector call site in Task 5.

- [ ] **Step 1: Write the failing test**

Create `NewRunForm.test.tsx`:

```tsx
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewRunForm } from './NewRunForm';
import type { Capabilities } from '../../ipc';

const caps: Capabilities = {
  providers: ['claude', 'codex'],
  flows: [{ name: 'default', label: 'Default' }, { name: 'plan', label: 'Plan' }],
  transports: ['github', 'gitlab', 'linear'],
  defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
};

test('Run is disabled until issueRef non-blank and advanced fields valid', () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  const run = screen.getByRole('button', { name: /run/i });
  expect(run).toBeDisabled(); // blank issueRef
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  expect(run).not.toBeDisabled();
});

test('Run calls onRun with repoPath=project and the collected fields', () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  fireEvent.click(screen.getByRole('button', { name: /run/i }));
  expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ issueRef: '322', repoPath: '/repo', provider: 'claude', transport: 'github', flow: 'default' }));
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/NewRunForm.test.tsx`
Expected: FAIL (old signature / no structured fields).

- [ ] **Step 3: Rewrite `NewRunForm`**

Replace the file. Fields default from `capabilities.defaults`; `transport`/`flow`/`provider` default to first option / default; validation mirrors `validateCreateRun` (issueRef non-blank; maxTurns positive integer; baseBranch non-blank). Read-only preview via a `Collapsible`. Full component:

```tsx
import { useState } from 'react';
import { Button, Chip, Collapsible, EnumSelect, Input } from '@/ui';
import { Play } from 'lucide-react';
import { EnumSelect as _EnumSelect } from './EnumSelect';
import type { Capabilities, CreateRunParams } from '../../ipc';

// (import EnumSelect from './EnumSelect' — shown separately; do not import from '@/ui'.)

export function NewRunForm({
  capabilities,
  project,
  onRun,
  onCancel,
}: {
  capabilities: Capabilities;
  project: string;
  onRun: (params: CreateRunParams) => void;
  onCancel: () => void;
}) {
  const [issueRef, setIssueRef] = useState('');
  const [transport, setTransport] = useState(capabilities.transports[0] ?? 'github');
  const [provider, setProvider] = useState(capabilities.defaults.provider);
  const [flow, setFlow] = useState(capabilities.flows[0]?.name ?? 'default');
  const [maxTurns, setMaxTurns] = useState(String(capabilities.defaults.maxTurns));
  const [baseBranch, setBaseBranch] = useState(capabilities.defaults.baseBranch);

  const maxTurnsNum = Number(maxTurns);
  const valid =
    issueRef.trim() !== '' &&
    Number.isInteger(maxTurnsNum) && maxTurnsNum > 0 &&
    baseBranch.trim() !== '';

  const params: CreateRunParams = { issueRef: issueRef.trim(), repoPath: project, transport, provider, flow, maxTurns: maxTurnsNum, baseBranch: baseBranch.trim() };
  const preview = `vanguard run --${transport} ${issueRef || '<issue>'} --provider ${provider}${flow === 'plan' ? ' --plan' : ''} --max-turns ${maxTurns}`;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={issueRef} onChange={(e) => setIssueRef(e.target.value)} placeholder="issue ref (e.g. 322)" className="w-40" />
        <_EnumSelect value={transport} onValueChange={setTransport} options={capabilities.transports.map((t) => ({ value: t, label: t }))} />
        <_EnumSelect value={provider} onValueChange={setProvider} options={capabilities.providers.map((p) => ({ value: p, label: p }))} />
        <_EnumSelect value={flow} onValueChange={setFlow} options={capabilities.flows.map((f) => ({ value: f.name, label: f.label }))} />
      </div>

      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs text-muted-foreground hover:text-foreground">Advanced</Collapsible.Trigger>
        <Collapsible.Panel className="flex flex-wrap items-center gap-2 pt-2">
          <label className="text-xs text-muted-foreground">max-turns
            <Input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} className="ml-1 w-16" />
          </label>
          <label className="text-xs text-muted-foreground">base
            <Input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="ml-1 w-28" />
          </label>
        </Collapsible.Panel>
      </Collapsible.Root>

      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs text-muted-foreground hover:text-foreground">≈ command</Collapsible.Trigger>
        <Collapsible.Panel className="pt-1">
          <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground" title={preview}>{preview}</code>
          <span className="text-[10px] text-muted-foreground">approximate — the run uses the structured fields, not this string</span>
        </Collapsible.Panel>
      </Collapsible.Root>

      <div className="flex items-center justify-end gap-2">
        <Button variant="text" color="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={!valid} onClick={() => valid && onRun(params)} startIcon={<Play className="size-4" />}>Run</Button>
      </div>
    </div>
  );
}
```

> Remove the bogus `EnumSelect` import from `@/ui` in the snippet — import only from `./EnumSelect`. Confirm `Chip`/`Input`/`Collapsible` are exported from `@/ui` (they are). `Collapsible` parts: `Root`/`Trigger`/`Panel`.

- [ ] **Step 4: Run — verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/NewRunForm.test.tsx && pnpm tsc --noEmit`
Expected: PASS, typecheck clean. (Base-ui Select may need an `aria-label`/role tweak for the test queries; if the enum-field asserts are brittle, query by displayed value text.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/inspector/NewRunForm.tsx apps/desktop/src/features/inspector/NewRunForm.test.tsx
git commit -m "feat(desktop): structured NewRunForm — fields, validation, read-only preview"
```

---

### Task 4: `RunStrip` — render the reducer state

**Files:** Create `RunStrip.tsx` + `.test.tsx`.

**Interfaces:**
- Consumes: `TypedRunState` (Task 1).
- Produces: `RunStrip({ state, onCancel }): JSX`.

- [ ] **Step 1: Write the failing test**

Create `RunStrip.test.tsx`:

```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStrip } from './RunStrip';
import { initialTypedRun, reduceTypedRun, type TypedRunState } from './typedRunReducer';

function build(events: unknown[]): TypedRunState {
  return events.reduce((s: TypedRunState, e) => reduceTypedRun(s, e as never), initialTypedRun());
}

test('shows a spinner for a started-but-not-ended stage, check when done', () => {
  const running = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['implementer', 'reviewer'] } },
    { runId: 'r1', event: { type: 'stage-start', name: 'implementer', index: 0, of: 2 } },
  ]);
  render(<RunStrip state={running} onCancel={() => {}} />);
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'running');
  expect(screen.getByTestId('stage-1')).toHaveAttribute('data-phase', 'pending');
});

test('renders terminal: PR link on success', () => {
  const done = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] } },
    { runId: 'r1', event: { type: 'run-end', prUrl: 'https://x/pr/1' } },
  ]);
  render(<RunStrip state={done} onCancel={() => {}} />);
  expect(screen.getByRole('link', { name: /pr/i })).toHaveAttribute('href', 'https://x/pr/1');
});
```

- [ ] **Step 2: Run — verify it fails.** `cd apps/desktop && pnpm vitest run src/features/inspector/RunStrip.test.tsx` → FAIL.

- [ ] **Step 3: Implement `RunStrip`**

```tsx
import { Button, Chip } from '@/ui';
import { RefreshCw, Square } from 'lucide-react';
import type { TypedRunState } from './typedRunReducer';

export function RunStrip({ state, onCancel }: { state: TypedRunState; onCancel: () => void }) {
  const { stages, stageState, usdSpent, terminal } = state;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{state.taskId ?? 'starting…'}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">~${usdSpent.toFixed(2)}</span>
        {terminal === undefined && (
          <Button variant="text" color="destructive" onClick={onCancel} startIcon={<Square className="size-3.5" />}>Kill</Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {stages.map((name, i) => {
          const phase = stageState[i] ?? 'pending';
          return (
            <span key={i} data-testid={`stage-${i}`} data-phase={phase}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                phase === 'done' ? 'border-emerald-600 text-emerald-500'
                : phase === 'failed' ? 'border-rose-600 text-rose-500'
                : phase === 'running' ? 'border-blue-600 text-blue-500'
                : 'border-border text-muted-foreground opacity-60'}`}>
              {phase === 'running' && <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />}
              {name}
            </span>
          );
        })}
      </div>
      {terminal !== undefined && (
        <div className="text-xs">
          {terminal.kind === 'success' && terminal.prUrl !== undefined && <a href={terminal.prUrl} className="text-blue-500 underline">View PR</a>}
          {terminal.kind === 'no-changes' && <Chip color="secondary" variant="outlined">no PR (no changes)</Chip>}
          {terminal.kind === 'secret-blocked' && <Chip color="destructive" variant="outlined">secret-blocked</Chip>}
          {terminal.kind === 'error' && <Chip color="destructive" variant="outlined">error: {terminal.message}</Chip>}
          {terminal.kind === 'cancelled' && <Chip color="secondary" variant="outlined">cancelled</Chip>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — verify it passes.** `cd apps/desktop && pnpm vitest run src/features/inspector/RunStrip.test.tsx && pnpm tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/inspector/RunStrip.tsx apps/desktop/src/features/inspector/RunStrip.test.tsx
git commit -m "feat(desktop): RunStrip renders typed-run state (stages, cost, terminal)"
```

---

### Task 5: Inspector wiring — typedRun, listen, guard, taskId filter

**Files:** Modify `Inspector.tsx`.

No new unit test (integration; covered by manual smoke + the unit tests of its parts). Steps:

- [ ] **Step 1: State + capabilities load.** Add `const [caps, setCaps] = useState<Capabilities | null>(null);` and load once: `useEffect(() => { void apiCapabilitiesCached().then(setCaps); }, []);`. Add `const [typedRun, setTypedRun] = useState<TypedRunState | null>(null);` and `const [busy, setBusy] = useState<boolean | null>(null);` (null = unknown until checked). On mount: `useEffect(() => { void apiActiveRun().then((id) => setBusy(id !== null)); }, []);`.

- [ ] **Step 2: `listen('api:event')`.** In a `useEffect`, subscribe and fold into `typedRun` via the reducer, ignoring foreign runIds (the reducer already drops them):

```ts
useEffect(() => {
  const un = listen<{ runId: string; event: RunEvent }>('api:event', (e) => {
    setTypedRun((prev) => reduceTypedRun(prev ?? initialTypedRun(), e.payload));
  });
  return () => { void un.then((f) => f()); };
}, []);
```

- [ ] **Step 3: `startTypedRun`.** Replaces the CLI path for the structured form:

```ts
const startTypedRun = (params: CreateRunParams): void => {
  setShowNewRun(false);
  setTypedRun(initialTypedRun()); // synchronous in-flight marker (status "starting")
  setBusy(true);
  setDetail(null); setLiveRun(null); setFocusedSpawn(null);
  void apiCreateRun(params)
    .catch((err) => setError(String(err)))
    .finally(() => setBusy(false)); // promise only clears the spinner; terminal comes from events
};
```

- [ ] **Step 4: Re-attach on mount.** If `apiActiveRun()` returns an id, replay backlog:

```ts
useEffect(() => {
  void apiActiveRun().then(async (id) => {
    if (id === null) return;
    const backlog = await apiRunBacklog(id);
    let s = initialTypedRun();
    for (const p of backlog) s = reduceTypedRun(s, p as { runId: string; event: RunEvent });
    setTypedRun(s);
  });
}, []);
```

(Subscribe in Step 2 runs first in effect order — keep this effect after it so the live tail isn't missed; the reducer dedups the overlap.)

- [ ] **Step 5: Content-view swap + taskId filter.** In the render chain, add a `typedRun` branch to the content view (before the `screen === 'runs'` RunList branch): when `typedRun !== null && typedRun.terminal === undefined` (or recently terminal), render `<RunStrip state={typedRun} onCancel={() => void apiCancel()} />` with a "Back to runs" affordance (clear on `typedRun.terminal` + user action). Filter the live run out of the table: `const activeShown = typedRun?.taskId !== undefined ? active.filter((a) => a.taskId !== typedRun.taskId) : active;` and pass `activeShown` to `RunList`.

- [ ] **Step 6: New Run form + button guard.** Render `showNewRun && caps !== null` → `<NewRunForm capabilities={caps} project={project} onRun={startTypedRun} onCancel={() => setShowNewRun(false)} />`. Disable the "New run" toolbar button when `busy === true || busy === null || typedRun?.terminal === undefined && typedRun !== null` (i.e. a typed run is live or the idle-check hasn't resolved). Update imports (`apiCapabilitiesCached, apiActiveRun, apiRunBacklog, apiCancel, apiCreateRun`, `Capabilities`, `CreateRunParams`, `reduceTypedRun`, `initialTypedRun`, `TypedRunState`, `RunStrip`, `NewRunForm`, `RunEvent`).

- [ ] **Step 7: Verify.** `cd apps/desktop && pnpm tsc --noEmit && pnpm vitest run` → all green (65 existing + the new component tests).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/features/inspector/Inspector.tsx
git commit -m "feat(desktop): wire typed run builder into Inspector (listen, guard, taskId filter)"
```

---

### Task 6: Rust busy-guard in `api_create_run`

**Files:** Modify `apps/desktop/src-tauri/src/sidecar.rs`.

- [ ] **Step 1: Guard.** At the top of `api_create_run`, before minting the runId, reject if a run is already active:

```rust
{
    let active = state.active.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("a run is already in flight (single-in-flight)".to_string());
    }
}
```

(This enforces single-in-flight server-side even if the UI guard races — the second call returns an error instead of overwriting `active`.)

- [ ] **Step 2: Build + clippy.** `cd apps/desktop/src-tauri && cargo build && cargo clippy` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/sidecar.rs
git commit -m "feat(desktop): reject a second concurrent typed run server-side (busy guard)"
```

---

## Self-Review

- **Spec coverage:** structured fields + validation (T3, AC1); repoPath=project payload (T3, AC2); stepped strip spinner→check (T1+T4, AC3); terminal matrix event-sourced (T1+T4, AC4); collapsed lifecycle + taskId filter + button guard (T5, AC5); Rust busy-guard (T6, AC6); read-only preview only (T3, AC7); gates (every task, AC8). ✓
- **Reducer is last-wins** (cost singleton, stage-by-index, foreign-runId drop) — T1 tests all three. ✓
- **Terminal from event, promise only clears spinner** — T5 step 3. ✓
- **One component per file:** EnumSelect, NewRunForm, RunStrip each own a file; reducer is pure logic in its own file. ✓
- **Placeholder scan:** the base-ui `Select`/`Collapsible` exact part names are the one soft spot — the plan says to reconcile against `chunks-ui/dist/index.d.ts` if a part name differs; every other step is concrete.

## Manual verification (Task 7, needs Docker + creds + running app)

Launch app from a terminal (PATH), `vanguard` linked (`pnpm build && pnpm link --global`). New Run → structured fields → Run: strip swaps in, stages tick, cost updates, PR link on success. Kill → `run-cancelled`. Navigate away + back → strip re-attaches (backlog). Open New Run during a run → button disabled. Second `apiCreateRun` (devtools) → busy error. Report unverified if Docker/creds absent.
