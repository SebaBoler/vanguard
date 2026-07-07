# Vanguard Desktop — Design Proposal

> **Status:** Draft for discussion. Author: Paweł. Owner sign-off required: Sebastian.
> **Purpose:** A local desktop app to *watch, inspect, and drive* Vanguard runs — a Conductor-style
> cockpit over the orchestrator that already exists. This document is a proposal to agree scope
> before any implementation, and to give the (separate) API epic a concrete target to aim at.

---

## 1. Motivation

Vanguard is a headless orchestrator: it isolates work in git worktrees, runs a fleet of agents with
bounded concurrency, claims tasks off a provider board (GitLab / GitHub / Linear labels), gates every
run behind a proof-of-work command, and writes all of its state to `.vanguard/` on disk.

Two working styles exist today:

- **Sebastian** — fully automated. Specs are filed as issues; a cloud runner on GitLab picks them up
  and drives Vanguard unattended. No UI wanted; the pipeline is the product.
- **Paweł** — local, hands-on. Runs Vanguard locally with cloud orchestration (at least one cloud
  runner administers specs one by one and uses Vanguard as a parallel sub-agent substitute), and
  *wants to watch it happen* — see the fleet, read the run traces, inspect failures directly.

The immediate pain: **inspecting a run today is hard.** The traces in `.vanguard/runs/` are raw JSON;
diagnosing why a run failed (e.g. a frozen-lockfile verify error) currently means either reading JSON
by hand or tasking an LLM to summarise it. A throwaway HTML preview of one task's runs already proved
the data is all there and renders readably — this proposal turns that throwaway into a real product.

**This is an upgrade, not a rewrite.** We do not intend to touch Vanguard's internals, except possibly
to introduce an API — and that is deliberately carved out into its own epic (see §8).

---

## 2. Tech stack & patterns we reuse

The desktop shell follows a proven Tauri 2 architecture already shipping in another app of ours —
Rust domain/supervisor core, React presentation, typed JSON over IPC as the only boundary:

| Layer | Tech | Responsibility |
|---|---|---|
| Presentation | React 19 · Vite · Tailwind v4 · **chunks-ui** · zustand | Screens, forms, state. Touches no process. |
| Board / tables | **TanStack Table** (`@tanstack/react-table`) | Task board / list rendering. |
| Routing | `react-router` `MemoryRouter` + a shell layout + feature-sliced `features/<name>` | Convention-based screen composition. |
| IPC | Tauri v2 commands + events | Typed request/response and push. |
| Backend | **Rust** (`src-tauri/`) | Process supervision, filesystem watching, typed JSON over IPC. |

Concretely reused as patterns: a `ShellLayout` + Tauri-guard wrapper + `features/<name>` slice layout,
`components/atoms` chunks-ui wrappers (Card / Segmented / Dropdown), the Tailwind v4 + chunks-ui setup,
and a per-domain Rust command-module layout. **chunks-ui is a hard requirement** — this app is also a
showcase for it.

---

## 3. Architecture — the key decision

How should the Rust backend relate to Vanguard?

| | Approach | Verdict |
|---|---|---|
| **A** | **Rust = thin supervisor + filesystem event-bus.** Spawns the `vanguard` CLI (`run`, `watch`), owns the child PIDs, watches `.vanguard/` with `notify`, tails `sessions/*.jsonl` for live agent activity. No orchestration logic reimplemented in Rust. | **Recommended (now)** |
| B | Rust talks to a Vanguard **daemon / HTTP API**. Cleaner, no filesystem scraping — but blocked on an API that does not exist yet. | **Target (later)** |
| C | A **Node sidecar** embeds Vanguard as a library and the app calls its TypeScript in-process. Skips the CLI, but couples the app to Vanguard's internals and needs a library surface that does not exist. | No |

**Recommendation: build A, designed to migrate to B.** The filesystem *is already* Vanguard's state
store — Rust only has to watch it and bridge to React. No new protocol is needed for the read path,
and the launch path is just process spawning. When Sebastian's API lands (§8), the app swaps its data
source from "watch files" to "subscribe to events" without the UI changing. **The API requirements
appendix is, in effect, the spec for approach B** — that is the nudge.

