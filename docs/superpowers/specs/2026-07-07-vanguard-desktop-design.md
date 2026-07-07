# Vanguard Desktop — Design Proposal (v2, detailed)

> **Status:** Draft for discussion. Author: Paweł. Owner sign-off required: Sebastian.
> **Supersedes:** `2026-07-06-vanguard-desktop-design.md` (kept as history).
> **Purpose:** A local desktop app to *watch, inspect, drive, configure, and remotely observe* Vanguard
> runs — a Conductor-style cockpit over the orchestrator that already exists. This document folds in
> Sebastian's latest direction (2026-07-07): a visual workflow editor in the MVP backed by a declarative
> config file; a documented path to a local/remote SQLite task engine; LLM auth explicitly out of scope;
> a hard "how far does the CLI get us before we need an API" answer; and a remote-viewing capability set
> for CI-hosted runs — all evidence-backed.

---

## 0. What changed since v1 (2026-07-06)

| # | Area | v1 | v2 (this doc) |
|---|---|---|---|
| 1 | Visual workflow editor | Post-MVP "flagged opportunity" (§13) | **In MVP** as a *flag-composer* (§13), phased toward pipeline-composition |
| 2 | Workflow config format | YAML/JSON, speculative | Declarative file, format **spiked** (HCL-static-subset vs JSONC) before commit (§6, §13) |
| 3 | Custom-TS migration | — | **Deferred entirely** — existing driver scripts keep running via the CLI, untouched (§16) |
| 4 | SQLite task engine | Post-MVP flag (§13) | **First-class future Task Source**, architecture kept source-agnostic so we don't cut it off (§15) |
| 5 | LLM authentication | Open question (§12) | **Decided: out of scope** — inherit operator creds, app does not manage them (§12) |
| 6 | API | "requirements appendix" | Reframed as a **CLI envelope & where it breaks** evidence section — the five things that force an API (§8) |
| 7 | Remote viewing | Non-goal ("local only") | **In scope** — desktop shells `gh`/`glab` to watch CI-hosted runs; new detailed section (§14) |

Decisions locked with the owner while drafting v2:

- **Surface:** desktop cockpit only. No mobile/web surface in the MVP. Sebastian's "from my phone" flow
  stays app-less (file an issue on a phone → CI runs Vanguard → PR/MR delivered); the desktop app is
  Paweł's local-first cockpit that *also* views remote CI runs.
- **Editor depth:** ship the flag-composer (no Vanguard-core change), design the schema forward-compatible
  with a later pipeline-composer (which *would* need a Vanguard `run --config` reader).
- **Config format:** spike both HCL-static-subset and JSONC during the implementation plan; decide on
  round-trip evidence.
- **Migration:** deferred entirely.

---

## 1. Motivation

Vanguard is a headless orchestrator: it isolates work in git worktrees, runs a fleet of agents with
bounded concurrency, claims tasks off a Task Source (GitHub / GitLab / Linear), gates every run behind a
proof-of-work command, and writes all of its state to `.vanguard/` on disk.

Two working styles drive the design:

- **Sebastian** — fully automated, mobile-first. Specs are filed as issues (GitHub, or the Linear mobile
  app); a cloud runner (GitHub Actions / GitLab CI) picks them up and drives Vanguard unattended; a draft
  PR/MR is delivered. No laptop. The pipeline is the product — but he wants to *watch remote runs* and
  compose a project's workflow visually.
- **Paweł** — local, hands-on. Runs Vanguard locally with cloud orchestration, and *wants to watch it
  happen* — see the fleet, read run traces, inspect failures directly. Development is the activity, not
  just the outcome.

The immediate pain is unchanged: **inspecting a run today is hard.** Traces in `.vanguard/runs/` are raw
JSON; diagnosing a failure means reading JSON by hand or tasking an LLM to summarise it. A throwaway HTML
preview already proved the data renders readably — this turns that throwaway into a product, then extends
it to *configure* runs and *watch remote* ones.

