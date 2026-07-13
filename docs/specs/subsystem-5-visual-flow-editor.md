# Subsystem 5 — Visual Workflow Editor

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — revised per four-lens adversarial review (feasibility, design-gap, scope, protocol); 27 findings adjudicated
**Date:** 2026-07-13
**Depends on:** Subsystem 2 (HCL format, shipped), Subsystem 0.5/4.2 (query pipe, shipped).

---

## Why

S2 shipped the HCL flow format as a fully-tested core library (`src/flows/`), but no runtime code
path consumes it — the only non-test consumer is the `scripts/gen-flow-b.ts` codegen fixture
generator. The run path resolves flows only through the static TS `FLOWS` registry
(`src/runners/source-adapter.ts:292`), and the desktop's `WorkflowEditor.tsx` edits `AppConfig`
blocks — a job the Settings screen (`features/settings/Settings.tsx`) already does completely —
while rendering hand-rolled, fake HCL read-only.

S5 makes the format *live*: `.vanguard/flows/*.hcl` files become **discoverable** (listed over the
sidecar query pipe), **runnable** (`--flow <name>` and the app's run builder resolve them), and
**editable** (the Workflow screen becomes a visual editor that round-trips real flow HCL).

S2's stated blocker for live discovery — "forces sync→async surgery on the sidecar protocol" — is
gone: S4.2's query pipe (`sidecar.rs` `Pipe::Query` + `Bound::Timed`) is exactly the seam a
repo-scoped `listFlows` needs. `capabilities()` stays pure/no-arg; repo-scoped data travels on new
methods that take `repoPath` explicitly, like `createTask` already does.

---

## Constraints (read first)

1. **CLI is a frozen public contract.** `--flow <name>` already exists; S5 only *widens the set of
   names that resolve*. That requires one **behavior-widening (not breaking) change to the sync
   parser**: `args.ts:441` currently hard-fails any `--flow` value outside the static `FLOWS`
   registry, so no repo flow name could ever reach dispatch. The parser check is removed (the
   `--plan`/`--flow` conflict check at `:437` stays); unknown-name rejection moves to the async
   layer that can actually see the repo (§5). Every previously-valid invocation behaves
   identically; previously-failing invocations may now succeed — additive in effect.
2. **A flow only ever produces `PipelineStage[]`** — `lowerFlow` output is shape-identical to a TS
   builder's; the runner, `assembleReviewPipeline`, and all `withStage*` transforms are untouched.
   The S2 precedence ladder (library → HCL overrides → runtime flags) is unchanged.
3. **Flow selection threads as a NAME STRING, never a closure** (S2 Constraint 3). The sync parser
   cannot resolve repo flows; resolution happens at the async boundaries that consume the name.
4. **The HCL grammar does not change.** No new keys, no layout state in HCL (S2 design-gap #4 —
   canvas layout is derived, deterministic, from source order). The editor round-trips at the
   **FlowDoc layer** so `meta {}` and `loop {}` blocks survive edits verbatim (S2 AC5 anticipated
   exactly this).
5. **Stdout discipline.** In `__sidecar`, the JSON protocol owns stdout. `@cdktf/hcl2json` (CJS +
   embedded WASM) is loaded **lazily, at first flow-method call**, never at sidecar or CLI startup
   — both to keep startup fast and to keep any load-time noise away from the protocol stream
   (console is already redirected to stderr before imports, but lazy loading removes the risk
   class entirely, and the CLI must not pay WASM load for `vanguard run` with no `--flow`).
   **Mechanism (the package is eager — requiring it gunzips + instantiates the WASM at module
   top, `bridge.js:93`):** `repo.ts` references `./parse.js` only via `await import('./parse.js')`
   inside each async function; `validateFlowDoc` and `emit-doc.ts` carry no hcl2json dependency
   and stay statically importable. A child-process probe test asserts that importing
   `source-adapter.js` and `sidecar/deps.js` does not load `@cdktf/hcl2json` — so a later
   "cleanup" to static imports can't regress this silently.
6. **Desktop stays thin; one component per file; real logic in pure reducers.** The editor's state
   transitions live in a pure `flowEditorReducer`, testable without a DOM. jsdom cannot drive
   geometry — drag-and-drop is tested at the reducer level (`moveStage`), not by simulating drags.
7. **LLM credentials invariant untouched** — S5 reads/writes only `.hcl` files under
   `<repoPath>/.vanguard/flows/`.

---

## One validity predicate (used everywhere)

`validateFlowDoc(doc)` (`src/flows/repo.ts`, pure, no I/O, no dynamic import):

- flow name matches the **flow-name grammar** `^[a-z0-9][a-z0-9._-]*$` (derived: §14's filename
  rule ∘ §12's `file == name + '.hcl'` rule — stated once, here);
- at least one stage (`stages.length >= 1` — an empty flow would list healthy, reach the run
  dropdown, and spin up a sandbox to run nothing);
- every stage either has a `ref` or its `name` is a `STAGE_LIBRARY` key.

List, write, run fail-fast, and the create-flow form all apply **this same predicate**, so a flow
never lists as healthy yet fails at save or run (review finding: list/write/run previously
disagreed). `parseFlowHcl` alone stays purely syntactic, as in S2.

---

## Scope

### In

**Core (`src/flows/`)**

1. **`emitFlowDoc(doc: FlowDoc): string`** (`src/flows/emit-doc.ts`) — canonical emitter at the
   FlowDoc layer. Emits: flow label, flow `meta {}`, stages in order (`name`, `ref`, overrides in
   the fixed S2 key order, stage `meta {}`), then `loop {}` blocks. **Round-trip contract:**
   `parseFlowHcl(emitFlowDoc(doc))` deep-equals `doc` (the editor's correctness spine; key order
   inside `meta` objects is not significant — hcl2json alphabetizes).
   - *Strings:* escape `\`, `"`, and newline (`\n`) in emitted strings. **Total-or-throw:** a
     string containing `${` or `%{` throws (verified by probe: an unbalanced `${` emits HCL that
     `parseFlowHcl` rejects, and quotes inside a balanced `${…}` must not be escaped — template
     syntax is not representable by a naive escaper, and no flow value legitimately needs it; a
     hand-authored file carrying one stays hand-authored, `writeFlow` rejects it with this
     message).
   - *Meta:* emitted in **attribute form** (`meta = { … }` — parseMeta accepts both forms, so the
     doc is identical either way) with **every key quoted** (`"a b" = 1` round-trips,
     probe-verified; bare keys would make a parseable non-identifier key unsaveable). Values:
     string/finite number/boolean/null, arrays, and plain objects emit as HCL attribute
     expressions; hand-written nested meta *blocks* parse to array-wrapped objects and re-emit as
     array expressions — canonicalized once, no data loss (probe-verified). Anything else
     (undefined, function, symbol, non-finite number) throws.
2. **`emitFlowHcl` becomes a thin adapter** (review: two parallel serializers drift): it maps
   `PipelineStage[]` → `FlowDoc` (keeping its throw-on-unemittable-field check and
   provider-object→name extraction) and delegates to `emitFlowDoc`. One canonical formatter;
   the checked-in `flow-b.hcl` stays **byte-identical** (S2 T8 codegen drift guard proves it).
3. **Stage library widening** (`src/flows/library.ts`) — the palette must cover the built-in
   flows' vocabulary or the editor can't compose what the run dropdown next door already offers
   (review: silent 4-stage palette). Add **`reviewer` and `simplifier`, picked by name from the
   *returned array* of `implementReviewSimplifyStages()`** (`pipeline.ts:465`) — the builder
   applies the shared `systemPrompt` via a trailing `.map` (`pipeline.ts:506`), so records must
   come from the call's output, never copied inline from source (each name appears once, so the
   by-name pick is unambiguous — the pattern `library.ts:11` already uses). Their extra
   budget/timeout fields (`stageCostFraction`, `timeoutMs`, …) live in the library **base
   record** exactly like prompts do (supplied at lowering, never emitted).
   Per-entry source builder named, S2 T3 drift-guard extended to both. `reviewer` collides across
   builders (the plan flow's reviewer differs); the library canonically carries the
   default-flow's richer record — recorded here as the chosen resolution of S2's F8 collision
   rule. **Excluded, with reasons:** `conformance` (runner-appended, report-only, `copyBack:false`
   — a composition special case the assembler owns), `generator`/`evaluator`/`tech-spec` (spec
   pipeline, different family). Palette = 6 stages; widening further is backlog.
4. **Repo flow discovery** (`src/flows/repo.ts`) —
   `listRepoFlows(repoPath): Promise<RepoFlowInfo[]>`: scan `<repoPath>/.vanguard/flows/`
   (non-recursive; missing dir → `[]`) for entries matching the §14 filename rule; a `*.hcl` file
   *not* matching it becomes an `error` entry (never a healthy entry `readFlow` would then
   reject). Parse + `validateFlowDoc` each; failures become `error` entries. Duplicate flow names
   across files → `error` on **all** involved files; a name shadowing a built-in `FLOWS` key →
   `error` entry (authoring-time signal; dispatch precedence makes the file unreachable anyway).
   Exact wire type (hand-mirrored into `vanguard-output.d.ts`):
   ```ts
   interface RepoFlowInfo {
     file: string;          // basename, e.g. "my-flow.hcl"
     name?: string;         // present when the file parsed
     label?: string;        //   (validity/duplicate/shadow entries keep name+label AND error)
     error?: string;        // present ⇒ not runnable; message for the UI
   }
   ```
   **Two error classes, discriminated by `name` presence:** no `name` ⇒ the file didn't parse
   (or failed the filename rule) — nothing to open; `name` + `error` ⇒ parsed but invalid
   (unknown stage, duplicate, shadow) — **openable in the editor for fixing** (§11/§18). Any
   `error` ⇒ excluded from the run dropdown (§21).
5. **Repo flow resolution** (`src/flows/repo.ts`) —
   `resolveRepoFlow(name, repoPath): Promise<PipelineStage[] | undefined>`: parse every
   regex-conforming file, **ignoring files that fail to parse or validate** (they cannot declare
   the name; a broken scratch file must not brick unrelated flows — review finding); exactly one
   valid file declaring `name` → `lowerFlow`; none → `undefined`; more than one → throw naming
   both files. No built-in check here — dispatch owns precedence (§8); `listRepoFlows` flags
   shadowing. Also **`assertFlowResolvable(flow, repoPath): Promise<void>`** — the **pure**
   fail-fast: built-in passes via **`Object.hasOwn(FLOWS, flow)`** (own-property, matching
   `source-adapter.ts:293` — a plain `FLOWS[flow]` lookup would pass `'toString'` and burn a
   sandbox; the existing prototype-key regression at `sidecar.test.ts:71` is preserved, not
   deleted); else the declaring file must parse + `validateFlowDoc`, with the **same duplicate
   rule as `resolveRepoFlow`** (two valid files declaring the name → throw naming both — shared
   scan helper, so the fail-fast can't pass a run the runner will kill later).
   **No `lowerFlow`, no dynamic import** — a `ref` module must never execute on the untimed run
   pipe before the run proper (review: an import that hangs would be unkillable and brick the
   single-in-flight gate). Throws a plain `Error` with the unknown-flow message listing built-ins
   + **valid** repo flow names.
6. **`ref` import cache-busting** (`src/flows/lower.ts` `resolveRef`): append `?v=<mtime-ms>` to
   the import URL. The sidecar child is long-lived; without this, an edited ref TS silently runs
   its stale ESM-cached version on the next app run (review finding). CLI (fresh process) is
   unaffected. Residual accepted limitation: a ref module that blocks at top level hangs the run
   exchange — pathological, documented, not defended against.

**Run path (repo HCL flows become runnable)**

7. **CLI parser** — `src/cli/args.ts:440-442`: delete the `Object.hasOwn(FLOWS, flowRaw)` gate
   (Constraint 1). The `--plan`/`--flow` conflict check stays. Unknown names thread through as
   strings for both `run` (`:730`) and `watch` (`:850`) call sites.
8. **Runner dispatch** — `src/runners/source-adapter.ts`: resolve `flow` → `baseStages`
   **before any sandbox/proxy/context startup** (currently the unknown-flow throw at `:293` sits
   after `startProviderProxies`/`prepareContext`; a typo must not cost a sandbox spin-up —
   review finding). Order: `FLOWS` hit → `FLOWS[flow].build()`; else
   `await resolveRepoFlow(flow, deps.repoPath)`; else throw the unknown-flow error listing
   built-ins + repo names. The `'default'` ⇒ adapter-stages special case is untouched.
   `run-start.flow` carries the name unchanged.
9. **Sidecar `createRun`** — `validateCreateRun` (`src/sidecar/sidecar.ts:104`) relaxes the flow
   check to "non-blank string". `productionDeps().createRun` (`src/sidecar/deps.ts:70`) calls
   `assertFlowResolvable(flow, repoPath)` **as its first statement — before `beginRun()`** (review:
   placement between `beginRun` and the sandbox would leak an armed AbortController on every
   typo), wrapped to `BadRequestError` so the envelope kind is `bad-request`, not `internal`.
   The name still threads to the runner, which resolves it for real (Constraint 3).

**Sidecar protocol (all `Pipe::Query`, `Bound::Timed`)**

10. **`listFlows { repoPath }`** → `{ flows: RepoFlowInfo[] }`. Built-in flows are NOT in this
    response (the client has them from `capabilities()`); the stage palette is NOT here either —
    it is static, so it moves to `capabilities()` (§13).
11. **`readFlow { repoPath, file }`** → `{ doc: FlowDoc, source: string }` — `source` is the
    **raw file content** (canonical form appears only after a write; the source tab's
    representation switches on first save — recorded, not accidental). Returns the doc even when
    `validateFlowDoc` fails (the editor is how a broken flow gets *fixed*); parse failure → error
    envelope.
12. **`writeFlow { repoPath, file, doc }`** → `{ source }`. Validation, in order, before any
    write: `validateFlowDoc(doc)`; `file === doc.name + '.hcl'` (a hand-authored name≠filename
    flow therefore lists healthy, opens, and runs, but Save is rejected with *"file name doesn't
    match flow name 'x' — rename the file to x.hcl to edit it in the app"* — intended v1 UX; an
    in-app rename operation is backlog); no built-in `FLOWS` collision;
    **no other file in the directory declares `doc.name`** (review: D3 promised this, §8 didn't
    deliver it). Then: `mkdir -p` the flows dir (first save in a fresh repo — review finding),
    `emitFlowDoc`, **re-parse the emitted source** (belt-and-braces: a file `readFlow` cannot read
    back must never be written), atomic write via temp file `.<file>.tmp` in the same dir
    (dot-prefixed ⇒ invisible to §4's discovery by construction; opened truncating so a
    watchdog-killed retry overwrites rather than accumulates; best-effort unlink on error) +
    rename. Returns the canonical source.
    `Bound::Timed` is correct here: same doc → same bytes, retry converges, rename can't tear the
    target — the S4.2 Untimed rule guards non-idempotent *external* writes; this is neither.
    Residual (accepted, pre-existing in kind): the watchdog kills by pid and can in a
    milliseconds-wide race land on a subsequent exchange on the shared query child.
13. **`capabilities().stages: string[]`** — `Object.keys(STAGE_LIBRARY)` added to `Capabilities`
    (additive, stays pure/no-arg per S2 Constraint 5). The editor's palette and provider select
    both come from the already-cached capabilities call.
14. **Validators** (`sidecar.ts`): `repoPath` must be a **non-blank absolute path**
    (`path.isAbsolute` — the query child inherits the *app's* cwd, so a relative path would
    read/write some other tree; this is the sidecar's first write-to-disk method); `file` must
    match `^[a-z0-9][a-z0-9._-]*\.hcl$` (path separators are excluded entirely, so `..` can never
    form a path *segment*; a literal `..` inside a basename like `a..hcl` is harmless and
    allowed); `doc` shape-checked (name/label strings, stages array of {name, ref?, overrides,
    meta?}, loops array) **with unknown keys rejected at doc, stage, overrides, and loop level
    (meta exempt), and override values checked by the same rules as parse's `applyOverride`
    (effort enum, positive-int max_turns, …)** — the write path receives a JS object, not HCL,
    so without this a stage carrying e.g. `timeoutMs` would be silently dropped by the emitter
    and the §12 re-parse would never see the loss, violating the format's never-silent-drop rule
    (S2 Scope §4). Flow-file problems (parse failure, validation rejection) throw
    `BadRequestError` → kind `bad-request`; `internal` is reserved for fs faults.

**Desktop plumbing**

15. **Rust commands** (`sidecar.rs`): `api_list_flows`, `api_read_flow`, `api_write_flow` — thin
    `#[tauri::command(async)]` wrappers, `Pipe::Query`/`Bound::Timed`, registered in `lib.rs`.
    Envelope handling follows **`api_create_task`** (`sidecar.rs:640` — extracts
    `error.message`), NOT `api_capabilities` (which collapses errors to `"no result"` — a
    readFlow parse message must reach the UI verbatim; review finding).
16. **ipc wrappers** (`ipc.ts`): `apiListFlows(repoPath)`, `apiReadFlow(repoPath, file)`,
    `apiWriteFlow(repoPath, file, doc)`. `FlowDoc`/`StageDecl`/`RepoFlowInfo` hand-mirrored into
    `vanguard-output.d.ts` (same manual-mirror discipline as `RunEvent`; shared-types seam remains
    backlog).
17. **`@cdktf/hcl2json` graduates devDependencies → dependencies** (root `package.json`). Named
    cost from the roadmap. The build is plain `tsc` (no bundler), so the WASM asset stays in
    `node_modules` and loads from disk — no packaging change. F7 (a consumer bundling vanguard)
    stays a non-issue until someone bundles; noted, not solved.

**Desktop editor (the visible piece)**

18. **`WorkflowEditor.tsx` rewrite** — the Workflow screen becomes the flow editor. The AppConfig
    block canvas is **deleted** (Settings.tsx already edits every one of those fields; verified).
    Layout: flow list rail (from `apiListFlows`; entries without `name` — unparseable — rendered
    disabled with their message; entries with `name` + `error` — parsed but invalid — selectable
    with an error badge, since fixing them is what the editor is *for*) → canvas (stage blocks in
    source order; `ref` stages badged; a stage whose name is neither library nor ref renders with
    a warning style — such docs load fine (§11) precisely so the user can fix them; loops render
    as a read-only chip listing member stages) → inspector
    (selected stage: name select over `capabilities().stages` — a non-library current name shown
    as an extra "(not in library)" option; `ref` text input; override fields: model text, effort
    select low/medium/high/xhigh/max, max_turns number, provider select from
    `capabilities().providers`, resume_previous checkbox).
19. **Editing operations** — add stage (library name or blank `ref` stage), remove stage, reorder
    via **native HTML5 drag** (`draggable` + dragover/drop — no new dependency) *plus*
    keyboard-accessible ▲/▼ buttons; edit overrides/ref; create flow (name validated against the
    flow-name grammar **in the form, before a doc exists**, and against list-known names **∪
    `capabilities().flows` names** — built-ins are the likeliest collisions and are absent from
    `listFlows`, so checking the list alone would defer them to Save); Save disabled while the
    doc has zero stages (server rule §"validity predicate" holds regardless); Save →
    `apiWriteFlow`. **On success:** source tab refreshed from the
    returned canonical HCL, dirty cleared, rail refreshed. **On failure:** error message (from
    the envelope) renders inline; `doc` and dirty flag untouched; in-flight guard released
    (review: the failure path was unspecified). Delete flow: **not in v1** (destructive; users
    delete the file — backlog).
20. **State** — pure `flowEditorReducer` (load/select/add/remove/move/setOverride/setRef/
    saveOk/saveFailed/reset + dirty tracking); `doc.meta`, per-stage `meta`, and `doc.loops` pass
    through the reducer **verbatim**. Async-per-context discipline (handoff gotcha): generation
    counter (`useRef`, bumped on project/file switch, checked on resolve) + reducer `reset` +
    in-flight `useRef` guard on Save.
21. **Run-builder integration** — `NewRunForm`'s flow dropdown =
    `capabilities().flows ∪ listFlows(repoPath).flows` (entries with `error` excluded).
    `listFlows` is fetched **fresh on every form open** — explicitly not session-cached like
    capabilities, because repo flows are mutable per-repo state and the point of this item is
    "save in the Workflow screen, then run it immediately". On `listFlows` failure the form
    still renders with built-ins only
    (non-blocking notice) — it must never disappear the way the caps-failure path hides it
    (review finding).

### Non-goals (deferred, with reason)

- **Loop editing.** Loops render read-only and round-trip untouched. Editing loops means editing
  semantics S2 deliberately left provisional (`loop {}` still throws at run); build the editor for
  it when loops can actually run (Flow A / human gate, backlog).
- **Editable source tab.** v1 shows HCL read-only (raw on load, canonical after save).
  Hand-editing belongs to a real editor; the app re-reads on next open. An in-app HCL editor with
  parse-on-save is cheap to add later via `readFlow`'s error envelope, once wanted.
- **Flow deletion from the UI** — destructive; v1 users delete the file (backlog).
- **`ref` stage *creation* tooling** (scaffolding the TS file) — the editor only references
  existing exports; scaffolding is backlog.
- **Palette beyond the 6 library stages** — `conformance`/`generator`/`evaluator`/`tech-spec`
  excluded with reasons (§3); widening further is backlog.
- **Board read path → core, shared-types seam, custom providers** — unchanged backlog (S6 etc.).
- **Canvas free-form layout / positions.** Locked out by S2 design-gap #4: layout is derived from
  source order, deterministically. Nothing spatial enters the HCL.

---

## Design decisions

**D1 — Round-trip at the FlowDoc layer, not the stage layer.** The editor edits `FlowDoc` —
composition — and never lowers. Lowering (library identity, `ref` imports, provider factories)
stays a run-time concern. This keeps `meta`/`loop` alive through an edit session and keeps the
editor free of provider/import machinery. Consequence: `emitFlowDoc` is the one real emitter;
`emitFlowHcl` adapts into it (§2).

**D2 — File I/O lives in the Node sidecar, not Rust.** A `flows.rs` mirroring `docs.rs` would
still need sidecar methods for parse/emit (WASM parser is Node-only) — two implementations, two
trust boundaries, N+1 round trips to label a list. One sidecar method per operation keeps fs +
parse in one place and the Rust side is three thin pass-throughs. `readFlow` stays a separate
method (rather than fat list entries) because selecting a flow must show **current** bytes even
after an external hand-edit mid-session; the list stays summary-cheap. Cost: flow file I/O needs
a healthy sidecar; acceptable — every S5 feature needs the parser anyway.

**D3 — Resolution by parsed flow name; write canonicalizes filename.** Runs reference `flow "x"`
labels, not filenames (registry semantics, matches `FLOWS`). `writeFlow` enforces
`file == name + '.hcl'` and rejects sibling duplicates, so app-authored flows are canonical;
hand-authored mismatches read fine; duplicates/built-in shadowing surface as `error` entries at
list time and duplicate declarations throw at resolve time.

**D4 — Native HTML5 drag, no dnd dependency.** Coarse reordering of a handful of blocks needs
`draggable`/`onDragOver`/`onDrop` and a `moveStage(from, to)` reducer action — not @dnd-kit.
▲/▼ buttons cover keyboard access and give jsdom-testable reorder without geometry.

**D5 — `Bound::Timed` for `writeFlow`.** The S4.2 rule ("writes are Untimed") exists because a
killed *external* write can double-post. This write is local, idempotent, and atomic: retry
converges, rename can't tear, the dot-prefixed temp name is invisible to discovery, and a leaked
temp is overwritten (truncate) by the retry. Untimed would trade that for an unrecoverable pipe
hang. The distinction is *idempotent vs not*, not *read vs write* — recorded so the next reader
doesn't "fix" it. Accepted residual: the watchdog's pid-keyed kill can, in a milliseconds window,
land on the next exchange on the shared query child (pre-existing in kind since S4.2).

**D6 — Fail-fast is a pure check, placed first.** `assertFlowResolvable` runs as the first
statement of the sidecar `createRun` dep (before `beginRun()`, before any sandbox cost) and on
the CLI path flow→stages resolution happens before proxies/context startup (§8). It never lowers
and never imports ref TS — repo code must not execute on the untimed run pipe before the run
proper. Bad flow name → `bad-request` in <100ms, zero Docker cost, no armed-controller leak.

---

## Seams (file:line, verbatim)

- `src/cli/args.ts:440-442` — delete the static-registry gate; keep `:437` conflict check.
- `src/runners/source-adapter.ts:292-295` — dispatch: hoist flow→stages resolution ahead of
  sandbox/proxy startup; add `resolveRepoFlow` fallback; unknown-flow error lists both name sets.
- `src/sidecar/sidecar.ts:104-106` — `validateCreateRun` flow check → non-blank string.
- `src/sidecar/sidecar.ts:135-149` — dispatch: add `listFlows`/`readFlow`/`writeFlow` branches +
  validators (§14).
- `src/sidecar/sidecar.ts:32-36` — `SidecarDeps` gains `listFlows`, `readFlow`, `writeFlow`.
- `src/sidecar/deps.ts:70` — `assertFlowResolvable` first statement of `createRun` (§9);
  wire the three new deps to `src/flows/repo.js`.
- `src/api/capabilities.ts:37-44` — add `stages` (§13).
- `src/flows/library.ts:11` — widen (§3). `src/flows/lower.ts:45` — cache-bust (§6).
- `apps/desktop/src-tauri/src/sidecar.rs:603-645` — `api_create_task` is the command template
  (envelope handling); register new commands in `lib.rs:168` block.
- `apps/desktop/src/ipc.ts` — three wrappers + `Capabilities.stages`;
  `vanguard-output.d.ts` — `FlowDoc`/`StageDecl`/`RepoFlowInfo` mirrors.
- `apps/desktop/src/features/workflow/` — `WorkflowEditor.tsx` rewritten; new sibling files
  `FlowCanvas.tsx`, `StageInspector.tsx`, `flowEditorReducer.ts` (+ co-located tests).
- `apps/desktop/src/features/inspector/NewRunForm.tsx` — flow dropdown merge (§21).
- `package.json` — `@cdktf/hcl2json` moves to `dependencies`.
- `scripts/gen-flow-b.ts` — unchanged behavior; output stays byte-identical (§2).

---

## Acceptance criteria

- **AC1 (round-trip)** For every fixture doc (each override key, `ref`, flow+stage `meta` with
  nested/array/null values **and a non-identifier key like `"a b"`**, loops, quoting-hostile
  strings incl. `\` `"` and newline): `parseFlowHcl(emitFlowDoc(doc))` deep-equals `doc`.
  `emitFlowDoc` throws on `${`/`%{` in strings and on unrepresentable meta values. `emitFlowHcl`
  delegates: `flow-b.hcl` regeneration is byte-identical.
- **AC2 (discovery)** `listRepoFlows`: healthy entries carry name+label; parse-failure and
  regex-nonconforming files yield `{file, error}` (no `name` — not openable); validity-failure
  (incl. zero-stage), duplicate (all involved), and built-in-shadowing files yield
  `{file, name, label, error}` (openable); missing dir → `[]`.
- **AC3 (runnable)** With `.vanguard/flows/my-flow.hcl` present: `parseArgs` accepts
  `--flow my-flow` for **both `run` and `watch`** (no static-registry rejection); at the
  `runSourcedIssue` layer (onEvent spy, no live LLM) the lowered stages run and
  `run-start.flow === 'my-flow'`; unknown flow errors list built-ins + repo names **before any
  sandbox/proxy startup** (spy ordering); built-in flow behavior unchanged (existing tests
  green). `resolveRepoFlow` ignores broken sibling files.
- **AC4 (fail-fast)** Sidecar `createRun` with an unresolvable flow yields a `bad-request`
  envelope; `beginRun` and the sandbox are never invoked (helper unit-tested directly; envelope
  via `runSidecar` with an injected `createRun` composing `assertFlowResolvable` + spies —
  `productionDeps` itself stays smoke-verified, as today). The **`'toString'` prototype-key
  regression is preserved** (bad-request, `Object.hasOwn` semantics), and a **duplicate
  declaration** fails the fail-fast too (not first at the runner).
- **AC5 (protocol)** `listFlows`/`readFlow`/`writeFlow` through `runSidecar` with injected deps:
  relative/blank `repoPath` and traversal/nonconforming filenames rejected; `writeFlow` rejects
  invalid docs, name-grammar violations, zero-stage docs, filename mismatch, built-in collisions,
  sibling duplicates, **and unknown keys anywhere outside `meta` (a stage carrying `timeoutMs` or
  `overrides.foo` → `bad-request`, never a lossy success)**; creates the flows dir on first save;
  re-parses before writing; temp file is dot-prefixed + cleaned; returns canonical source.
  Flow-file errors are kind `bad-request`.
- **AC6 (editor)** Reducer transitions pure and tested; `meta`+`loops` verbatim through
  load→edit→save; save-failure leaves doc+dirty untouched and surfaces the message. Component
  tests (mocked ipc): rail renders healthy + error entries, selecting loads doc, unknown-name
  stage renders with warning, save calls `apiWriteFlow` and refreshes source tab on success,
  failure shows inline error.
- **AC7 (run builder)** NewRunForm dropdown = built-ins ∪ healthy repo flows, fetched fresh per
  form open; on listFlows failure the form renders built-ins only and is not hidden.
- **AC8 (gates)** `pnpm lint && pnpm typecheck && pnpm test`;
  `pnpm -C apps/desktop exec tsc --noEmit && pnpm -C apps/desktop test`; `cargo test` (src-tauri
  touched); no `.github/workflows/` change; `@cdktf/hcl2json` in `dependencies`.

---

## Test plan

- **T1 emit-doc** (`emit-doc.test.ts`) — AC1 table; adapter delegation + codegen byte-identity.
- **T2 repo** (`repo.test.ts`) — temp-dir fixtures: every AC2 entry class; resolve happy path
  (lowered stages match), miss → undefined, duplicate throw, broken-sibling tolerance;
  `assertFlowResolvable` pass/throw cases; `resolveRef` cache-busting (edit fixture, re-lower,
  new module version observed).
- **T3 args + dispatch** (`args.test.ts`, `source-adapter.test.ts`) — AC3. **Three existing
  tests are rewritten, not extended:** `args.test.ts:642` ("rejects an unknown --flow") inverts
  to "unknown `--flow` parses through as a string"; `sidecar.test.ts:70-71` ("unknown flow",
  "prototype-key flow") move from the validator table to the AC4 style (injected `createRun`
  composing `assertFlowResolvable`).
- **T4 sidecar** (`sidecar.test.ts` extension) — AC4 + AC5 validators and envelopes.
- **T-lazy** — child-process probe: importing `dist/runners/source-adapter.js` and
  `dist/sidecar/deps.js` must not load `@cdktf/hcl2json` (Constraint 5 guard).
- **T5 library** (`library.test.ts` extension) — reviewer/simplifier drift guards vs
  `implementReviewSimplifyStages`.
- **T6 reducer** (`flowEditorReducer.test.ts`) — AC6 pure transitions incl. failure path.
- **T7 components** (`WorkflowEditor.test.tsx` etc., mocked ipc) — AC6 render/save wiring; AC7
  NewRunForm merge + failure.
- **T8 rust** — existing `cargo test` covers command registration compile; envelope mapping is
  asserted from the TS side (error message reaches the ipc caller, T7).
- **Contract note:** no new *external* contract (files + parser only); the WASM parser is
  exercised for real throughout T1/T2.

---

## Delivery

Two PRs, each through the full local review loop (review → fix → re-review on new head until
clean-on-head):

- **PR A — flows go live (core + protocol):** §1-17. Independently valuable: HCL flows become
  runnable from CLI + app; desktop plumbing ready.
- **PR B — the editor (desktop UI):** §18-21. Pure consumer of PR A.

## Review adjudication (round 1, recorded)

Adopted: all three blocking findings (args.ts gate — same root, three lenses), pure fail-fast
(no ref import pre-run), `${`/`%{` throw + re-parse-before-write, validity predicate unification,
sibling-duplicate check at write, mkdir on first save, api_create_task as Rust template, temp-file
contract, absolute-repoPath validators, palette widening, stages→capabilities, emitter
unification, save-failure state, NewRunForm fetch/failure semantics, fail-fast-before-beginRun,
regex prose fix, Why-section reword, cache-busted ref imports.
Rejected: none. Deferred: watchdog cross-exchange race (pre-existing since S4.2, recorded in D5);
readFlow folding into listFlows (rationale added to D2 instead).

## Review adjudication (round 2, recorded)

15 findings, none blocking; all adopted: §3 extraction wording corrected (builder uses a trailing
`.map` — records come from the returned array); error classes split (openable-invalid vs
disabled-unparseable, discriminated by `name` presence) so the editor can actually open what it
exists to fix; `Object.hasOwn` built-in check + preserved `'toString'` regression; duplicate rule
added to `assertFlowResolvable`; unknown-key rejection on the write path (never-silent-drop);
lazy-WASM boundary mechanism + probe test (the package instantiates WASM at import);
quoted meta keys + attribute-form meta; zero-stage rule in the validity predicate;
name≠filename Save rejection recorded as intended v1 UX (in-app rename is backlog); create-form
collision check includes built-in names; T3/T4 rewritten-test cases named; stale §-references
fixed. Two rounds total; findings converged from 27 → 15 with round 2 dominated by
revision-introduced consistency errors — proceeding to implementation, residue owned by the PR
review loop.
