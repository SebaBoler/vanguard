# Subsystem 2 — Named Workflows (HCL)

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — revised per two spec reviews (feasibility + design-gap)
**Date:** 2026-07-12
**Depends on:** Subsystem 0 (shipped). **Defines the format Subsystem 5 consumes.**

---

## Why

Flows are TS-authored `PipelineStage[]` arrays today (`src/pipeline/pipeline.ts`). To make
workflows **app-authored and visually editable** (Subsystem 5) they need a declarative,
round-trippable text format. Vision §2 locks **two-layer HCL** (Terraform's model):

- **Layer 1 — composition only.** A flow = an ordered list of *stage-name references* +
  per-stage routing/budget overrides.
- **Layer 2 — the escape hatch.** `stage "x" { ref = "scripts/x.ts#myStage" }` references a
  TS export by name. TS never becomes debt; it stays the long-tail escape hatch forever.

The named-flow *selection* seam exists but is a stub: `FLOWS` (`src/api/capabilities.ts:25`)
is a name→builder registry, but the sidecar collapses it to a single `plan` boolean
(`src/sidecar/deps.ts:73`) and the CLI branches on that boolean
(`src/runners/source-adapter.ts:277`) — both carry an explicit `// Subsystem 2 replaces this`
comment. This subsystem (a) defines the HCL format as a **tested core library** and (b)
replaces the `plan`-boolean hack with real name-driven flow dispatch, shipping **Flow B**
(`planner → implementer → adversary → repairer`) as the first named flow.

---

## Constraints (read first — everything below obeys these)

1. **CLI is a frozen public contract.** SebaBoler builds latest vanguard in GitHub Actions.
   Every change is **additive**: `--flow <name>` is new; `--plan` keeps working unchanged
   (it becomes an alias for `--flow plan` — verified behavior-preserving: `FLOWS.plan.build`
   *is* `planImplementReviewStages`, the same function `source-adapter.ts:277` selects today).
   No existing flag's meaning moves.

2. **A flow only ever needs to produce `PipelineStage[]`** — the entire contract the runner
   consumes (`runBudgetedStages(ctx, stages, opts)`, `pipeline.ts:222`). Downstream of
   `assembleReviewPipeline` nothing changes.

3. **Flow selection threads as a NAME STRING, never a closure.** (Feasibility F2/F3.) The
   CLI parser (`args.ts`) is synchronous; a `run-start.flow` event needs the key; and repo
   HCL loading is async. A closure carries no name and can't be built in the sync parser. So
   `flow: string` travels through `RunOptions` → `runSourcedIssue`, which resolves
   name → `FLOWS[flow].build()` at its own (already-async) boundary.

4. **The sidecar cannot pause a run for human input** (S0.5: one process, one pipe, inline
   `await`; mid-run control is out-of-band only). Interactive human-gate loops are out of
   scope (Non-goals).

5. **No live repo-flow discovery in S2.** (Feasibility F5/F6.) Surfacing `.vanguard/flows/*.hcl`
   through the sidecar would force `SidecarDeps.capabilities: () => Capabilities` and the
   `capabilities` protocol method to carry `repoPath`, and turn the synchronous
   `validateCreateRun` async — protocol-boundary surgery whose only consumer is S5's editor.
   **Deferred to S5.** S2 keeps `FLOWS` static, `capabilities()` pure/no-arg, and
   `validateCreateRun` synchronous. Flow B ships as a **static TS-backed `FLOWS` entry**; the
   HCL library is proven by round-trip test, not wired into the live registry yet.

6. **Desktop stays thin.** HCL parse/emit lives in **core only**; the desktop-facing API is
   added by S5 when its editor needs it.

---

## Scope

### In

1. **HCL flow format v1** — documented grammar (below), parsed by `@cdktf/hcl2json` into a
   typed `FlowDoc`, lowered to `PipelineStage[]`.
2. **Stage library** — `STAGE_LIBRARY: Record<string, () => PipelineStage>`, so a bare
   `stage "planner" {}` resolves to a real record. **Source of truth per entry is named
   explicitly** (Feasibility F8 / design-gap #2): S2's library is extracted from
   **`planImplementAdversaryStages()` only** (`pipeline.ts:839`) — its four records
   (`planner, implementer, adversary, repairer`) have inline per-stage `systemPrompt` and no
   `.map`, so they extract cleanly by name and carry no cross-builder collision. Stages from
   other builders (whose `implementer`/`reviewer` prompts differ) are **not** swept in; a name
   enters the library only when a shipped HCL flow needs it, with its source builder named.
3. **`ref =` resolver** — `"relpath#export"` → dynamic-import → `PipelineStage`. Path must
   resolve **inside `<repoPath>/.vanguard/`** (no `../` escape → load error). Proves Layer 2.
4. **Canonical HCL emitter — total-or-throw.** (Design-gap #1.) `emitFlowHcl(stages, {label})`
   emits stage name + only the fields in the override table; **identity fields**
   (`promptTemplate`, `systemPrompt`) are supplied by the library on parse, not emitted. Any
   stage field that is neither library-identity nor in the override table causes emit to
   **throw** (`cannot emit field "stageCostFraction"…`) — never a silent drop that changes
   runtime cost behavior. Round-trip (`parse∘emit∘lower`) is the correctness contract.
5. **Flow B** registered in `FLOWS` as `{ label, build: planImplementAdversaryStages }` and
   made **runnable** via `--flow flow-b` / `flow: 'flow-b'` / UI. A checked-in `flow-b.hcl`
   is **generated from the builder via the emitter** (codegen, diffed in CI — Design-gap #7)
   as the format fixture and S5's seed; it is not the runtime source in S2.
6. **Dispatch generalization** — replace the `plan` boolean fork on both the sidecar
   (`deps.ts:73`) and CLI (`source-adapter.ts:277`) paths, **and the `watch` path**
   (`args.ts:832` — Feasibility F4) with `FLOWS[flow].build()` selection. `run-start.flow`
   carries the real key (`source-adapter.ts:289`).
7. **`--flow <name>` CLI flag** (additive). `flow?: string` added to `RunOptions`
   (`source-adapter.ts:39`) and copied in `pickRunOptions` (`:83`) — Feasibility F1. `--plan`
   sets `flow='plan'`; `--plan --flow x` together → explicit parse error (needs its own branch;
   `args.ts` funnels parse failures to `{kind:'help'}`). Unknown `--flow` → error listing
   valid names.

### Non-goals (deferred, with reason)

- **Live `.vanguard/flows/*.hcl` discovery / merge into the run registry** → **S5**
  (Constraint 5). The parser/lowering that S5 will call at runtime ship here, fully tested;
  only the async sidecar-protocol wiring is deferred.
- **Interactive human-gate loop (Flow A `until = "user_accept"`)** → needs sidecar
  pause/resume (Constraint 4). Grammar parses/emits a `loop {}` block (format completeness for
  S5), but `until = "user_accept"` is a **load error** ("interactive gate not yet supported").
  Flow A is not runnable in S2.
- **Loop execution generally** — no S2 flow loops; `loop {}` round-trips but throws at run.
  Its one-line shape (`stages`/`until`/`max`) is **provisional pending S5** (Design-gap #8).
- **Desktop HCL editor + sidecar `apiParseFlow`/`apiEmitFlow`** → S5.
- **Canvas layout persistence** — position is **UI state, not flow semantics**; it does NOT
  enter the composition-only HCL (Design-gap #4). S5 derives layout by deterministic
  auto-layout from source order + loop membership. Stated here so S5 doesn't pollute the HCL.
- **Custom providers** → S6.

---

## The HCL flow format v1

One `flow` block per file. Stages are **label-less `stage` blocks with a `name` attribute**,
ordered by source order.

```hcl
# flow-b.hcl  (generated from planImplementAdversaryStages via the emitter)
flow "flow-b" {
  label = "Plan → implement → adversary → repair"

  stage {
    name            = "planner"
    model           = "opus"
    effort          = "high"
    max_turns       = 10
    resume_previous = false
  }
  stage {
    name            = "implementer"
    model           = "sonnet"
    max_turns       = 30
    resume_previous = false
  }
  # … adversary, repairer …
}
```

**Why label-less blocks (verified against the parser):** `@cdktf/hcl2json` returns *labeled*
same-type blocks as a **name-keyed object whose key order is not source order** (it came back
alphabetical — Feasibility F9 made real), and it rejects multiple attributes on a one-line
labeled block. Label-less repeated `stage` blocks instead deserialize to an **ordered array**
(`stage: [{name,…}, …]`), so source order is preserved structurally. Scalars arrive unwrapped
(`max_turns: 10`, not `[10]`); only repeated blocks (`stage`, `loop`, `meta`) are arrays.

**`flow` block.** `label` required. The block label (`"flow-b"`) is the registry key; unique,
must not collide with a built-in.

**`stage` block.** `name` attribute = stage name. Either a **library stage** (name resolves in
`STAGE_LIBRARY`; body is overrides only) or a **`ref` stage**
(`stage { name = "x"  ref = "…#export" }`). Neither match → load error.

**Override keys → `PipelineStage` fields** (snake_case in HCL ↔ camelCase in TS):

| HCL key           | field            | notes                                |
|-------------------|------------------|--------------------------------------|
| `model`           | `model`          | string                               |
| `effort`          | `effort`         | `low\|medium\|high`                  |
| `max_turns`       | `maxTurns`       | positive int                         |
| `provider`        | `provider`       | validated against `PROVIDER_NAMES`   |
| `resume_previous` | `resumePrevious` | bool                                 |
| `ref`             | (resolves record)| `"relpath#export"`, under `.vanguard/` |

Identity fields (`promptTemplate`, `systemPrompt`) are library-owned — never in HCL. Fields
outside this table + identity (`stageCostFraction`, `timeoutMs`, `onStageBudgetExceeded`,
`fallback`, `copyBack`, `resumeUntilComplete`, …) have no v1 HCL representation: a flow needing
them uses a `ref` stage, and the emitter **throws** rather than drop them (Scope §4). Adding
scalar keys later is additive. Unknown keys at `flow`/`stage`/`loop` level → load error
(typo protection).

**`meta {}` — forward-compat escape valve** (Design-gap #3). An optional freeform block on
`flow` and `stage`, parsed structurally, **never validated or interpreted**, round-tripped
verbatim, ignored by `lowerFlow`. Gives S5 (and hand-authors) a place for pass-through state
without a breaking parser change, while typo-protection on *known* keys stays intact.

**`loop {}` — parse/emit only in S2** (provisional):
```hcl
loop { stages = ["planner", "user_review"]  until = "user_accept"  max = 3 }
```
Parsed into a **separate `FlowDoc.loops` field** — not interleaved with stages, because
`@cdktf/hcl2json` emits label-keyed objects and cross-block-type source order is not reliable
(Feasibility F9). Emitted after the stage list. Execution deferred (Non-goals).

### Lowering (`FlowDoc → PipelineStage[]`)

1. Per stage: resolve base record (library or `ref`), apply overrides via the same
   last-writer-wins spread `resolveRouting` (`pipeline.ts:635`) uses.
2. Preserve stage source order.
3. Result is a plain `PipelineStage[]`, shape-identical to a TS builder's output —
   `assembleReviewPipeline` and the runner are untouched.

---

## Design decisions

**D1 — Parser: `@cdktf/hcl2json@0.21.0`, as a devDependency.** HashiCorp's HCL parser compiled
to WASM; `parse(filename, contents): Promise<Record<string,any>>`, parse-only (we write the
emitter). Loads WASM from the **local filesystem** (`__dirname/main.wasm.gz`), no network — so
no sidecar/CI egress. It is **CommonJS consumed from ESM** (works via cjs-module-lexer; a smoke
test guards it). Because S2 exercises it only in tests + the `flow-b.hcl` codegen (Constraint
5), it is a **devDependency** — the shipped CLI runtime never loads the WASM, so the
"SebaBoler bundles vanguard" packaging risk (Feasibility F7) does not arise in S2. When S5 puts
parse/emit on the runtime sidecar path it graduates to a runtime dep and must externalize the
WASM asset — noted for S5, not solved here. Hand-rolled subset parser rejected: HCL quoting/
heredoc/comments rot a hand parser, and this is a trust boundary.

**D2 — `ref =` trust boundary.** Dynamic-imports TS from the operated repo's `.vanguard/` —
same trust level as `.vanguard/app.json`'s already-executed `runCommand`. Guard: resolved path
must stay inside `<repoPath>/.vanguard/`; escape → load error.

**D3 — Emitter is hand-written, canonical, total-or-throw.** Deterministic key order, 2-space
indent, snake_case. Round-trip is the contract; never silent-drop (Scope §4).

**D4 — Built-ins stay TS.** `default`/`plan`/`flow-b` are TS builders registered in the static
`FLOWS`. No behavior change, no async init. HCL is the *format*, proven by test; TS is the
*runtime source* in S2.

---

## Seams (file:line, verbatim)

- **`FLOWS`** `src/api/capabilities.ts:25` — add `'flow-b': { label, build: planImplementAdversaryStages }`.
  `capabilities()` (`:31`) surfaces it as `FlowInfo[]` automatically. **Stays no-arg/pure.**
- **`RunOptions`** `src/runners/source-adapter.ts:39` — add `flow?: string`.
- **`pickRunOptions`** `src/runners/source-adapter.ts:83` — copy `flow` (and update its test,
  `source-adapter.test.ts:21`, which enumerates copied fields).
- **CLI dispatch** `src/runners/source-adapter.ts:277` —
  `const baseStages = deps.plan === true ? planImplementReviewStages() : adapter.stages();`
  → `const flow = deps.flow ?? (deps.plan === true ? 'plan' : undefined);
     const baseStages = flow !== undefined ? FLOWS[flow].build() : adapter.stages();`
  (`FLOWS.default.build === adapter.stages` today, so behavior is preserved).
- **`run-start.flow`** `src/runners/source-adapter.ts:289` — emit `flow ?? 'default'`.
- **Sidecar dispatch** `src/sidecar/deps.ts:73` — replace `...(params.flow === 'plan' ? {plan:true})`
  with `...(params.flow !== undefined ? { flow: params.flow } : {})`.
- **CLI flag** `src/cli/args.ts` (`plan: { type: 'boolean' }` ~`:375`) — add `flow: {type:'string'}`;
  map `--plan`→`flow='plan'`; `--plan --flow x` → error branch; migrate **both** run (`:713`)
  and watch (`:832`) call sites (Feasibility F4).
- **Sidecar validation** `src/sidecar/sidecar.ts:62` — unchanged (static `FLOWS`, sync). `flow-b`
  is a static key, so `Object.hasOwn(FLOWS, 'flow-b')` passes with no async refactor.
- **Library source** `pipeline.ts:839` (`planImplementAdversaryStages`).

---

## Acceptance criteria

- **AC1** `parseFlowHcl(src)` → typed `FlowDoc` for valid input; syntax error, unknown override
  key, stage with neither library match nor `ref`, `until="user_accept"`, or `ref` escaping
  `.vanguard/` each throw a clear message.
- **AC2** `lowerFlow(doc, {repoPath})` → `PipelineStage[]` in source order, overrides applied,
  `ref` stages dynamic-imported; shape-identical to a TS builder array.
- **AC3** `emitFlowHcl(stages,{label})` → canonical HCL; **throws** on a stage carrying a
  non-representable field (e.g. `stageCostFraction`).
- **AC4** `parse∘emit∘lower(planImplementAdversaryStages())` deep-equals the source on
  `{name, model, effort, maxTurns, resumePrevious, promptTemplate, systemPrompt}` (identity via
  library both times). A hand-written `flow-a.hcl` (loop + stages) **parses and re-emits**
  equal (positive Flow-A path — Design-gap #5), though it does not run.
- **AC5** `meta {}` on a flow/stage is captured by `parseFlowHcl` and does not affect `lowerFlow`
  output (it is the forward-compat escape valve). Emitting `meta` verbatim is deferred to S5, whose
  editor round-trips at the `FlowDoc` layer — the S2 emitter operates on lowered `PipelineStage[]`,
  which by design no longer carries `meta`.
- **AC6** `--flow flow-b` (CLI) and `flow:'flow-b'` (sidecar) run planner→implementer→adversary→
  repairer; `run-start.flow==='flow-b'`. Asserted at the `runSourcedIssue` layer with an
  `onEvent` spy over mocked context (`source-adapter.test.ts:85` pattern), no live LLM.
- **AC7** `--plan` runs the plan pipeline unchanged; `watch --plan` too; `--plan --flow x`
  errors; unknown `--flow` errors listing valid names.
- **AC8** checked-in `flow-b.hcl` equals the emitter's output for `planImplementAdversaryStages()`
  (CI codegen diff — Design-gap #7).
- **AC9** `pnpm typecheck` + `pnpm test` green; `@cdktf/hcl2json` in **devDependencies**; no
  `.github/workflows/` change.

---

## Test plan (co-located `*.test.ts`, Vitest)

- **T1 parser** — valid flow → FlowDoc; each AC1 error case (table-driven); `meta{}` captured.
- **T2 lowering** — overrides applied; order preserved; `ref` resolves a fixture
  `.vanguard/flows/custom.ts#myStage`; `ref` escape rejected.
- **T3 library** — every `STAGE_LIBRARY` entry resolves to a record with non-empty
  `promptTemplate`, and its text **equals the source builder's** stage (drift guard, F8/#2).
- **T4 emitter** — canonical output; **throws** on non-representable field (AC3).
- **T5 round-trip** — Flow B `parse∘emit∘lower` deep-equal (AC4); `flow-a.hcl` parse+emit equal.
- **T6 dispatch** — `runSourcedIssue` selects the 4-stage array for `flow:'flow-b'`, asserts
  `run-start.flow`; `--plan` and `watch --plan` unchanged; conflict + unknown-flow errors.
- **T7 deferrals** — `until="user_accept"` load error; `loop{}` run error.
- **T8 codegen** — `flow-b.hcl` on disk equals `emitFlowHcl(planImplementAdversaryStages(),…)`.

---

## Open questions resolved by review (recorded)

- Repo-flow discovery, `capabilities(repoPath)`, async validation → **deferred to S5** (F5/F6).
- `loop{}` → **kept, parse/emit only, marked provisional** (Design-gap #8).
- `ref =` → **kept in S2** (validates Layer 2 cheaply; #9).
- Flow B fixture → **generated from the builder, diffed in CI** (#7); runtime source is the TS
  builder (Constraint 5), so no drift and no async loader in S2.
- Layout state → **UI-only, out of the HCL** (#4).
- Unknown keys → **hard error + `meta{}` escape valve** (#3).
