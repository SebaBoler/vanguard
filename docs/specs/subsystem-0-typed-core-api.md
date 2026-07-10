# Subsystem 0 — Typed Core API (Node sidecar)

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — ready for implementation plan
**Date:** 2026-07-10
**Depends on:** nothing (foundation). Subsystems 1–5 depend on this.

---

## Goal

Give the desktop app a **typed API** over Vanguard core so it stops shelling out
`sh -c "vanguard run …"` and scraping stdout. The API calls the *same* core
functions the CLI calls, accepts typed requests, and emits **structured events**
(stage lifecycle, cost, verdict) instead of text lines.

Non-goal: replacing the CLI. CLI and API are two mouths on one brain.

---

## Locked decisions

- **Transport: Node sidecar over stdio.** Tauri bundles core as a Node sidecar and
  talks newline-delimited JSON (JSON-RPC-ish) over stdin/stdout. No network port, no
  HTTP, no auth surface. Tauri owns the process lifecycle (spawn on app start, kill
  on exit). Rationale in the vision doc; short version: zero attack surface, native
  lifecycle, desktop is the only consumer today. A `vanguard serve` HTTP daemon can
  wrap the *same* API later if a second consumer appears — no rework, because both
  wrap the identical typed module.
- **CLI is additive-only.** No existing flag/subcommand renamed, removed, or changed.
  Sebastian's Actions build latest on every run.
- **The event seam is the load-bearing change.** Today progress is `console.log`
  inside `runSourcedIssue` (`summarizeOutcomes`) and there is **no emission hook** in
  the pipeline runner. This spec adds one.

---

## Architecture

```
apps/desktop (React)
   │  typed calls (ipc.ts)
   ▼
Tauri Rust (src-tauri)  ── spawns & supervises ──►  Node sidecar
   │  forwards JSON over stdio                          │
   └────────────◄── structured events ──────────────────┘
                                                         │ imports
                                                         ▼
                                            core: runSourcedIssue,
                                            assembleReviewPipeline,
                                            TaskFetcher, PROVIDER_NAMES
```

Three new pieces + one core seam:

1. **Core: event-emission seam** (`src/`). An optional `onEvent?: (e: RunEvent) =>
   void` threaded through `runStages` / `runBudgetedStages` and `runSourcedIssue`.
   When absent (CLI path), behavior is byte-for-byte unchanged — existing
   `console.log` stays. When present (sidecar path), the runner emits structured
   events at stage boundaries, on cost updates, and on verdict.
2. **Core: capability surface** (`src/api/` new). Pure functions returning the data
   the run builder (Subsystem 1) renders from: provider names (`PROVIDER_NAMES`),
   flow names, transport names, `RunOptions` defaults.
3. **Sidecar entry** (`src/sidecar/` new, or a `vanguard __sidecar` hidden
   subcommand). A stdio JSON loop: read request → call the typed API → stream events
   + final result back. Not a documented CLI command (double-underscore / hidden), so
   it is not part of the frozen contract.
4. **Desktop: sidecar client** (`apps/desktop/src/ipc.ts` + `src-tauri`). Tauri
   sidecar config, a Rust supervisor that pipes stdio, and TS wrappers replacing the
   `spawnRun`/stdout-parse path for structured needs.

---

## The event seam (core change, detail)

Today (`src/runners/source-adapter.ts`): `const outcomes = await runStages(ctx,
pipeline, {…}); console.log(summarizeOutcomes(outcomes));`. Stages run inside
`runBudgetedStages` (`src/pipeline/pipeline.ts:219`) with no progress callback.

Add an **optional** `onEvent` to the runner opts and to `RunIssueDeps`. Thread it
into `runBudgetedStages` so it fires:

- `run-start` — `{ taskId, flow, provider, stages: StageName[] }`
- `stage-start` / `stage-end` — `{ name: StageName, index, of, outcome? }`
- `cost` — `{ usdSpent, usdCap }` (the runner already tracks a cumulative USD cap)
- `verdict` — reviewer/adversary structured `<findings>` already emitted as text
  today; parse once, emit typed
- `run-end` — `{ prUrl?, secretBlocked?, partial?, reason? }` (mirrors
  `RunIssueResult`)

```ts
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: StageName[] }
  | { type: 'stage-start'; name: StageName; index: number; of: number }
  | { type: 'stage-end'; name: StageName; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number; usdCap: number }
  | { type: 'verdict'; stage: StageName; findings: Finding[] }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean; partial?: boolean; reason?: string };
```

**Back-compat invariant:** `onEvent === undefined` ⇒ zero behavioral change; all
current `console.log` output preserved. The sidecar passes `onEvent`; the CLI does
not (or the CLI opts in later, separately — out of scope here).

---

## Sidecar protocol (stdio, newline-delimited JSON)

Request (Rust → sidecar, one JSON object per line):

```json
{ "id": "r1", "method": "createRun", "params": { "issueRef": "gh-42", "flow": "default", "provider": "claude", "maxTurns": 30 } }
```

