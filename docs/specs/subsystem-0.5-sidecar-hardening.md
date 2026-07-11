# Subsystem 0.5 — Sidecar Hardening

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — ready for implementation plan (revised per two spec reviews)
**Date:** 2026-07-11
**Depends on:** Subsystem 0 (shipped). **Blocks:** Subsystem 1.

---

## Why

Three reviews of the Subsystem 1 spec found the typed `apiCreateRun` path rests on a
sidecar Subsystem 0 shipped deliberately minimal. Two further reviews of *this* spec's
first draft found the naïve "just add methods" approach doesn't work against the
sidecar's concurrency model, and that one motivating premise was factually wrong. This
revision folds both.

The real gaps a run UI hits:

1. **Blocking capabilities (G1).** `sidecar.rs::request()` holds the process mutex for
   a whole run (minutes); `api_capabilities` takes the same mutex → the New Run form
   silently never populates during a run.
2. **No cancel (G2).** `killRun` is PID-based; a typed run has no PID and there is no
   cancel path. A wrong/expensive run can't be stopped.
3. **Lost/unreattachable runs (G3).** `invoke('api_create_run')` resolves at run-end;
   events stream on a separate global channel. Nav-away/reload kills the promise +
   listener but the Rust thread runs on → result lost, no re-attach.
4. **No event correlation (G4).** Rust emits `api:event` globally as `{id:"run", event}`;
   only `run-start` carries `taskId`. No per-run key.

Plus **F6** (the `repoPath` param) is pulled here — it shares the `deps.ts`/`sidecar.ts`
surface this subsystem rewrites.

**Dropped from the first draft — the provider gate.** The first draft added a gate
excluding zai/openrouter from the typed path on the belief they "need `--llm-proxy` and
fail." **Both reviews confirmed this is false:** under `deps.ts`'s `egress:true,
llmProxy:false`, zai/openrouter run in direct mode — their hosts (`api.z.ai`,
`openrouter.ai`) are in `DEFAULT_EGRESS_ALLOWLIST` and their keys are injected into the
sandbox normally. `--llm-proxy` is a *security* feature (keeps the key out of the
sandbox), not a runnability requirement. So there is **no gate to build**; every
built-in provider is surfaced. (Pre-existing egress-allowlist gaps for meridian's LAN
address and cursor's host affect the CLI too and are out of scope. Custom providers are
Subsystem 6, motivated by user-supplied endpoints — not by any built-in "failing.")

---

## Concurrency model (read first — everything below obeys this)

The sidecar is **one Node process, one stdio pipe, one Rust mutex**, and
`runSidecar`'s `for await (const line of input)` does `await deps.createRun(...)`
**inline** — it does not read the next stdin line until the current run finishes. Three
invariants fall out, and every part below respects them:

1. **In-band mid-run control is impossible, by design.** A `cancelRun` *stdio message*
   would queue behind the running request on the mutex (Rust) and sit unread until the
   run completes (Node's inline await). **Cancel is therefore out-of-band** — an OS
   signal to the sidecar child, not a protocol message. The sequential read loop stays
   as-is.
2. **Run identity and terminal outcome travel as EVENTS, never as the `invoke`
   return.** A `#[tauri::command]` resolves its `invoke()` promise exactly once (at
   run-end) and is dead after a webview reload. So the `runId` is emitted as the first
   `api:event` line, and the terminal result (`prUrl` / error / cancelled) is emitted
   as a terminal event. The command's return value is best-effort and never relied on.
3. **The event buffer + active-run id live behind a SEPARATE Rust lock** from the
   proc-pipe mutex. Re-attach happens *while the run is still in flight* (run = minutes,
   reload = instant), so `api_run_backlog` must read concurrently with a held proc
   mutex. Sync Tauri commands run on the thread pool, so a second lock is genuinely
   concurrent.

Net architectural change: an out-of-band cancel signal, a second Rust lock for the
buffer, events-as-identity/result. **No per-run processes, no second duplex channel.**

---

## Part A — Run identity + event correlation

- **Rust mints the `runId`** (it owns the buffer and outlives Node respawn; a
  Node-side counter resets to `run-1` on respawn and collides with a retained buffer
  entry). A per-sidecar-session counter in Rust (`run-1`, `run-2`, …) — deterministic,
  no `Math.random`/`Date.now`.
- `api_create_run` (Rust) generates the `runId` before writing the request, records it
  as the active run, and **emits a first `api:event` `{ runId, event: { type:
  'run-accepted' } }`** so the frontend can key its strip immediately. It then streams
  each event line as `{ runId, event }` (replacing the `{id:"run", event}` envelope).
