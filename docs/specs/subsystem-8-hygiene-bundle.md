# Subsystem 8 — Hygiene Bundle

**Status:** v2, review-converged (one adversarial round, 10 findings — adjudication §10)
**Scope:** six mapped defects/gaps, each small; one protocol addition (`deleteFlow`). Ordered by
value/effort from the mapping. Item 7 (editable source tab) deferred — trigger: someone actually
edits HCL by hand in the app; it needs a `parseFlow` protocol method + reducer surgery.

---

## 1. Diff/Transcript double-scroll (S)

`DiffView.tsx:14` and `TranscriptView.tsx:21/:25` cap themselves at `max-h-[32rem] overflow-auto`
inside panels that already own scroll (`RunDetail.tsx:42/:54`, `min-h-0 flex-1 overflow-y-auto`).
Drop the inner height caps. Keep `overflow-x-auto` on DiffView's `<pre>` (no wrap — long diff
lines) AND on TranscriptView's raw `<pre>`: `whitespace-pre-wrap` wraps at whitespace only, and
raw JSONL transcripts have long unbroken runs — without per-pre x-overflow the whole panel
(stage labels included) scrolls horizontally. The formatted wrapper loses overflow entirely.
No other consumers (verified).

## 2. FlowCanvas: cancelled drag leaves stale state (S)

`dragFrom` ref (FlowCanvas.tsx:25) is set on `dragStart` and cleared only in `onDrop` — Esc or an
outside drop leaves it armed (a later stray drop fires a bogus move) and can leave the `dragOver`
ring stuck. Fix: `onDragEnd` on the draggable clears both (`dragend` fires on the source for every
outcome, including cancel). Test: jsdom-fire dragstart → dragend → drop elsewhere → no `onMove`.

## 3. StageInspector: max_turns silent snap-back (S)

The number input (StageInspector.tsx:72-83) no-ops on `0`, `-3`, `2.5` — the field snaps back with
zero feedback. Fix with the existing in-feature pattern (`newNameProblem`, WorkflowEditor.tsx:129):
local draft state, validate on change, red hint (`positive integer only`), commit override only
when valid. Blur/valid-commit clears the draft. **The draft must reset when the selected stage
changes** — StageInspector is not remounted across selections (WorkflowEditor renders it with no
key), so a lingering invalid draft from stage A would display on stage B: give it
`key={state.selected}` (test-pinned).

## 4. Cross-project run-strip bleed (M — Rust command shape only)

S1's known follow-up: `apiActiveRun()` is global; Inspector (remounted per project,
`key={active.path}`) re-attaches project A's run in project B (Inspector.tsx:177-197).

The sidecar Rust layer already *receives* `repoPath` in every createRun (`CreateRunParams`
requires it) but stores only the runId (`Sidecar.active: Mutex<Option<String>>`, sidecar.rs:36).

- `active` becomes `(runId, repoPath)`; `api_create_run` stamps it inside the existing lock scope.
- `api_active_run` returns `{ runId, repoPath } | null` (shape change to a **desktop-internal**
  Tauri command — not the sidecar stdio protocol, not the CLI; ipc.ts + the one caller update).
- `run-accepted` (sidecar.rs:511) gains `repoPath`. **Accept-time filtering alone is NOT
  sufficient** (review round 1, blocking): the reducer today adopts a runId from ANY first event
  (`state.runId ?? payload.runId` on every case), so a foreign run's mid-flight `stage-start`
  would seed a virgin strip in project B even with the fold skipped. Two changes:
  (a) **the reducer's adoption rule narrows — only `run-accepted` may adopt a runId**; every
  other event type is dropped while `state.runId === undefined`; (b) the fold/listener filter on
  `run-accepted.repoPath !== project`. The reducer is the test-pinned seam and covers backlog +
  live symmetrically. Consequence handled: `buffer_push` evicts the OLDEST event past
  MAX_EVENTS_PER_RUN (sidecar.rs:356, cap 2000), which would evict `run-accepted` on a huge run
  and leave a re-attach folding nothing while `typedRun` blocks New-run forever — **eviction
  skips index 0** (the accepted marker is retained; one-line Rust change, test-pinned).
