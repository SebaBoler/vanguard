# Subsystem 0.5 — Sidecar Hardening

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — ready for implementation plan
**Date:** 2026-07-11
**Depends on:** Subsystem 0 (shipped). **Blocks:** Subsystem 1.

---

## Why

Three independent reviews of the Subsystem 1 spec (two local adversarial + glm-5.2)
converged: the typed `apiCreateRun` path rests on a sidecar Subsystem 0 shipped
**deliberately minimal**. Building a real run UI on it hits five gaps. This subsystem
closes them so S1 consumes a solid foundation instead of re-solving infrastructure.

The five gaps (review IDs G1–G6/F4 in the S1 review set):

1. **Blocking capabilities (G1).** `sidecar.rs::request()` holds the process mutex for
   a whole run (minutes). `api_capabilities` takes the same mutex → the New Run form
   silently never populates during any run.
2. **No cancel (G2).** `killRun` is PID-based; a typed run has no PID and there is no
   `cancelRun` method (S0 cut it). "Kill" is structurally impossible on the typed path.
3. **Lost/unreattachable runs (G3/F4).** `invoke('api_create_run')` resolves at
   run-end; events stream on a separate global channel. Nav-away/reload kills the
   promise + listener but the Rust thread keeps running under the mutex → result lost,
   no re-attach.
4. **No event correlation (G4).** Rust emits `api:event` globally as `{id:"run", event}`
   — `id` is the literal `"run"`, and only `run-start` carries `taskId`. No per-run key.
5. **Provider proxy mismatch (G6).** `deps.ts` hardcodes `egress:true/llmProxy:false`;
   proxy-requiring providers (zai/openrouter) fail. The provider select advertises
   providers the typed path can't run.

Plus **F6** (the `repoPath` param) is pulled here — it shares the `deps.ts`/
`sidecar.ts`/`ipc.ts` surface this subsystem rewrites, so one subsystem owns those edits.

---

## Locked decisions

- **Re-attach = buffer + replay (full fidelity).** Rust buffers each run's events keyed
  by run id; a re-attach command replays the backlog so a renavigated/reloaded strip
  rebuilds the exact stage view. Survives nav + webview reload. (Not the cheap
  ephemeral→`LiveRun` fallback.)
- **Provider handling = interim gate.** `capabilities().providers` returns only the
  providers the typed path runs today (proxy-less). zai/openrouter stay CLI-escape-hatch
  until **Subsystem 6 (custom providers)**, which supersedes this gate with per-provider
  config. Do NOT build proxy plumbing here.
- **Multi-run stays single-in-flight.** The sidecar runs one typed run at a time; the
  fix is non-*blocking capabilities* + a UI guard (S1), not concurrent runs. Fleet
  concurrency stays on the `watch` path.

---

## Part A — Run identity + event correlation

A run gets an id the moment it starts; every event carries it.

- The sidecar mints a `runId` per `createRun` (a monotonic counter is enough —
  `Math.random`/`Date.now` are unavailable in some contexts, so use an incrementing
  integer stringified, e.g. `run-1`, seeded from a module counter).
- `apiCreateRun` **returns `{ runId }` immediately** is NOT possible under the current
  request/response model (the call resolves at run-end). Instead: the sidecar's first
  emitted line for a `createRun` is a `run-accepted` control message
  `{ id, runId }` — the desktop reads it synchronously to key the strip, before any
  `RunEvent`. (The Tauri `api_create_run` command returns the `runId` from that first
  line, then keeps streaming events + finally the result.)
- Every `api:event` payload becomes `{ runId, event: RunEvent }` (replacing the
  `{id:"run", event}` envelope). The frontend routes by `runId`.

**Core change:** thread a `runId` into `RunIssueDeps` (or generate in the sidecar and
pass to `onEvent` wrapping) so each `onEvent` emission is tagged. Simplest: the sidecar
owns the id and wraps `onEvent` — `onEvent: (e) => emit({ runId, event: e })` — no core
change needed beyond what S0 already threads.