- The frontend routes every `api:event` by `runId`. Single-in-flight means there is
  only ever one active `runId`, but tagging is required for buffer keying + reload.

> The `run-accepted` line is emitted from **Rust** (not Node) — Rust already knows the
> run started when it writes the request. Emitting it from Rust avoids colliding with
> `request()`'s line discriminator (a non-`event` stdio line is treated as the terminal
> result and breaks the read loop). Rust emits it straight to the `api:event` channel,
> never through the stdio read loop.

---

## Part B — Event buffer + re-attach

- **Rust state:** `Sidecar { proc: Mutex<Option<SidecarProc>>, buffer: Mutex<RunBuffer>,
  active: Mutex<Option<String>> }`. The `buffer`/`active` locks are **separate** from
  `proc` so they're readable during a run.
- The `on_event` closure in `api_create_run` briefly locks `buffer` and appends each
  event under `runId` (bounded ring, keep last N≈2000 per run — a run has ~dozens; N is
  a crash guard). Retain the last M≈4 completed runs, evict oldest.
- **`api_run_backlog(runId)`** → returns the buffered events for a run (locks `buffer`
  only). **`api_active_run()`** → returns the active `runId` or none (locks `active`
  only). Both work during a run.
- **Terminal-event guarantee:** every run appends **exactly one** terminal event to its
  buffer — `run-end` (success/secret-block/no-changes), an **error event** (mid-run
  throw — today `runSourcedIssue` emits nothing on a throw, and the `{id,error}`
  envelope isn't an event, so Rust must synthesize a terminal `{ type: 'run-error',
  message }` event when `request()` returns an error or the child dies), or
  `run-cancelled`. Without this, re-attach shows a failed run stuck mid-stage forever.
  `active` is cleared on the terminal event.
- **Re-attach ordering (frontend):** **subscribe to `api:event` first, then** call
  `api_run_backlog`, then apply backlog + tail with a reducer that is **idempotent per
  stage index** (dedupes the overlap). Subscribing after fetching would drop events
  emitted in the gap.

---

## Part C — Non-blocking capabilities

`capabilities()` is a **pure, deterministic function** (`src/api/capabilities.ts` —
static providers/flows/transports/defaults, no I/O). The fix is frontend-side:

- The desktop **caches `capabilities()` once at app start** (context/atom); it never
  changes in a session. This alone removes the form-open block — no mutex involved.
- A Rust non-mutexed capabilities path is **not needed** (the cache covers it); omit it.

---

## Part D — Cancellation (out-of-band)

The pipeline already accepts an `AbortSignal` (`RunStagesOptions.signal`,
`pipeline.ts:154`, honored through `runAgent` → `agent.run`). Wire it, driven by a
signal not a message:

- **Core/Node:** add `signal?: AbortSignal` to `RunIssueDeps`; `runSourcedIssue` passes
  it into the `runStages` opts (alongside `onEvent`). The **`AbortController` is owned
  in `deps.ts`'s `createRun`** — that's where `startSandboxContext` + the `ctx.destroy()`
  `finally` live (not in `runSourcedIssue`), so an abort there tears down the sandbox.
- **Sidecar (Node):** hold a module-level "current run" `AbortController`. Install an OS
  signal handler (`SIGUSR1`) that **aborts the controller but does NOT exit** (the loop
  stays alive for reuse). On abort, `createRun` rejects/resolves and Rust synthesizes a
  terminal `run-cancelled` event (Part B).
- **Rust:** `api_cancel()` sends `SIGUSR1` to `SidecarProc.child` (Rust already holds
  the child handle at `sidecar.rs:14`). Single-in-flight ⇒ no `runId` routing needed to
  pick the target. This bypasses both the proc mutex and the inline-await loop.
- **Desktop:** the typed-run Kill button calls `api_cancel` (not `killRun`).

---

## Part E — `repoPath` param (F6)

- Add `repoPath: string` to `CreateRunParams` (`src/sidecar/sidecar.ts`) + the desktop
  mirror (`apps/desktop/src/ipc.ts`).
- `validateCreateRun` requires `repoPath` non-blank (same shape as `issueRef`).
- `deps.ts` uses `params.repoPath` instead of `process.cwd()` (`deps.ts:50`); it threads
  into the runner's existing `RunIssueDeps.repoPath` (used at `source-adapter.ts:260`
  etc.).
- **Rewrite the misleading `deps.ts:40-42` comment** — it claims the child cwd is the
  project dir "spawned per `spawn.rs`", true for the raw-CLI path, false for the sidecar
  (spawned in `sidecar.rs:28-30` via `sh -c 'exec vanguard __sidecar'` with **no**
  `.current_dir()` → inherits the app cwd). Say why `repoPath` must be explicit.
- **Pre-flight `api_repo_ok(repoPath)`** (for S1's click-time check): `git -C <path>
  rev-parse` + remote check, so a misconfigured project fails at click, not minutes in.

---

## Back-compat & safety

- CLI untouched (all changes are the hidden sidecar protocol + desktop + additive core
  fields). `PROVIDER_NAMES` unchanged; no provider is hidden from anything.
- `onEvent === undefined` still ⇒ byte-identical CLI (new fields the CLI never sets).
- Same Docker-sandboxed pipeline; cancel uses the existing `ctx.destroy()` teardown —
  no new privilege path. The `SIGUSR1` handler is sidecar-only.
- Single-in-flight preserved; no concurrent runs added.

---

## Acceptance criteria

1. **Correlation (Part A):** a `createRun` causes Rust to emit a first `api:event`
   `{ runId, event: run-accepted }`, then every event as `{ runId, event }`; two
   sequential runs get distinct ids (Rust unit test / sidecar integration test).
2. **Buffer/replay (Part B):** during a run, `api_run_backlog(runId)` returns the events
   so far in order and `api_active_run()` returns the id — both **while the proc mutex is
   held** (a test proving no deadlock, e.g. a stubbed long run + concurrent backlog call).
   When idle, `api_active_run()` returns none.
3. **Terminal guarantee (Part B):** every run appends exactly one terminal event
   (`run-end` | `run-error` | `run-cancelled`) to its buffer; a run whose `createRun`
   throws still yields a `run-error` terminal (test with a stub deps that throws).
4. **Capabilities non-blocking (Part C):** the desktop caches `capabilities()` at start;
   the form reads the cache with no sidecar call during a run (desktop test).
5. **Cancel (Part D):** `api_cancel` → `SIGUSR1` → the module `AbortController` aborts →
   the pipeline receives the abort → `ctx.destroy()` runs → a `run-cancelled` terminal
   event is emitted and `active` cleared (core/sidecar test observing the signal; the
   sidecar process stays alive for a subsequent run).
6. **repoPath (Part E):** `validateCreateRun` rejects blank/missing `repoPath` as
   `bad-request`; `deps.ts` uses `params.repoPath`; the misleading comment is rewritten
   (unit test + grep). `api_repo_ok` returns false for a non-repo path.
7. `pnpm typecheck`, `pnpm test`, desktop `tsc` + tests, `cargo build`/`clippy` green.

---

## Out of scope

- Custom providers / proxy config (Subsystem 6).
- Concurrent typed runs (stays single-in-flight).
- The structured builder UI + live strip (Subsystem 1 — consumes A–E).
- HCL flow dispatch (Subsystem 2).
- Fixing meridian/cursor egress-allowlist gaps (pre-existing, affects the CLI; not
  introduced here).

---

## Key anchors

- Sidecar: `apps/desktop/src-tauri/src/sidecar.rs` (`request` mutex `:53`, global emit
  `:106-108`, `{id,event}` envelope, child handle `:14`, respawn-on-EOF `:78-80`),
  `src/sidecar/sidecar.ts` (`runSidecar` `:72`, inline `await` `:94`, `validateCreateRun`
  `:46`, `CreateRunParams` `:11`), `src/sidecar/deps.ts` (`productionDeps` `:44`,
  `process.cwd():50`, hardcoded `egress/llmProxy` `:53-54`, `startSandboxContext` +
  `ctx.destroy()` finally `:52/:83-85`, misleading comment `:40-42`).
- Cancel: `src/pipeline/pipeline.ts:154` (`signal`), honored via `runAgent`
  (`src/core/vanguard.ts:238-261`, `AbortSignal.any`); `src/sandbox/sandbox-context.ts`
  (`startSandboxContext:52`, `destroy`).
- Providers (context only — no gate): `src/agents/registry.ts` (`PROVIDERS`), egress via
  `src/sandbox/egress-allow.mjs`.
- Events: `src/pipeline/events.ts` (`RunEvent`); `src/runners/source-adapter.ts`
  (`RunIssueDeps:104`, `runSourcedIssue:213`, `onEvent` sites `:284,:299,:383,:399,:454`).
- Desktop: `apps/desktop/src/ipc.ts` (`apiCapabilities:109`/`apiCreateRun:113`,
  `api:event`), `apps/desktop/src-tauri/src/lib.rs` (`generate_handler!:131`).