- Rust rejects a createRun whose `params.repoPath` is missing/non-string BEFORE minting the
  runId (inside the existing lock scope): validation is otherwise Node-side and runs AFTER Rust
  has stamped `active` and emitted `run-accepted` — the early reject keeps
  `run-accepted.repoPath` always a string. (Rust tests pinning the old
  `active: Mutex<Option<String>>` shape update with the tuple — sidecar.rs:754-795.)
- Inspector: on re-attach, if `repoPath !== project`, do not fold — instead set a lightweight
  "run live in <other project>" note state; the New-run button stays enabled (the Rust
  single-in-flight guard already rejects a second run with a clear error — keeping the button
  enabled but rejected beats silently disabling it for a run the user can't see; the note says
  why it will fail).

## 5. Issue #339 — navigation guard seam (M)

Mapped reality is worse than the issue: `<Inspector key={active.path}>` means project switch
**remounts** the subtree (editor state dies before any effect runs), and a Rail *screen* switch
unmounts WorkflowEditor too — `confirmDiscard` covers only the editor's internal rail/create
clicks.

Seam: an App-level guard registry. **Six** callsites, not five — review found `onOpenRunning`
(App.tsx:182, Rail running-run click → `setScreen('runs')`), the exact silent-discard path the
draft missed.

- `App.tsx`: `const navGuard = useRef<(() => boolean) | null>(null)`; a `navigate(fn)` helper runs
  `navGuard.current?.() === false ? noop : fn()`. Route ALL SIX navigation callsites through it:
  `setActiveProject` (ProjectCombobox :151), `enterProject` (:120, Dashboard + palette), `remove`
  (:107), `setScreen` (Rail :181), `onHome` (:168, :213), and `onOpenRunning` (:182).
  Accepted limitation (documented, unguardable by confirm): the 5s project poll can null out
  `active` if a project vanishes from disk, unmounting Inspector guard-free.
- A small context (`NavGuardContext` providing `register/unregister`) threads App → Inspector →
  WorkflowEditor; the editor registers `confirmDiscard` while `state.dirty` and unregisters on
  unmount/clean. Registry shape covers any future dirty screen for free (DocsScreen is
  save-on-blur — nothing to register today).
- Window close: **`getCurrentWindow().onCloseRequested`** (`@tauri-apps/api/window`) is the
  primary mechanism — `beforeunload` is unreliable in Tauri/WKWebView on native close (kept as a
  web-side belt). Verify in the running app before merge (needs-live-check).
- Pure logic (register/unregister/last-wins/cleared-on-fire) lives in a tiny testable module, not
  in App's JSX.

## 6. In-app flow rename + delete (M — one protocol addition)

Nothing exists (protocol is exactly capabilities/createTask/createRun/listFlows/listProviders/
readFlow/writeFlow). Additive:

- **Core:** `deleteRepoFlow(repoPath, file)` in flows/repo.ts (validate `FLOW_FILE_RE`, unlink,
  ENOENT → FlowError "already gone" — idempotent delete reads better than a scary error).
- **Sidecar:** `deleteFlow { repoPath, file }` method — validator reuses `requireFlowFile`;
  dispatch + `SidecarDeps` entry; FlowError classifies bad-request as usual.
- **Rust:** `api_delete_flow`, query pipe, **`Bound::Timed` — decided in review.** The draft's
  Untimed lean was factually wrong: `api_cancel` signals only the RUN child (`publish_run_pid`
  is Pipe::Run-only), so a hung Untimed query would hold the query mutex forever, wedging
  capabilities/listFlows/createTask until app restart — NOT "recoverable by cancel". And the
  createTask analogy fails: that is a non-idempotent external network write; this is one local
  `unlink(2)` the spec itself makes idempotent (ENOENT ⇒ success) — a watchdog-killed exchange
  retried converges, which is precisely Timed's contract (and writeFlow's existing rationale).
  Bonus: Timed lets `api_delete_flow` reuse `flow_request` verbatim.
