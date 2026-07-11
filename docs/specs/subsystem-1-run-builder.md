# Subsystem 1 — Structured Run Builder

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — ready for implementation plan (S0.5 merged, PR #325).
**Date:** 2026-07-11 (re-verified against merged S0.5).
**Depends on:**
- Subsystem 0 (typed core API — shipped: `capabilities()`, `apiCreateRun`, `api:event`).
- **Subsystem 0.5 (sidecar hardening) — MERGED.** Delivered the surface this spec
  consumes: `{runId, event}` envelope + `run-accepted` first event; `apiRunBacklog(runId)`
  + `apiActiveRun()` re-attach; `apiCapabilitiesCached()`; `apiCancel()` (out-of-band
  SIGUSR2); `run-error`/`run-cancelled` terminal events; `repoPath` on `CreateRunParams`;
  `apiRepoOk(repoPath)` pre-flight. See `docs/specs/subsystem-0.5-sidecar-hardening.md`.
  No provider gate was built (all built-ins run on the typed path).

---

## Goal

Replace the desktop "New run" raw-CLI-string textarea with **structured fields**
sourced from `capabilities()`, launching via the typed **`apiCreateRun`** + a live
**`api:event`** stream. Kills "know the CLI." The composed CLI command stays
inspectable as an escape hatch, but the user never has to hand-type it.

---

## Locked decisions

- **Execution path: typed `apiCreateRun`**, not CLI-string `spawnRun`. Structured
  events drive the live UI — the real payoff of Subsystem 0. (The `spawnRun` path
  stays for the raw-CLI escape hatch and for `vanguard watch` / Fleet.)
- **F6 resolved via path A — a `repoPath` param.** One shared sidecar; each run
  carries its target project. No sidecar-per-project, no Rust `current_dir` change.
- **Live view augments, not replaces.** A structured stage/cost strip on top; the
  raw log stays, collapsible, below it.
- **CLI escape hatch stays.** An "advanced / edit command" toggle still exposes the
  composed `vanguard run …` string (back-compat + debug), per the vision doc.

---

## Part 1 — F6: project targeting (delivered by S0.5, consumed here)

**Delivered by S0.5.** The `repoPath` param on `CreateRunParams` (validated non-blank),
`deps.ts` using `params.repoPath` (was `process.cwd()`), and threading into
`RunIssueDeps.repoPath` all landed in Subsystem 0.5. S1 only *uses* them.

S1's only F6 responsibility: **the builder passes the current project
(`Inspector`'s `project`) as `repoPath`** in the `apiCreateRun` call, and a cheap
client pre-flight via `apiRepoOk(project)` (S0.5) so a misconfigured target fails at
click, not minutes in. **Cache the pre-flight per project** (a repo doesn't stop being a
repo; `api_repo_ok` shells out each call — review G8); treat `false` as a warning, not
necessarily a hard block (it also collapses "not a repo" and "git errored"). (Note:
S0.5 already delivered the `repoPath` param + `deps.ts` now uses `params.repoPath`, not
`process.cwd()`.)

---

## Part 2 — the builder UI

`apps/desktop/src/features/inspector/NewRunForm.tsx` becomes structured fields,
populated from **`apiCapabilitiesCached()`** (S0.5 — cached at app start so a live run's
held proc mutex never blocks the form's populate call; do NOT call the raw
`apiCapabilities` which routes through the mutex):

- **Primary (always visible):**
  - `issueRef` — text input (required; Run disabled until non-blank)
  - `transport` — `Combobox` from `capabilities().transports` (github / gitlab / linear)
  - `provider` — `Combobox` from `capabilities().providers`
  - `flow` — `Combobox` from `capabilities().flows` (label + name); today `default` /
    `plan` only
- **Advanced (`Collapsible`, collapsed by default):**
  - `maxTurns` — number, default `capabilities().defaults.maxTurns`
  - `baseBranch` — text, default `capabilities().defaults.baseBranch`
- **Command preview (read-only):** a collapsible "≈ command" line showing the
  composed `vanguard run …` string, for learning/debug. **Read-only** — no editable
  drop-to-`spawnRun` (cut per review G5: it's a divergent execution — PID-based, its own
  sandbox flags, and `command.ts` doesn't serialize `flow`/`transport` so the preview is
  approximate and switching mid-form loses fields). Label it "approximate." `spawnRun`
  and `command.ts` stay untouched for Fleet/watch. A dedicated raw-CLI mode can return
  later if asked.

> **UI kit (review F9):** `@/ui` exports **no `Select`** — use `Combobox` + `Collapsible`.
> Both are **compound namespaces** (base-ui), not single-prop components: `Combobox` =
> `{ Root, Control, Input, Trigger, Popup, List, Item, ItemIndicator, Value, … }`,
> `Collapsible` = `{ Root, Trigger, Panel }`. An enum select composes `Combobox.Root
> value/onValueChange` + mapped `Combobox.Item`s — more markup than a one-liner. The plan
> shows the exact composition.

**Client validation mirrors the FULL `validateCreateRun`** (S0), not just `issueRef`
— so a bad request never round-trips: disable Run when `issueRef`/`repoPath` blank,
`maxTurns` non-positive/non-integer, or `baseBranch` blank. The enum fields are
inherently valid (populated from `capabilities()`). The sidecar stays the source of
truth and still returns `bad-request` for anything the client misses.

On Run: `apiCreateRun({ issueRef, repoPath: project, transport, provider, flow,
maxTurns?, baseBranch? })`.

> **`command.ts` (review F10):** `runCommand` feeds the read-only preview only. Keep it
> as-is (Fleet/watch use `watchCommand`/`runPresets`); no serializer work (the preview is
> explicitly approximate). `command.test.ts` unchanged.

---

## Part 3 — live view from events

Consume S0.5's **run-id-tagged, buffered** event channel. Every `api:event` payload is
`{ runId, event: RunEvent }`. Render a structured run view:

- **runId comes from events, not the invoke return.** S0.5 emits `run-accepted`
  `{ runId, event: { type: 'run-accepted' } }` as the first `api:event` for a run — read
  the `runId` from it (or from `apiActiveRun()` on re-mount). `apiCreateRun` resolves
  only at run-end and is dead after a reload, so it is **not** the identity source.
- **Subscribe first, then re-attach.** On mount, `listen('api:event')` FIRST, then call
  `apiActiveRun()`; if a run is live, `apiRunBacklog(runId)` returns the buffered events
  (from `run-accepted` on) → apply them through a reducer **idempotent per stage index**
  so the backlog + live tail dedupe. Subscribing after fetching would drop the gap.
- Events: `run-accepted` (S0.5), `run-start` (taskId, flow, provider, stages),
  `stage-start` / `stage-end` (name, index, of, **`outcome` — a string**: `'completed'`
  or an `exitReason`, not a boolean), `cost` (usdSpent), and the terminal set
  `run-end` (prUrl? / secretBlocked?) | `run-error` (message) | `run-cancelled`.
- **Reducer = last-write-wins per key** (review G4 — do NOT sum). `cost` carries a
  **cumulative** `usdSpent` (confirmed `pipeline.ts:287` — `spentUsd + delta` then emits
  the total), so it's a singleton key: `usdSpent = event.usdSpent` (latest wins). Each
  stage is keyed by its `index`; the event is its value (`stage-start` then `stage-end`
  overwrite the same slot → phase = latest). The reducer **drops any payload whose
  `runId` ≠ the adopted run** so a prior run's buffered tail can't bleed in. With
  last-wins keys, backlog + live tail dedupe for free and replay is idempotent — no
  index/phase composite needed.
- **Structured strip (top):** stages as a progress row from `run-start.stages`
  (pending greyed ahead) — spinner on `stage-start` → resolved on `stage-end`, mapping
  the **`outcome` string** (`'completed'` → check; else ✗/warn). Live `usdSpent` from the
  `cost` key.
- **Terminal state is an EVENT** (S0.5's terminal guarantee — this is why it survives a
  reload; the invoke promise does not). Every run ends in exactly one of, and the strip
  renders each:
  - `run-end` + `prUrl` → PR link
  - `run-end` + `secretBlocked` → secret-blocked badge
  - `run-end` + neither → **"no PR (no changes)"** (not "still running")
  - `run-error` (message) → error render (covers issue-not-found, bad repo, missing
    creds, mid-run throw, sidecar crash — S0.5 synthesizes it)
  - `run-cancelled` → cancelled badge
  The reducer **owns** terminal state (review G6). The `apiCreateRun` promise
  settling is a secondary signal for the launching component only — it may clear the
  launching spinner / re-enable the Run button, but must **never write terminal state**
  (else a double-badge race). Rust guarantees a buffered terminal on every in-session
  path (`resolve_terminal` + `has_terminal`), so "promise rejects, no terminal" can't
  happen within a session.
- **Raw log (collapsible, below):** the existing `LaunchPanel` surface. **Kill** on the
  typed path calls `apiCancel()` (not `killRun` — a typed run has no PID; S0.5 signals
  the sidecar out-of-band).
- **Run lifecycle — ONE Inspector-level "typed run in flight" (review G1–G3).** Do NOT
  key rows by `runId`: it's unavailable at click (it arrives on the async `run-accepted`
  event *after* `apiCreateRun` fires), and session-based `active` rows carry no `runId`.
  The sidecar is single-in-flight, so there is only ever one typed run. Model it as a
  single nullable `typedRun` object at `Inspector` level:
  - On click, set `typedRun = { status: 'starting' }` **synchronously** and render the
    **strip as the content view** (the way `focusedSpawn`/`liveRun` already swap in — not
    a placeholder *row*). Adopt `runId` from the first `run-accepted`, `taskId` from
    `run-start`.
  - **Join to session `active` by `taskId`** (the only shared key): while `typedRun` is
    live, **filter its `taskId` out of the `active[]`** passed to `RunList`, so the same
    run never shows as both a strip and a session-based `LiveRun` row. After the terminal
    event it becomes a normal historical row.
  - **Second-run guard (correctness, not just UX):** the Run button is **disabled until
    `apiActiveRun()` resolves idle on mount/reload**, and the synchronous `typedRun`
    flag blocks a second click. A second `apiCreateRun` before the guard would overwrite
    the sidecar's `active` and corrupt re-attach — so S1 also adds a **server-side guard
    in Rust `api_create_run`**: if `active` is already `Some`, return an `{error}`
    envelope (busy) instead of minting + overwriting. (~3 lines; single-in-flight
    enforced on both sides.)
  - **In-memory / session-scoped (review G7):** the strip + backlog live in the
    sidecar's in-process state and the Inspector's `typedRun`. Across an **app restart**
    a typed run reverts to the session-file (`active`/historical `LiveRun`)
    representation — re-attach guarantees hold only within one app process. State this;
    don't imply cross-restart durability.

**Budget note:** the `cost` event carries only `usdSpent` (S0 dropped `usdCap` — the
run path is uncapped). The budget bar, if shown, reads `budgetUsd` from app config
(as the shipped `LiveRun` strip already does), not from the event.

---

## Back-compat & safety

- `spawnRun` / the raw-CLI path is **kept**, behind the escape-hatch toggle and for
  Fleet/watch — not removed.
- `apiCreateRun` runs the same Docker-sandboxed pipeline as the CLI — no new
  privilege path.
- CLI contract untouched (this is desktop + a `repoPath` param on the internal
  sidecar protocol, which is hidden/additive).

---

## Acceptance criteria

(The `repoPath` param / `deps.ts` change / event buffering / `api_cancel` are
**S0.5's** ACs — S1 consumes them.)

1. `NewRunForm` renders `Combobox` fields populated from a stubbed
   `apiCapabilities()`; Run is disabled until `issueRef` non-blank **and** `maxTurns`
   is a positive integer **and** `baseBranch` non-blank (component test — mirrors the
   full `validateCreateRun`, review F8).
2. Clicking Run calls `apiCreateRun` with the collected params including
   `repoPath = project` (mocked ipc; assert the payload). A `project` that isn't a git
   repo fails the client pre-flight before the call.
3. Event view, **stepped event-by-event** (review F11): `run-start` → the strip shows
   all `run-start.stages` (pending greyed); after one `stage-start` the matching stage
   shows a **spinner, not a check**; after its `stage-end` (outcome `'completed'`) it
   shows a check; `cost` updates the spend. Assert the intermediate spinner state, not
   only the terminal one.
4. Terminal matrix (event-sourced): drive the listener and assert — `run-end`+`prUrl`
   → PR link; `run-end`+neither → "no PR (no changes)"; `run-error` → error render;
   `run-cancelled` → cancelled badge. Terminal state reads from the **event**, so it
   holds after a simulated re-mount (re-attach via `apiRunBacklog`), not just live.
5. Run lifecycle (collapsed model): clicking Run sets a single Inspector `typedRun`
   synchronously and swaps in the strip as the content view; on re-mount, `apiActiveRun()`
   returning a live id + `apiRunBacklog` rebuilds the strip. A typed run's `taskId` is
   filtered out of the `active[]` given to `RunList` while live (no double surface). The
   Run button is disabled until `apiActiveRun()` resolves idle.
6. Second-run guard: `api_create_run` (Rust) returns a busy `{error}` when `active` is
   already set, instead of overwriting it (unit-testable at the Rust level via the state;
   at minimum assert the guard branch exists).
7. Read-only command preview renders the composed string; there is **no** editable
   drop-to-`spawnRun` (that path is cut). `spawnRun`/Fleet unchanged.
8. `pnpm typecheck`, `pnpm test`, desktop `tsc` + tests, `cargo build`/`clippy` green.

---

## Open (design pass during implementation)

- Exact strip visuals (chip vs stepper) — pick during build; the data contract
  (stages from `run-start`, transitions from `stage-start`/`stage-end`, last-wins
  reducer) is fixed.

## Out of scope

- Flow *authoring* / HCL (Subsystem 2); the builder only *selects* registered flows.
- The doc editor / transport create-side (Subsystem 3/4).
- Multi-run concurrency through the typed API (sidecar is single-in-flight; Fleet
  concurrency stays on the `watch` path).

---

## Key anchors

- S0/S0.5 core: `src/api/capabilities.ts` (`capabilities`, `FLOWS`, `TRANSPORTS`),
  `src/sidecar/sidecar.ts` (`CreateRunParams` incl. `repoPath`, `validateCreateRun`).
- Events: `src/pipeline/events.ts` (`RunEvent` — incl. `run-error`/`run-cancelled`;
  `run-accepted` is Rust-emitted, not in this union).
- Desktop ipc (all merged in S0.5): `apps/desktop/src/ipc.ts` — `apiCapabilitiesCached`,
  `apiCreateRun`, `apiActiveRun`, `apiRunBacklog`, `apiCancel`, `apiRepoOk`; events on
  the `api:event` channel as `{ runId, event }`.
- Desktop UI: `features/inspector/NewRunForm.tsx`, `Inspector.tsx` (`focusedSpawn` detail
  slot, `project`, `startRun`), `LaunchPanel.tsx`, `RunList.tsx` (the `spawns`/
  `onOpenSpawn` in-progress-row pattern to mirror for typed runs).