**This is an upgrade, not a rewrite.** We do not touch Vanguard's internals for the MVP. The one place a
Vanguard-core change is even contemplated (the pipeline-composer's `run --config` reader) is explicitly a
*later*, *separate* epic (§13).

---

## 2. Tech stack & patterns we reuse

The desktop shell follows a proven Tauri 2 architecture already shipping in another app of ours —
Rust domain/supervisor core, React presentation, typed JSON over IPC as the only boundary:

| Layer | Tech | Responsibility |
|---|---|---|
| Presentation | React 19 · Vite · Tailwind v4 · **chunks-ui** · zustand | Screens, forms, state. Touches no process. |
| Board / tables | **TanStack Table** (`@tanstack/react-table`) | Task board / list rendering. |
| Graph editor | **React Flow** (`@xyflow/react`) | Visual workflow graph (§13). |
| Routing | `react-router` `MemoryRouter` + shell layout + feature-sliced `features/<name>` | Convention-based screen composition. |
| IPC | Tauri v2 commands + events | Typed request/response and push. |
| Backend | **Rust** (`src-tauri/`) | Process supervision, filesystem watching, config (de)serialisation, `gh`/`glab`/`linear` shelling, typed JSON over IPC. |

Concretely reused as patterns: a `ShellLayout` + Tauri-guard wrapper + `features/<name>` slice layout,
`components/atoms` chunks-ui wrappers (Card / Segmented / Dropdown), the Tailwind v4 + chunks-ui setup,
and a per-domain Rust command-module layout. **chunks-ui is a hard requirement** — this app is also a
showcase for it. React Flow is the one new frontend dependency, justified by §13.

---

## 3. Architecture — the two axes

The key relationship the app must model is **two independent axes**, not one. Conflating them is the
mistake v1 made by treating "local only" as the whole story.

**Axis A — Task Source** (where the work item / spec lives): **GitHub · GitLab · Linear**. Read via the
`gh` / `glab` / `linear` runners. Drives the board and task-detail screens. Always CLI-accessible from
anywhere; independent of where a run executes.

**Axis B — Runner Host** (where a Vanguard *run executes*): **local machine · GitHub Actions · GitLab CI ·
self-hosted**. This axis alone determines *remote observability*, because it decides which platform CLI
(if any) can see the run.

The two axes compose freely: a Linear-sourced task can execute on GitHub Actions; a GitHub-sourced task
can run locally. Remote-viewing capability (§14) is a property of Axis B; task/board data (§5) is a
property of Axis A.

### Backend-to-Vanguard relationship

How should the Rust backend relate to a Vanguard run?

| | Approach | Verdict |
|---|---|---|
| **A** | **Rust = thin supervisor + filesystem event-bus + CLI-scraper.** Spawns the `vanguard` CLI locally; watches `.vanguard/` with `notify`; tails `sessions/*.jsonl`; and for remote runs shells `gh`/`glab`. No orchestration logic reimplemented in Rust. | **Recommended (now)** |
| B | Rust talks to a Vanguard **daemon / HTTP API**. Cleaner, but blocked on an API that does not exist and is only justified by the five cases in §8. | **Target (later, conditional)** |
| C | A **Node sidecar** embeds Vanguard as a library, called in-process. Couples the app to Vanguard internals and needs a library surface that does not exist. | No |

**Recommendation: build A, designed to migrate to B *only where §8 proves B is required*.** The
filesystem *is already* Vanguard's local state store, and the CI platforms *are already* the remote state
store (via logs + artifacts). Rust bridges both to React. When (if) a Vanguard API lands, the app swaps
its data source without the UI changing.

```text
┌─ React (chunks-ui) ─┐   Tauri IPC    ┌─ Rust supervisor ─────────┐   spawn / tail    ┌─ vanguard CLI ─┐
│ dashboard           │◄── events ─────│ notify FS watcher         │◄─── reads ────────│ .vanguard/*    │ (local)
│ project board       │                │ child-process mgr         │──── spawns ──────►│ bun runtime    │
│ run inspector       │─── commands ──►│ workflow (de)serialiser   │                   └────────────────┘
│ workflow editor     │                │ gh / glab / linear shell  │──── shells ──────►┌─ CI platform ──┐
│ remote runs         │◄── events ─────│ (remote runs + artifacts) │◄─── polls/pulls ──│ Actions / CI   │ (remote)
└─────────────────────┘                └───────────────────────────┘                   └────────────────┘
```

---

## 4. Data Vanguard already persists (all typed, all on disk)

Vanguard exports authoritative TypeScript types; the on-disk artifacts map to them directly. A
hand-written `vanguard-output.d.ts` (the *persisted* shapes, not Vanguard's internal ones) lives in the
app so the frontend is typed without importing Vanguard's build.

| File | Type | Source of truth |
|---|---|---|
| `runs/<task>/<ts>[-stage].json` | `RunResult` minus `diff`/`transcript`, plus `timestamp`, optional `stage`, `prUrl` | `src/core/types.ts` · persisted by `src/core/run-record.ts` |
| `runs/<task>/<ts>.proof.json` | `VerificationResult` (`command`, `exitCode`, `passed`, `sha256`, `outputTail`) | `src/pipeline/verify.ts` |
| `runs/metrics.jsonl` | one line per event: `{evt:'run_complete', ...StageMetric}` or `{evt:'verify', ...}` | `src/core/run-metric.ts` |
| `runs/<task>/<ts>-<stage>.transcript.log` | raw agent stream-json transcript | — |
| `runs/<task>/<ts>.bundle` | git bundle of the run's `HEAD` (the diff) | — |
| `sessions/<task>/<uuid>.jsonl` | **live** agent stream-json (written during the run) | parser ref `src/agents/claude-stream.ts` |
| `worktrees/` | the actual working trees per run | — |
| `memory/retrospective.md` | accumulated failure retrospective | `src/core/retrospective-memory.ts` |

The `usage` block on `RunResult` is `AgentUsage` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`);
`cacheEfficiency` is derived.

**Key reuse for remote (§14):** this same directory, when uploaded as a CI artifact and pulled back with
`gh run download`, feeds the *identical* run-inspector UI. Remote post-mortem == local inspection with a
different fetch.

---

## 5. Screens (feature slices)

- **Dashboard** — a card per project: tasks running / done, velocity and spend summary. An "add project"
  flow. Cards show *local* and *remote* run counts distinctly.
- **Project** — a **board or list** of tasks (user's choice, TanStack Table). Columns / lanes map to the
  Task Source's state lifecycle (GitHub/GitLab labels; Linear states), derived from the source + `metrics.jsonl`.
  Task spec text is sourced from the configured Task Source (`gh`/`glab`/`linear`).
- **Task detail** — the spec pane (from the source) alongside the task's **run history** (local + remote).
- **Run inspector** — *the headline feature.* Proof gate (command + `outputTail`, failing output
  highlighted), the diff (from the `.bundle`), per-stage cards (implementer / reviewer / simplifier with
  turns, duration, tokens, cost, model, final text), and the **live transcript** from `sessions/*.jsonl`.
  Fed by local files *or* a downloaded remote artifact — same component, two data sources.
- **Workflow editor** *(new, §13)* — a visual graph (React Flow) over a project's workflow config file.
  Blocks map to the CLI flag surface; edits round-trip to the config file; a "Run" action spawns
  `vanguard` with the derived flags.
- **Remote runs** *(new, §14)* — a live-ish list of CI-hosted runs for a project (via `gh`/`glab`), with
  status/timing, a live tail where the runner supports it, cancel/rerun, and "open in inspector" (pulls
  the artifact).

---

## 6. Configuration store — two files, two owners

Reality today: Vanguard has **no per-project config file**. Behaviour is driven by CLI flags and
`VANGUARD_*` env vars; much configuration **lives in code** (prompt templates, skill wiring, run scripts).
`.vanguard/` is purely *output*.

v2 introduces **two** config files with distinct owners:

1. **`.vanguard/app.json`** — the *desktop app's own* per-project settings the CLI never reads: which
   Task Source, label filters, which remote runner host to watch, UI preferences, last-selected view.
   Owned by the app. Free-form to the app; opaque to Vanguard.

2. **`.vanguard/workflow.<hcl|jsonc>`** — the *declarative workflow definition* (§13): the run/watch
   **flag surface** expressed as blocks. Owned jointly by the app (visual editor writes it) and humans/LLMs
   (who may author it by hand). The app **translates it into CLI flags** and spawns `vanguard` — Vanguard
   itself does not read it in the MVP (that is the pipeline-composer's future `run --config`, §13).

> **Format decision is deferred to a spike** (§13). Until then both files are described by shape, not
> syntax; `app.json` is JSON regardless (app-internal), `workflow.*` is the one under evaluation.

---

## 7. Rust backend surface

Commands (React → Rust), grouped:

**Local read**
- `list_projects()` → configured projects + summary
- `read_runs(project)` → parsed `RunResult` / `metrics.jsonl` for the board
- `read_run_detail(runId)` → proof, stages, diff (from bundle), transcript

**Local control**
- `spawn_run(task)` → start a single `vanguard run`
- `spawn_watch(project, concurrency)` → start the fleet `vanguard watch` loop
- `kill(pid)` → stop a run or the watch loop

**Config + workflow**
- `read_app_config(project)` / `write_app_config(project, cfg)` → `.vanguard/app.json`
- `read_workflow(project)` / `write_workflow(project, cfg)` → parse/serialise `workflow.*`
- `validate_workflow(cfg)` → schema + (if HCL) static-subset check; returns errors for out-of-subset input
- `workflow_to_flags(cfg)` → the derived `vanguard` argv (also used by `spawn_run` when a workflow exists)

**Remote (Axis B, §14)**
- `list_remote_runs(project)` → `gh run list --json …` / `glab ci list -F json`
- `read_remote_run(project, runId)` → `gh run view --json jobs,…` / `glab ci get -F json --with-job-details`
- `download_remote_state(project, runId)` → `gh run download -n vanguard-state` (or `glab job artifact`) → temp dir → same shape as §4 → feeds the inspector
- `cancel_remote(project, runId)` / `rerun_remote(project, runId)`

Events (Rust → React):
- `run_updated` — a local `runs/*.json` appeared/changed
- `metric_appended` — a new local `metrics.jsonl` line
- `session_line` — a new line in a live local `sessions/*.jsonl`
- `process_exited` — a supervised child ended (exit code)
- `remote_run_updated` — a polled remote run changed status (§14 cadence)
- `remote_sentinel` — a parsed `::VANGUARD::` line from a live GitLab trace (§14)

Rust owns: PID lifecycle and kill, credential passthrough to the spawned CLI (§12), workflow (de)serialisation,
`gh`/`glab`/`linear` shelling with rate-aware polling (§14), and optionally bundling the bun runtime as a
Tauri sidecar so the app is self-contained.

---

## 8. CLI envelope & where it breaks (Sebastian's hard evidence)

The API is deliberately **not** built now. This section is the evidence for that call: exactly how far the
CLI-only design reaches, and the precise, enumerable set of things that force an API.

**Everything in P0–P4 ships CLI-only.** Verified against `gh 2.92.0` (authed, live) and `glab 1.97.0`
(help-derived; not authed at research time):

- **Local:** the filesystem *is* the state store; `notify` + child-process management cover read and control.
- **Remote list/detail:** `gh run list/view --json` and `glab ci list/get -F json` give runs, jobs, steps,
  status, conclusion, second-granularity timing, trigger, branch, SHA — as JSON.
- **Remote deep state:** a CI job that uploads `.vanguard/` as an artifact lets `gh run download` /
  `glab job artifact` reconstruct the full `RunResult` / metrics / transcripts / proof / diff **post-run**.
- **Remote control:** `gh run cancel`/`rerun`, `glab ci cancel`/`retry` — stop-everything and re-run.
- **Rate budget:** GitHub authenticated REST is 5000 req/hr; a 5–15 s poll per watched run with `ETag`/
  `--cache` sits far under it.

**An API becomes necessary the moment you want one of these five — and only these:**

1. **Low-latency, push-based per-stage progress of an in-flight run** — especially on **GitHub**, whose CLI
   exposes *no* mid-run log, only ~3 s step-status flips (`gh run watch`). Sentinel echo (§14) is a
   workaround bounded by Vanguard's own emit cadence and is GitLab-only for "live".
2. **Sub-second live transcript streaming** of `sessions/*.jsonl`. Artifacts are post-run only; logs are
   invisible mid-run on GitHub and line-buffered/log-polluting on GitLab. Token-level live = a stream API.
3. **Mid-run intervention finer than "cancel the whole job"** — approve/deny a gate, answer an agent's
   question, inject a hint, kill one stage while the job continues. No CI primitive does this.
4. **Cross-run / historical querying of rich state** — "all proof failures across the last 50 runs" means
   downloading 50 artifact zips (expensive; expired ones are gone). Needs a queryable datastore.
5. **State after artifact expiry (~90 days) or for runs that emitted nothing** — unrecoverable without
   server-side retention.

That is the answer to *"how far can we get with just the CLI?"* — **everything except those five.** Each is
a concrete, demonstrable trigger, not a vague "it'd be nicer." Until one of them is a felt need, the CLI
seam holds.

When B *is* built, its surface mirrors §7 (read/control/config) plus an SSE/WebSocket event stream carrying
the §7 events. **Non-negotiable:** secrets never travel over the API (§12). The API carries orchestration
and telemetry, not tokens.

---

## 9. Scope & phasing

Target scope is **Full**: inspect **and** launch **and** drive **and** configure **and** remotely observe.
Staged so the owner can approve or cut at phase boundaries.

- **P0 — Inspector (read-only, local).** Dashboard, project board/list, task detail, run inspector. Reads
  Task Source + local `.vanguard/`. Highest value, lowest risk, no process control. Ships first.
- **P1 — Launch (local).** Spawn / kill single `vanguard run`s. Adds process lifecycle + credential
  passthrough (§12).
- **P2 — Fleet (local).** Drive `vanguard watch` with concurrency control.
- **P3 — Workflow config + visual flag-composer.** The `workflow.*` file (§6), the React Flow editor (§13),
  and `workflow_to_flags` wiring so a run/watch can be launched from the composed config. **No Vanguard-core
  change.** Includes the format spike.
- **P4 — Remote viewing.** `gh`/`glab` remote runs list, status/timing, live tail where supported, artifact
  download into the inspector, cancel/rerun (§14). Depends on the CI-side contract (§14.3) being present.

**Future (documented, uncommitted):** pipeline-composer (needs Vanguard `run --config`, §13); SQLite task
engine (§15); the Vanguard API (§8, conditional on the five triggers); mid-run intervention (§8).

**Phase ordering P3 vs P4 is negotiable** — both are Sebastian MVP asks. Local core (P0–P2) is fixed first.

---

## 10. Cost tracking

Vanguard **already persists cost per stage**: `costUsd`, token counts, `cacheEfficiency` on every
`metrics.jsonl` line; budget caps (`maxBudgetUsd`, `stageCapUsd`, `remainingBudgetUsd`); and
`estimateOpenRouterCost` / `ModelPricing` (`src/core/openrouter-pricing.ts`) as a pricing fallback.

The app aggregates these into rollups — **per project / task / stage / model** — plus burn rate and
velocity on the dashboard, and surfaces budget cap vs remaining where a run carried one. Unknown-price
models fall back to the OpenRouter estimate, marked as an estimate. All of this is a *read* over data
Vanguard already writes — including remote runs, once their artifact is downloaded (§14). No Vanguard change.

---

## 11. LLM providers

Vanguard supports multiple providers from the registry (`src/agents/registry.ts`): `claude`, `codex`,
`cursor`, `pi`, `openrouter`, `zai`, `meridian`, across `anthropic` / `openai` / `cursor` transports. A run
carries a primary `provider` **and** an optional `reviewProvider`, so review can run on a cheaper model than
the implementer.

The workflow editor (§13) and per-run controls expose **provider** and **reviewProvider** selection,
populated from `PROVIDER_NAMES`, stored in the workflow config. Surfacing an existing capability, not adding one.

---

## 12. LLM authentication — decided: out of scope

**Decision (2026-07-07): the app does not manage LLM credentials.** It inherits whatever credential the
operator's environment provides — shell env, 1Password (`op read`), or OS keychain — exactly as scripts do
today, and passes it through to the spawned CLI. The app does **not** store, prompt for, or broker secrets.

Rationale: credential UX is genuinely hard, much of it already lives in code/scripts, and Sebastian has no
clear model for it yet. Smoothing it is not worth MVP scope or risk.

The one firm constraint survives: **whatever the future holds, secrets stay local and never cross the
(future) API (§8).** Vanguard's own auth model (`src/agents/auth.ts`) — one secret injected per run, held
in an LLM-proxy sidecar, sandbox gets only a nonce — is untouched by this app. The `Not logged in` failures
in sample runs are surfaced as *diagnostics* (the operator's env lacked a credential), not something the app
tries to fix.

---

## 13. Workflow config & visual editor (P3, detailed)

### 13.1 Goal & the depth decision

Give a project a **declarative workflow definition** editable as a **visual graph**, so composing a run is
dragging blocks instead of writing a script. Depth is deliberately bounded:

- **MVP = flag-composer.** Blocks map 1:1 to Vanguard's **existing CLI flag surface**. The app reads the
  config, derives argv (`workflow_to_flags`, §7), and spawns `vanguard`. **Zero Vanguard-core change.**
- **Later = pipeline-composer.** Compose the actual agent pipeline (custom stages, ordering, per-stage
  models). This *requires* Vanguard to grow `vanguard run --config <file>`. Out of MVP; the schema is
  designed so it can extend into this without a rewrite.

The flag surface the composer covers (from `src/cli/args.ts` / run-options): repo path, Task Source
(`--github`/`--gitlab`/`--linear`), label filter, implementer model + provider, review model + provider,
concurrency, verify command, budget caps (`maxBudgetUsd`, `stageCapUsd`), and mode flags (`--plan`,
`--base`, `--commit-author`).

### 13.2 Format — a spike, not yet a decision

Sebastian proposed **Terraform/HCL** as the config holder. Research (2026-07-07) found: HCL-as-pure-config
is a well-precedented pattern (Nomad, Packer, Waypoint, Terramate); Rust has a purpose-built,
comment-preserving, round-trip-capable writer, **`hcl-edit`** (martinohmann, actively maintained, but
pre-1.0); and the Tauri architecture (Rust owns file I/O, React sees only JSON over IPC) defuses the
"Node can't write HCL" problem entirely.

**The crux:** a clean *visual round-trip* forces a **static HCL subset** — blocks + labels + literal scalar/
list/map attributes + optional bare references; **no** `${…}` interpolation, functions, `for_each`,
`dynamic`, conditionals, or `variable`/`locals`. That subset is functionally *"JSON with blocks and
comments."* HCL's real edge (references/DRY) only pays off in the pipeline-composer phase. JSONC, by
contrast, round-trips losslessly and deterministically, has the best schema/LSP story, and mature
serializers on **both** Rust (`serde_json`) and Node — at the cost of no native references. YAML is rejected
outright (worst round-trip; `serde_yaml` is deprecated/archived).

**Plan: spike both** during the implementation plan — build the visual round-trip against an HCL-static-subset
(`hcl-edit`) *and* JSONC, on the same sample config, and decide on evidence. Decision criteria: round-trip
fidelity against hand-edited files, validator complexity, and how "authored-by-hand/LLM" the file needs to
feel (Vanguard's ethos leans that way, which favours HCL; graph-as-source-of-truth favours JSONC).

The two spike targets, same config:

```hcl
# workflow.hcl  (static subset)
workflow "vanguard" {
  repo   = "."
  source = "github"          # github | gitlab | linear
  label  = "vanguard:ready"

  run {
    implementer_model = "claude-opus-4"
    review_model      = "claude-sonnet-4"
    plan              = true
    base              = "dev"
    commit_author     = true
  }

  fleet  { concurrency = 3 }
  verify { command = "pnpm typecheck && pnpm test" }
  budget { max_usd = 20  stage_cap_usd = 5 }
}
```

```jsonc
// workflow.jsonc
{
  "workflow": "vanguard",
  "repo": ".",
  "source": "github",          // github | gitlab | linear
  "label": "vanguard:ready",
  "run": {
    "implementerModel": "claude-opus-4",
    "reviewModel": "claude-sonnet-4",
    "plan": true,
    "base": "dev",
    "commitAuthor": true
  },
  "fleet":  { "concurrency": 3 },
  "verify": { "command": "pnpm typecheck && pnpm test" },
  "budget": { "maxUsd": 20, "stageCapUsd": 5 }
}
```

### 13.3 Round-trip & the escape hatch

Rust parses the file → typed JSON over IPC → React Flow renders nodes. React edits → typed JSON back →
Rust merges into the file (`hcl-edit` for HCL preserves comments; `serde_json` for JSONC). If a
hand-edited HCL file contains out-of-subset constructs, `validate_workflow` rejects it *on load* with a
clear message and the editor falls back to a **raw-text view** rather than silently dropping content. This
validator + escape-hatch is the standing cost of the HCL choice; it does not exist for JSONC.

### 13.4 Relationship to the old "can't edit runner behaviour" limit

v1's §15 said the app "cannot edit runner behaviour." P3 **partially lifts** that: the app can now edit
everything the **flag surface** exposes. It still cannot author prompt templates, skill wiring, or custom
pipeline stages — those remain "config in code" until the pipeline-composer epic.

---

## 14. Remote viewing (P4, detailed)

The write-up of *"how do we watch a Vanguard run that executes in CI, with no Vanguard API?"* Structured on
the two axes (§3): capability is a property of the **Runner Host**, task/spec data of the **Task Source**.

### 14.1 The model

The app shells `gh`/`glab` and reads two data planes:

1. **CI-platform metadata** — always available from the runner host: runs/pipelines list, jobs, steps,
   status, conclusion, second-granularity timing, trigger, branch, SHA. Cancel/rerun control.
2. **Vanguard's rich state** — invisible to the CLI *unless the CI job emits it*. It lives in `.vanguard/`
   inside the container. Surfaced only via the **CI-side contract** (§14.3).

Task Source (Axis A) is read independently via `gh`/`glab`/`linear` — the board and spec panes work for any
source regardless of where the run executes. **Linear** is a task source with no runner: a Linear-sourced
run still executes on GitHub Actions / GitLab CI / a host, and *that* host determines its remote-viewing
story. (Bonus: Sebastian can file specs from the Linear mobile app, widening the "from phone" path.)

### 14.2 Capability matrix (keyed on Runner Host)

| Capability | GitHub Actions (`gh`) | GitLab CI (`glab`) | Self-hosted / other |
|---|---|---|---|
| Runs list + status/timing | ✅ poll 5–15 s, JSON | ✅ JSON | ❌ no platform CLI |
| Single-run jobs/steps/timing | ✅ `gh run view --json jobs` | ✅ `glab ci get --with-job-details` | ❌ |
| **Live progress mid-run** | ⚠️ step-status only (~3 s, `gh run watch`) — **no mid-run log via CLI** | ✅ **real live log tail** (`glab ci trace`) → parses `::VANGUARD::` sentinels live | ❌ |
| Post-run deep inspect | ✅ `gh run download -n vanguard-state` → local inspector UI | ✅ `glab job artifact` → same | ❌ |
| Control | cancel / rerun whole run | cancel / retry | ❌ |

**The GitHub↔GitLab live asymmetry is a real product fact**, not a bug: GitHub's CLI exposes no in-flight
log, so "live" on GitHub tops out at coarse step-status; GitLab streams the running job's log line-by-line.
Surface this honestly in the UI (a "live" badge only where the runner supports it). Self-hosted/other hosts
have no platform CLI — remote viewing goes dark, which is exactly a §8 "need the box reachable / need the
API" case.

### 14.3 The CI-side contract (a template addition, not an API)

To make a remote run richly viewable, the Vanguard **runner workflow** (the CI job template that runs
Vanguard, in the *target* project — **not** this repo's `.github/workflows/`, which we never touch) does two
cheap things:

1. **Always upload `.vanguard/` as an artifact** named `vanguard-state` (`actions/upload-artifact` /
   GitLab `artifacts:`). Post-run, `download_remote_state` pulls it and feeds the **exact same run-inspector
   UI as local** (§4/§5). Full fidelity. Cost: post-run only (no incremental read), ~90-day expiry.
2. *(optional)* **Emit `::VANGUARD:: {stage,status,ms,tokens,costUsd}` sentinel lines to stdout** (behind a
   Vanguard flag/env, e.g. `VANGUARD_EMIT_SENTINELS=1`). Post-run, `gh run view --log | grep '::VANGUARD::'`
   reconstructs the stage timeline on either platform. Live, **only on GitLab**, `glab ci trace` streams
   them for a coarse real-time timeline (`remote_sentinel` events, §7).

This contract is documented as a **runner-template snippet** the operator applies when setting up CI. It is
a doc/template deliverable, not an app feature and not a Vanguard-core change. Sentinel emission is the one
small Vanguard-side convenience (a stdout flag) — optional, and independent of the flag-composer epic.

> **Open question for Sebastian:** is adding the artifact-upload (and optional sentinel-emit) step to the
> Vanguard runner template acceptable? Without at least the artifact upload, remote viewing is limited to
> CI-platform metadata (status/timing) with no Vanguard-stage detail.

### 14.4 Polling & limits

Poll `gh run list --json` / `gh api …/jobs` on a **5–15 s cadence per watched run**, prefer `ETag` and
`gh api --cache`; drop to `gh run watch`'s 3 s only for a single focused run. GitHub's 5000 req/hr
authenticated budget is comfortable at these cadences. GitLab's `glab ci trace`/`--live` self-manage their
polling. Rust owns the cadence and emits `remote_run_updated` on change.

---

## 15. Local/remote SQLite task engine (future Task Source)

Promoted from a v1 footnote to a first-class **documented direction** so the architecture does not cut it
off. Not MVP.

A SQLite-backed Task Source lets a user run a board without a GitHub/GitLab/Linear project behind it —
local (`.vanguard/tasks.db`) or hosted on a remote server as a shared board. It slots into Vanguard's
**existing** seam: implement `TaskFetcher` (`fetch`/`list`) + the five `WatchPrimitives` (`listReady`,
`claim`, `runOne`, `review`, `onFailure`) — the same contract GitHub/GitLab/Linear implement today
(`src/tasks/fetcher.ts`). Claim becomes a row-state update instead of a label/state change.

**Architectural obligation on the MVP:** keep the app's Task Source handling **source-agnostic** — board
columns derived from a source-provided state lifecycle, not hardcoded to labels; task/spec fetching behind
one interface. Then adding the SQLite source later is a new implementation, not a refactor. This is the
"don't cut ourselves off" constraint, honoured by design, at zero MVP cost.

---

## 16. Migration of existing custom-TS setups — deferred entirely

"Custom TS setups" are the `examples/from-*.ts` drivers — thin scripts calling
`runGithubIssue(ref, deps)` where `deps` come from env/flags. There is little to "migrate": the config
surface *is* the flag surface the composer already covers (§13.1).

**Decision:** no import/migration path in the MVP. Existing driver scripts keep working, unchanged, via the
CLI (they are just scripts). The workflow editor authors **new** `workflow.*` files only. If demand for a
"scaffold a workflow from my current flags/env" helper appears later, it is cheap to add then — but it is
not built now.

---

## 17. Open questions for the owner (Sebastian)

1. **CI-side contract (§14.3)** — OK to add an artifact-upload (and optional sentinel-emit) step to the
   Vanguard runner template? This gates remote-viewing richness.
2. **Config format (§13.2)** — comfortable with a spike deciding HCL-subset vs JSONC on evidence, or a
   hard preference for HCL now?
3. **Pipeline-composer epic (§13.1)** — is Vanguard willing to grow `run --config` later, to unlock full
   pipeline composition? (Not needed for MVP; shapes the schema.)
4. **Phase ordering (§9)** — P3 (workflow editor) before or after P4 (remote viewing)?
5. **Repo placement** — does the app live inside the Vanguard repo or as a separate repo?
6. **API (§8)** — do the five triggers match your mental model of when an API earns its keep?

## 18. Non-goals & MVP limitations

- **No rewrite** of Vanguard internals.
- **Flag-composer, not pipeline-composer** — the editor covers the CLI flag surface; custom pipeline stages,
  prompt templates, and skill wiring stay "config in code" until the `run --config` epic (§13).
- **No local SQLite task engine** — provider Task Sources only in MVP; §15 keeps the door open.
- **No mobile/web surface** — desktop cockpit only; Sebastian's phone flow stays app-less (§0).
- **Remote viewing needs a supported runner host** — GitHub Actions or GitLab CI; self-hosted/other hosts
  have no platform CLI and go dark (§14.2), a §8 API case.
- **Remote live progress is asymmetric** — real live log tail on GitLab; coarse step-status only on GitHub
  (§14.2).
- **No credential management** — the app inherits operator creds, never brokers them (§12).
- **Depends on the CLI + agent runtimes** being installed (or sidecar-bundled), plus `gh`/`glab`/`linear`
  for their respective sources/hosts.