- **Rename is composition, not protocol:** `writeFlow(newName.hcl, {...doc, name: newName})` then
  `deleteFlow(oldFile)` — write-before-delete so failure never loses the flow; writeFlow's
  existing collision checks (built-ins + siblings) gate the target name for free.
- **UI:** rail row affordances (rename inline like the create form's name input incl. its
  taken-name set — the set includes file BASENAMES, which is the only guard against renaming
  onto a broken file's name: writeFlow's sibling check counts valid declarations only and the
  atomic rename(2) would clobber `broken.hcl` wholesale; pin that collision with a test);
  delete with `confirm()`; reducer actions for rename landing on the open file. Failed-delete
  landing (write succeeded, unlink EACCES): error banner naming the stale old file; the
  refreshed list shows both (differently-named, both valid — messy, not invalid).

## 7. Acceptance criteria

1. Diff/transcript: one scrollbar (the panel's); long unwrapped diff lines scroll horizontally.
2. Cancelled drag: no stuck ring, no phantom move on a later drop (test-pinned).
3. Invalid max_turns shows the hint and never silently reverts; valid input commits.
4. With a run live in project A: project B's Inspector shows the note, does not render A's strip,
   does not fold A's backlog; A still re-attaches fine. Neither `run-accepted` NOR any mid-flight
   event (stage-start/cost/run-end) from A creates a strip in B — the narrowed adoption rule is
   the pinned seam (a bare `stage-start` on a virgin reducer must NOT adopt). A >2000-event run
   still re-attaches (eviction retains the accepted marker — test-pinned Rust-side).
5. #339: dirty editor + each of the SIX navigation paths + window close (onCloseRequested,
   live-verified) → confirm; cancel keeps state; clean editor never prompts. No double-prompt:
   WorkflowEditor's internal rail/create clicks call confirmDiscard directly and never route
   through App's navigate() (verified — disjoint paths).
6. Rename/delete: delete removes the file and clears the editor if it was open; rename preserves
   content (doc equality mod name), collision-rejected on existing names, never loses the flow on
   a mid-compose failure (write-then-delete order pinned by test); `vanguard run --flow <renamed>`
   works immediately (fresh list).
7. All existing suites green; sidecar protocol additions additive-only.

## 8. Test plan

Reducer/logic units for every item (nav-guard registry pure module; rename compose order via
mocked ipc rejection between the two calls; strip-bleed filter on the attach seam). Sidecar:
deleteFlow validator table + dep unlink + ENOENT idempotence; stdio probe against built dist
(S5 style). Mutation checks: drop the accept-time repoPath filter (AC 4 test must fail); reorder
rename to delete-first (AC 6 test must fail); drop a navigate() routing (AC 5 per-path tests).

## 9. Delivery

Two PRs: **A** — items 1–5 (desktop + the Rust active-tuple/eviction changes); **B** — item 6
(the cross-package protocol slice: core deleteRepoFlow + sidecar method + Rust command + UI),
with its stdio probe isolated from the reducer/nav churn. Commits per item within each.

## 10. Review adjudication (round 1 — 10 findings)

Adopted: reducer adoption narrowing + eviction retention (blocking — accept-time filtering alone
was insufficient: any first event adopts); sixth nav callsite `onOpenRunning` (blocking — the
exact #339 bug would have survived); deleteFlow decided Timed (the Untimed rationale was
factually wrong — cancel cannot reach a query-pipe hang); onCloseRequested over beforeunload
(Tauri/WKWebView reliability); Rust early-reject on missing repoPath (validation is Node-side
and post-stamp otherwise); Rust test churn named; broken-basename rename collision pinned +
failed-delete landing UX; raw-transcript x-overflow kept; StageInspector draft keyed per
selection; two-PR split. Anti-findings confirmed by the reviewer: no double-prompt path; rename
self-collision safe; write-before-delete order safe; run-accepted extra field inert to the
reducer.