```text
┌─ React (chunks-ui) ─┐   Tauri IPC    ┌─ Rust supervisor ───┐   spawn / tail   ┌─ vanguard CLI ─┐
│ dashboard           │◄── events ─────│ notify FS watcher   │◄─── reads ───────│ .vanguard/*    │
│ project board       │                │ child-process mgr   │──── spawns ─────►│ bun runtime    │
│ run inspector       │─── commands ──►│ (start/stop/kill)   │                  │ agents+worktree│
└─────────────────────┘                └─────────────────────┘                  └────────────────┘
```

---

## 4. Data Vanguard already persists (all typed, all on disk)

Vanguard exports authoritative TypeScript types; the on-disk artifacts map to them directly. A
hand-written `vanguard-output.d.ts` (the *persisted* shapes, not Vanguard's internal ones) should live
in the app so the frontend is typed without importing Vanguard's build.

| File | Type | Source of truth |
|---|---|---|
| `runs/<task>/<ts>[-stage].json` | `RunResult` minus `diff`/`transcript`, plus `timestamp`, optional `stage`, `prUrl` | `src/core/types.ts` · persisted by `src/core/run-record.ts` |
| `runs/<task>/<ts>.proof.json` | `VerificationResult` (`command`, `exitCode`, `passed`, `sha256`, `outputTail`) | `src/pipeline/verify.ts` |
| `runs/metrics.jsonl` | one line per event: `{evt:'run_complete', ...StageMetric}` or `{evt:'verify', taskId, passed, exitCode, sha256}` | `src/core/run-metric.ts` |
| `runs/<task>/<ts>-<stage>.transcript.log` | raw agent stream-json transcript | — |
| `runs/<task>/<ts>.bundle` | git bundle of the run's `HEAD` (the diff) | — |
| `sessions/<task>/<uuid>.jsonl` | **live** agent stream-json (written during the run) | agent CLI format; parser reference `src/agents/claude-stream.ts` |
| `worktrees/` | the actual working trees per run | — |
| `memory/retrospective.md` | accumulated failure retrospective | `src/core/retrospective-memory.ts` |

The `usage` block on `RunResult` is `AgentUsage` (`inputTokens`, `outputTokens`,
`cacheReadInputTokens`); `cacheEfficiency` is derived.

---

## 5. Screens (feature slices)

- **Dashboard** — a card per project: tasks running / done, velocity and spend summary (exact metric
  set TBD, see §10). An "add project" flow.
- **Project** — a **board or list** of tasks (user's choice of view, TanStack Table). Columns / lanes
  map to the provider **label lifecycle** (e.g. queued → claimed → running → verify-failed → done),
  derived from issue labels + `metrics.jsonl`. Task spec text is sourced from the configured provider
  (GitLab / GitHub issue).
- **Task detail** — the spec pane (from the provider issue) alongside the task's **run history**.
- **Run inspector** — *the headline feature.* Proof gate (command + `outputTail`, with failing output
  highlighted), the diff (rendered from the `.bundle`), per-stage cards (implementer / reviewer /
  simplifier with turns, duration, tokens, cost, model, final text), and the **live transcript** from
  `sessions/*.jsonl`. This is the throwaway preview done properly, and it is what makes failure
  inspection a first-class action instead of an LLM errand.

---

## 6. Configuration store

**Reality today:** Vanguard has no per-project config *file*. Behaviour is driven by CLI flags
(`repoPath`, `provider`, `label`, `model`, …) and `VANGUARD_*` environment variables, and much of the
real configuration **lives in code** — the prompt templates, skill wiring, and run scripts are
authored (by hand or by an LLM) as part of the repo, not as declarative config. `.vanguard/` is
purely *output* (runs, sessions, worktrees, memory, staging). One consequence is an MVP limitation —
the app cannot edit runner behaviour; see §15.

**What the app still needs:** somewhere to store *its own* per-project settings (local repo path,
provider, label filters, verify command override, concurrency, model choice) so the supervisor can
spawn `vanguard` with the right flags. **Proposal:** a `.vanguard/app.json` per repo, owned by the
desktop app, mirroring the CLI flags.

> **Open question for Sebastian:** should this config live in `.vanguard/app.json`, or a separate
> app-level store? Do you want the CLI itself to grow the ability to read such a file (so the app and
> a human run Vanguard identically)? — flagged, not decided.

---

## 7. Rust backend surface (Full scope)

Commands (React → Rust):

- `list_projects()` → configured projects + summary
- `read_runs(project)` → parsed `RunResult` / `metrics.jsonl` for the board
- `read_run_detail(runId)` → proof, stages, diff (from bundle), transcript
- `spawn_run(task)` → start a single `vanguard run`
- `spawn_watch(project, concurrency)` → start the fleet `vanguard watch` loop
- `kill(pid)` → stop a run or the watch loop
- `read_config(project)` / `write_config(project, cfg)` → the `app.json` above

Events (Rust → React, via `notify` file-watching + child stdio):

- `run_updated` — a `runs/*.json` appeared/changed
- `metric_appended` — a new `metrics.jsonl` line
- `session_line` — a new line in a live `sessions/*.jsonl` (real-time agent activity)
- `process_exited` — a supervised child ended (with exit code)

Rust owns: PID lifecycle and kill, environment/credential passthrough to the spawned CLI (see §12),
and optionally bundling the bun runtime as a Tauri sidecar so the app is self-contained.

---

## 8. API requirements (appendix — separate epic)

This app is deliberately built against the filesystem (approach A) so it can ship without waiting on
an API. But it also defines exactly what an API would need to expose to let the app stop scraping
files (approach B). Offered as a concrete target to unblock the API epic:

**Read**
- List projects / tasks / runs with the same fields as the on-disk `RunResult` / `StageMetric`.
- Fetch a single run's detail (proof, stages, diff, transcript).
- Cost/usage rollups (see §10) — ideally server-computed so every client agrees.

**Control**
- Start / stop a single run.
- Start / stop a `watch` fleet loop with a concurrency argument.

**Event stream**
- An SSE or WebSocket stream carrying the same events as §7 (`run_updated`, `metric_appended`,
  `session_line`, `process_exited`) so the app can drop `notify` file-watching.

**Config**
- Read / write per-project config (whatever §6 resolves to).

**Non-negotiable:** **secrets never travel over the API.** Even after B lands, LLM credentials stay
local to whoever runs the agents (see §12). The API carries orchestration and telemetry, not tokens.

---

## 9. Scope & phasing

Target scope is **Full**: inspect **and** launch **and** drive the fleet. For negotiation, it is
staged so the owner can approve or cut at phase boundaries:

- **P0 — Inspector (read-only).** Dashboard, project board/list, task detail, run inspector. Reads
  provider issues + `.vanguard/`. Highest value (solves the inspection pain), lowest risk, no process
  control. Ships first.
- **P1 — Launch.** Spawn / kill single `vanguard run`s from the UI. Adds process lifecycle + credential
  passthrough (§12).
- **P2 — Fleet.** Drive `vanguard watch` with concurrency control from the UI.

**Data sources for all phases:** the configured provider (GitLab / GitHub issues) + each repo's
`.vanguard/` on the viewer's machine. Limitations and non-goals are consolidated in §15.

---

## 10. Cost tracking

Vanguard **already persists cost per stage**: `costUsd`, token counts, and `cacheEfficiency` land on
every `metrics.jsonl` line, budget caps exist (`maxBudgetUsd`, `stageCapUsd`, `remainingBudgetUsd`),
and `estimateOpenRouterCost` / `ModelPricing` (`src/core/openrouter-pricing.ts`) provide a pricing
fallback for models without a first-party price.

The app aggregates these into rollups — **per project / per task / per stage / per model** — plus burn
rate and velocity on the dashboard, and surfaces the budget cap vs remaining budget where a run
carried one. For any model without a known price, fall back to the OpenRouter estimate and mark the
figure as an estimate.

Everything here is a *read* over data Vanguard already writes — no changes to Vanguard required.

---

## 11. LLM providers

Vanguard supports multiple providers out of the registry (`src/agents/registry.ts`): `claude`,
`codex`, `cursor`, `pi`, `openrouter`, `zai`, `meridian`, across `anthropic` / `openai` / `cursor`
transports. A run carries a primary `provider` **and** an optional separate `reviewProvider`, so the
review stage can run on a different (e.g. cheaper) model than the implementer.

The app exposes provider **and** reviewProvider selection per project/run, populated from
`PROVIDER_NAMES`, and stores the choice in the config of §6. This is surfacing an existing capability,
not adding one.

---

## 12. LLM authentication — open question, not a decision

Vanguard's auth model (`src/agents/auth.ts`): `AgentAuth` is either `subscription`
(`CLAUDE_CODE_OAUTH_TOKEN`) or `api` (`ANTHROPIC_API_KEY`); exactly one secret is injected so billing
is unambiguous; provider keys (z.ai / OpenRouter) ride the `api` slot; and the credential is held in
an **LLM-proxy sidecar** while the sandbox receives only a per-run nonce. In practice today, auth is
drawn from the environment, 1Password, or other keychain methods — as part of scripts/config that live
in code.

The `Not logged in · Please run /login` failures in the sample runs are exactly this: the agent CLI
had no credential. Options span "inherit whatever credential is in the operator's shell/environment"
to "the app manages credentials in an OS keychain and injects them into the spawned CLI" — each with
real UX and security trade-offs, and the answer depends on how much credential UX Sebastian wants to
smooth given how much already lives in code.

> **Open question for Sebastian:** how should the desktop app deal with LLM credentials — inherit from
> the environment / 1Password / keychain as today, or actively manage them? Is smoothing this UX even
> desirable, or should the app stay out of the credential business entirely? The **only** firm
> constraint we propose: whatever the answer, **secrets stay local and never cross the (future) API**
> (§8).

---

## 13. Flagged opportunities (post-MVP, for discussion)

Not proposed for the MVP — flagged so they are on the table when scope is negotiated.

- **Local SQLite task engine.** A local, SQLite-backed task source so a user can run a board without a
  GitLab/GitHub project behind it. Post-MVP.
- **Declarative workflows → visual block editor.** Today Vanguard's runner behaviour is hand-written or
  LLM-written *scripts in code*. If Vanguard grew support for **declarative workflow definitions**
  (YAML/JSON), the app could offer a **visual, block-based** setup — compose a run out of predefined
  blocks instead of writing a script, stored as JSON/YAML config. This would also lift the MVP
  limitation in §9 (editing runner behaviour). Big, speculative, and dependent on a Vanguard-side
  change — but a genuinely attractive direction, so it is flagged here as an opportunity rather than a
  commitment.

---

## 14. Open questions for the owner (Sebastian)

1. **Config location** — `.vanguard/app.json` vs a separate app store; should the CLI read it too? (§6)
2. **CLI surface** — willing to add a `--json`/daemon mode, or is spawning the CLI + watching files an
   acceptable long-term seam? (§3, §8)
3. **Auth UX** — how should the app handle LLM credentials, if at all? (§12)
4. **Repo placement** — should the app live inside the Vanguard repo, or as a separate repo?
5. **API epic** — does the §8 requirements list match your thinking; would this app's needs help you
   commit to the API's shape?
6. **Post-MVP appetite** — declarative YAML/JSON workflows + visual editor, and a local SQLite task
   source? (both §13)

---

## 15. Non-goals & MVP limitations

- **No rewrite** of Vanguard internals.
- **Cannot edit runner behaviour** — config/prompts/scripts live in code (§6); the app observes,
  launches, and inspects, it does not author them.
- **No local SQLite task engine** — provider issues + `.vanguard/` only (§13 flags it post-MVP).
- **Local only** — no remote/multi-user; inspects repos present on the viewer's machine.
- **Depends on the CLI + agent runtimes** being installed (or sidecar-bundled).
- **No credential-management commitment** — §12 is an open question.