Responses (sidecar → Rust, one per line, correlated by `id`):

```json
{ "id": "r1", "event": { "type": "stage-start", "name": "implementer", "index": 0, "of": 3 } }
{ "id": "r1", "event": { "type": "cost", "usdSpent": 0.42, "usdCap": 5 } }
{ "id": "r1", "result": { "prUrl": "https://github.com/...", "partial": false } }
{ "id": "r1", "error": { "message": "...", "kind": "budget|secret-block|fetch|internal" } }
```

Methods for v0:
- `capabilities()` → `{ providers: string[], flows: FlowInfo[], transports: string[], defaults: RunOptionsDefaults }`
- `createRun(params)` → streams events, ends with `result` or `error`
- `cancelRun({ id })` → cooperative cancel (maps to sandbox teardown)

`params` for `createRun` is a **typed projection of `RunOptions` + issueRef +
transport**, not a CLI string. The sidecar maps it to `RunIssueDeps` and dispatches
to the same per-source runner the CLI uses.

---

## Capability surface (core, `src/api/`)

```ts
export function capabilities(): Capabilities;
// providers: PROVIDER_NAMES (src/agents/registry.ts:159)
// flows:     flow-name registry (see below)
// transports: ['github','gitlab','linear']  (the SourceAdapter set)
// defaults:  the documented RunOptions defaults (maxTurns 30, cap $5, base 'main', …)
```

**Flow-name registry (new, minimal).** Today the three flow builders
(`implementReviewSimplifyStages`, `planImplementReviewStages`,
`planImplementAdversaryStages`) are exported functions with **no name table**. Add a
small `FLOWS: Record<string, { label: string; build: () => PipelineStage[] }>`
seam owned here. v0 registers what exists (`default`, `plan`). Subsystem 2 populates
`A` / `B` (HCL-loaded). This is the name registry `--flow` and the UI dropdown read
from — keep it tiny; do not build the HCL loader here.

---

## Desktop side

- `src-tauri`: add the sidecar to `tauri.conf.json` `externalBin`; a supervisor
  module spawns it, forwards line-JSON both ways, exposes `invoke`-able commands
  (`api_capabilities`, `api_create_run`, `api_cancel_run`) and re-emits sidecar
  events as Tauri events (same pattern as today's `spawn:output`).
- `apps/desktop/src/ipc.ts`: typed wrappers returning structured results/event
  streams. The existing `spawnRun` stdout path **stays** for the raw-CLI escape hatch
  and for `vanguard watch` (Fleet) — do not rip it out.

---

## Back-compat & safety

- CLI unchanged; `command.ts` string builders untouched.
- `onEvent` optional ⇒ CLI runs identically.
- Sidecar entry is hidden (`__sidecar`), not a public subcommand.
- No network surface (stdio only).
- Sidecar runs the **same** Docker-sandboxed pipeline — no new privilege path; it is
  a caller of `runSourcedIssue`, not a reimplementation.

---

## Acceptance criteria

1. `capabilities()` returns real provider/flow/transport lists + defaults; unit test
   asserts providers === `PROVIDER_NAMES` and flows include `default`.
2. `runSourcedIssue` with `onEvent` undefined produces byte-identical stdout to today
   (regression test around `summarizeOutcomes` path).
3. `runSourcedIssue` with `onEvent` set emits `run-start` … `run-end` in order, with
   at least one `stage-start`/`stage-end` pair per pipeline stage and a terminal
   `run-end` mirroring `RunIssueResult`. Unit test with a stubbed pipeline.
4. Sidecar loop: given a `createRun` request against a `<synthetic>` provider, emits
   correlated event lines then a `result` line; a malformed request yields an `error`
   line, not a crash. Test drives the loop with piped stdin/stdout.
5. Desktop: `api_capabilities` populates a structured object (no stdout parsing) —
   smoke test via the Tauri command.
6. `pnpm typecheck` + `pnpm test` green.

---

## Out of scope (own specs)

- Run builder UI (Subsystem 1) — consumes `capabilities()`.
- HCL flow loading + Flow A/B + human review gate (Subsystem 2).
- Doc editor, transport create-side, visual editor (3–5).
- `vanguard serve` HTTP daemon (later, if a non-desktop consumer appears).
- Migrating the CLI itself to emit structured events (separate, additive).

---

## Key anchors

- `src/runners/source-adapter.ts`: `runSourcedIssue:213`, `RunOptions:38`,
  `RunIssueDeps:103`, `RunIssueResult:164`, `console.log(summarizeOutcomes):~295`
- `src/pipeline/pipeline.ts`: `runBudgetedStages:219`, `runStages:389`, `STAGE:17`,
  flow builders `:452 / :702 / :826`
- `src/agents/registry.ts`: `PROVIDER_NAMES:159`
- Desktop: `apps/desktop/src/ipc.ts`, `apps/desktop/src-tauri/src/spawn.rs`,
  `NewRunForm.tsx`