---

## Part B — Event buffer + re-attach

- **Rust:** a per-run ring buffer `Map<runId, Vec<Value>>` (bounded — keep last N, e.g.
  2000 events; a run has ~dozens, N is a crash guard). Every event line is appended
  before it is emitted. On terminal (`run-end`/error), keep the buffer until the client
  acknowledges or a new run evicts it (retain last M completed runs, e.g. 4).
- **New command `api_run_backlog(runId)`** → returns the buffered events for a run so a
  freshly-mounted strip replays them, then subscribes to `api:event` for the tail. (Ordering:
  backlog + live may race; dedupe by event index/`stage-end` idempotence, or gate live
  events until backlog is applied — the strip's reducer is idempotent per stage index.)
- **New command `api_active_run()`** → returns the currently in-flight `runId` (or none),
  so the desktop can show/re-open it after reload.

---

## Part C — Non-blocking capabilities

`capabilities()` is a **pure function** — it must not route through the run-holding
mutex.

- Preferred: the desktop **caches** `capabilities()` at app start (call once, store in
  a context/atom). It never changes during a session. This alone removes the block for
  the S1 form.
- Belt-and-suspenders (Rust): serve `api_capabilities` without taking the run mutex —
  either a separate short-lived `vanguard __sidecar` invocation for the pure call, or a
  dedicated non-mutexed request path. Given the frontend cache, the pure-call-on-demand
  is optional; **the cache is the required fix**, the Rust path is nice-to-have.

---

## Part D — Cancellation

The pipeline already accepts an `AbortSignal` (`RunStagesOptions.signal`,
`pipeline.ts:154`, threaded into `runAgent` at `:272/:311`). Wire it end-to-end:

- Add `signal?: AbortSignal` to `RunIssueDeps`; `runSourcedIssue` passes it into the
  `runStages` opts (alongside the existing `onEvent`). The sandbox `finally` already
  calls `ctx.destroy()`, so an aborted run tears down its sandbox.
- **Sidecar:** own an `AbortController` per run; a new `cancelRun` method aborts it.
- **New sidecar method `cancelRun({ runId })`** → aborts that run's controller → the
  pipeline stops, `ctx.destroy()` runs, `createRun` returns/throws a terminal
  `run-end`-style outcome (`{ cancelled: true }`).
- **New Tauri command `api_cancel(runId)`** → sends `cancelRun`. The desktop's typed-run
  Kill button calls this (not `killRun`).

---

## Part E — `repoPath` param (F6)

- Add `repoPath: string` to `CreateRunParams` (`src/sidecar/sidecar.ts`) + the desktop
  mirror (`apps/desktop/src/ipc.ts`).
- `validateCreateRun` requires `repoPath` non-blank (same shape as `issueRef`).
- `deps.ts` uses `params.repoPath` instead of `process.cwd()` (`deps.ts:50`); it threads
  into the runner's existing `RunIssueDeps.repoPath`.
- **Rewrite the misleading `deps.ts:40-41` comment** — it claims the child cwd is the
  project dir "spawned per spawn.rs", true for the raw-CLI path, false for the sidecar
  (which inherits the app cwd). Say why `repoPath` must be explicit.
- **Pre-flight command** (for S1's click-time check): `api_repo_ok(repoPath)` → cheap
  "is this a git repo with a remote" check, so a misconfigured project fails at click
  not after minutes. (Rust: `git -C <path> rev-parse` + remote check.)

---

## Part F — Provider gate (interim)

`capabilities().providers` returns only providers the typed path runs under the current
`deps.ts` sandbox wiring (`egress:true, llmProxy:false`): the direct/OAuth providers
(**claude, codex, cursor, meridian**), **not** the proxy-riding ones (**zai,
openrouter**), which need the LLM-proxy sidecar `deps.ts` doesn't wire.

- Derive the gate from a provider property, not a hand-list: `PROVIDERS` already
  encodes proxy behavior (`proxyKey`, the direct-only/anthropic-owning flags in
  `registry.ts`). Add or reuse a `runnableWithoutProxy` predicate so the list stays
  correct as providers change.
- **Mark it clearly interim** in code + spec: Subsystem 6 replaces the gate with
  user-configured custom providers (endpoint + key + proxy per provider).
- `PROVIDER_NAMES` (the full list) stays unchanged for the CLI — the gate is a
  capability-surface filter only, not a registry change.

---

## Back-compat & safety

- CLI untouched (all changes are the hidden sidecar protocol + desktop + additive core
  fields). `PROVIDER_NAMES` unchanged.
- `onEvent === undefined` still ⇒ byte-identical CLI (Part A/D only add fields the CLI
  never sets).
- Same Docker-sandboxed pipeline; cancel uses the existing `ctx.destroy()` teardown —
  no new privilege path.
- Single-in-flight preserved; this subsystem does not add concurrent runs.

---

## Acceptance criteria

1. **Correlation:** a `createRun` emits a first `run-accepted` line carrying a `runId`;
   every subsequent `api:event` payload is `{ runId, event }`. Two sequential runs get
   distinct ids (sidecar unit test driving the loop).
2. **Buffer/replay:** after N events for a run, `api_run_backlog(runId)` returns those N
   in order; `api_active_run()` returns the in-flight id, none when idle (sidecar test).
3. **Capabilities non-blocking:** the desktop caches `capabilities()` at start;
   `apiCapabilities()` resolves without a running sidecar exchange (desktop test with a
   stubbed cache; assert no dependency on an in-flight run).
4. **Cancel:** `cancelRun({ runId })` aborts the run — the pipeline receives the abort,
   `ctx.destroy()` is called, `createRun` resolves a cancelled outcome (core/sidecar
   test with a stub runner that observes the signal).
5. **repoPath:** `validateCreateRun` rejects blank/missing `repoPath` as `bad-request`;
   `deps.ts` uses `params.repoPath`; the misleading comment is rewritten (unit test +
   grep the comment).
6. **Provider gate:** `capabilities().providers` excludes zai/openrouter, includes
   claude/codex/cursor/meridian, derived from a predicate not a literal list; a code
   comment marks it interim → Subsystem 6 (unit test asserting the set).
7. `pnpm typecheck`, `pnpm test`, desktop `tsc` + tests, `cargo build`/`clippy` green.

---

## Out of scope

- Custom providers / proxy config (Subsystem 6 — supersedes the Part F gate).
- Concurrent typed runs (stays single-in-flight).
- The structured builder UI + live strip (Subsystem 1 — consumes A–F).
- HCL flow dispatch (Subsystem 2).

---

## Key anchors

- Sidecar: `apps/desktop/src-tauri/src/sidecar.rs` (`request` mutex, global emit,
  `{id,event}` envelope), `src/sidecar/sidecar.ts` (`runSidecar`, `validateCreateRun`,
  `CreateRunParams`), `src/sidecar/deps.ts` (`productionDeps`, `process.cwd():50`,
  hardcoded `egress/llmProxy`, misleading comment `:40-41`).
- Cancel: `src/pipeline/pipeline.ts:154` (`signal`), `:272/:311` (threaded),
  `src/sandbox/sandbox-context.ts` (`startSandboxContext`, `destroy`).
- Providers: `src/agents/registry.ts` (`PROVIDERS`, `PROVIDER_NAMES`, proxy flags).
- Events: `src/pipeline/events.ts` (`RunEvent`); `src/runners/source-adapter.ts`
  (`RunIssueDeps`, `runSourcedIssue`, `onEvent` emission sites).
- Desktop: `apps/desktop/src/ipc.ts` (`apiCapabilities`/`apiCreateRun`, `api:event`),
  `apps/desktop/src-tauri/src/lib.rs` (command registration).
