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

Today the sidecar is a cwd-blind singleton and `productionDeps().createRun` uses
`process.cwd()` (`src/sidecar/deps.ts:50`) — wrong for a multi-project desktop. The
`repoPath` param (add to `CreateRunParams`, validate non-blank, use in `deps.ts`
instead of `process.cwd()`, thread into `RunIssueDeps.repoPath`) is **moved to
Subsystem 0.5** so a single subsystem owns the `deps.ts`/`sidecar.ts`/`ipc.ts`
changes (S0.5 also rewrites `deps.ts` for proxy handling — splitting the edits across
two subsystems would collide).

S1's only F6 responsibility: **the builder passes the current project
(`Inspector`'s `project`) as `repoPath`** in the `apiCreateRun` call, and a cheap
client pre-flight (is `project` a git repo?) so a misconfigured target fails at click,
not after minutes (S0.5 defines the pre-flight command).

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
- **Escape hatch:** an "Edit command" toggle reveals the composed `vanguard run …`
  string (read-only preview, or editable → falls back to the `spawnRun` path). This
  preserves the current textarea flow for power users and debugging.

> **UI kit (review F9):** `@/ui` exports **no `Select`** — use `Combobox` for the
> three enum fields and `Collapsible` for the Advanced section + the raw log. Adding a
> `Select` to the seam is optional; `Combobox` is the natural fit and scales as the
> provider list grows.

**Client validation mirrors the FULL `validateCreateRun`** (S0), not just `issueRef`
— so a bad request never round-trips: disable Run when `issueRef`/`repoPath` blank,
`maxTurns` non-positive/non-integer, or `baseBranch` blank. The enum fields are
inherently valid (populated from `capabilities()`). The sidecar stays the source of
truth and still returns `bad-request` for anything the client misses.

On Run: `apiCreateRun({ issueRef, repoPath: project, transport, provider, flow,
maxTurns?, baseBranch? })`.

> **`command.ts` role shift (review F10):** once the form composes the run from
> fields, `runCommand` becomes the escape-hatch *string composer* (read-only preview)
> rather than the primary input. Keep it (Fleet/watch still use `watchCommand`); its
> `command.test.ts` needs revisiting, not deleting. Note the composed string today
> omits `flow`/`transport`/sandbox flags — the escape-hatch preview is *approximate*
> unless a full `params → argv` serializer is written (defer; label the preview
> "approximate").

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
- **Structured strip (top):** stages as a progress row from `run-start.stages`
  (pending greyed ahead) — spinner on `stage-start` → resolved on `stage-end`, mapping
  the **`outcome` string** (`'completed'` → check; else ✗/warn). Live `usdSpent` from the
  latest `cost` (a step function — one per `stage-end`, not continuous).
- **Terminal state is an EVENT** (S0.5's terminal guarantee — this is why it survives a
  reload; the invoke promise does not). Every run ends in exactly one of, and the strip
  renders each:
  - `run-end` + `prUrl` → PR link
  - `run-end` + `secretBlocked` → secret-blocked badge
  - `run-end` + neither → **"no PR (no changes)"** (not "still running")
  - `run-error` (message) → error render (covers issue-not-found, bad repo, missing
    creds, mid-run throw, sidecar crash — S0.5 synthesizes it)
  - `run-cancelled` → cancelled badge
  The `apiCreateRun` promise result/rejection is a best-effort secondary signal for the
  launching component only; the event stream is the source of truth.
- **Raw log (collapsible, below):** the existing `LaunchPanel` surface. **Kill** on the
  typed path calls `apiCancel()` (not `killRun` — a typed run has no PID; S0.5 signals
  the sidecar out-of-band).
- **Run lifecycle (review F4 — the critical gap).** A typed run has no shipped
  in-progress row: `spawns` are PID-based, `active` is session-file-based and only
  appears once the runner writes session bytes (after sandbox spin-up + auth + first
  stage). S1's decision:
  - **Instant placeholder row** keyed by the run id (optimistic `active`-style entry)
    the moment `apiCreateRun` is called, reconciled/removed when the run appears in
    `active` or ends. No pre-session blind window.
  - **Re-attach:** clicking the row opens **this strip** (via S0.5's buffered replay),
    not the session-based `LiveRun`. One live surface for typed runs, resolving the
    "two views" ambiguity.
  - **Second concurrent typed run is disabled** in the UI while one is in flight (the
    sidecar is single-in-flight; a second `apiCreateRun` would block). Raw-CLI spawns
    are unaffected (separate processes).

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
5. Run lifecycle (review F4): launching a typed run adds an **instant placeholder row**
   keyed by run id; clicking an in-flight typed run opens the **event strip** (via
   S0.5 re-attach), not `LiveRun`; a second typed run is disabled while one is in
   flight.
6. The raw-CLI escape hatch still launches via `spawnRun` unchanged.
7. `pnpm typecheck`, `pnpm test`, desktop `tsc` + tests, `cargo build`/`clippy` green.

---

## Open (design pass during implementation)

- Exact strip visuals (chip vs stepper) — pick during build; the data contract
  (stages from `run-start`, transitions from `stage-start`/`stage-end`) is fixed.
- Whether the escape-hatch command is read-only preview or fully editable. Default:
  read-only preview + an "edit & run as command" button that drops to `spawnRun`.

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
