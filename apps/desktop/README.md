# Vanguard Desktop

A local **Tauri 2** cockpit over [Vanguard](../../README.md) — watch, inspect, drive, and remotely
observe agent Runs. Rust backend · React 19 · Tailwind v4 · [chunks-ui](https://github.com/) · TypeScript.

## Run

```bash
cd apps/desktop
pnpm install
pnpm start        # = tauri dev  (also runnable from repo root: `pnpm start`)
```

First launch compiles the Rust crate (a few minutes), then opens the window. Add a project pointing at any
repo that contains a `.vanguard/` directory. Launch from a terminal so the app inherits your shell
environment (LLM/platform credentials) — see **Launching runs** below.

Gates: `cd src-tauri && cargo test` · `pnpm vitest run` · `pnpm build`.

## What it does (shipped)

- **Dashboard cockpit** — a card per project (runs, tasks, spend, failed, 24h velocity, relative
  last-activity) + a live summary strip (Projects / Running / Runs / Last 24h / Spend), polled every 5s.
- **Left rail** — Conductor-style project nav with live running-dots, add-project, ⌘K search, theme toggle.
- **Command palette (⌘K)** — jump to any project or action.
- **Run inspector** — breadcrumb nav (`Home / project / task`); a run's **Overview** (proof-of-work gate,
  per-stage cards with turns/duration/tokens/cost/model), **Spec** (source issue, best-effort via
  `gh`/`linear`), **Diff** (colored), **Transcript** (parsed agent stream + Show-raw toggle).
- **Watch mode** — a `notify` file-watcher on `.vanguard/` auto-refreshes the run list and open run as
  files change; in-flight runs surface as pulsing **running** rows with a **live transcript** (assistant
  markdown + tool calls + tokens), before their record even lands.
- **Launch (P1)** — a **New run** form (presets: Run issue / Watch fleet / GitLab MR) spawns a command in
  the project dir inheriting your env; streamed output panel + **Kill**. The launched run then shows live.
- **Remote runs (P4 slice)** — a Local/Remote toggle lists GitHub Actions runs via `gh run list`.
- **Per-project screens** (Inspector sub-nav) — **Runs · Board · Fleet · Remote · Workflow · Settings**:
  - **Task board** — tasks from the configured source (`linear`/`gh`) bucketed into lifecycle columns;
    card → **Task/spec detail** (source spec + run history + New Run). Best-effort (auth-dependent).
  - **Fleet** — Watch Loop start/stop, concurrency, Loop-v1, slot meter (spawns `vanguard watch`).
  - **Workflow** — visual block composer over `.vanguard/app.json` (blocks + inspector + Canvas/Source HCL).
  - **Settings** — the `.vanguard/app.json` config form (source, label, provider, verify, concurrency, budget).
- **Rich output** — markdown rendering, `highlight.js` code/JSON blocks, agent `<plan>`/`<findings>`/
  `<promise>` tags as colored callouts. Light + dark, persisted.

## Architecture

Typed JSON over Tauri IPC is the only boundary. `src/vanguard-output.d.ts` hand-mirrors the persisted
shapes (kept decoupled from Vanguard's build, per the design spec §4).

**Rust (`src-tauri/src/`)** — one module per concern, each with pure functions + unit tests, thin
`#[tauri::command]` wrappers in `lib.rs`:

| Module | Responsibility |
|---|---|
| `runs.rs` | Parse & group `.vanguard/runs` into summaries + run detail (diff/transcript/proof) |
| `active.rs` | Detect in-flight runs (fresh sessions); parse a session into a transcript + token totals |
| `projects.rs` | Persist the project list (OS app-config dir); aggregate per-project metrics + velocity |
| `watch.rs` | `notify` watcher per project → debounced `vanguard:changed` events |
| `spawn.rs` | Launch/kill runs (`sh -c` in the project dir, inherits env); stream output events |
| `spec.rs` | Best-effort fetch of a Task's source issue (`gh`/`linear`) |
| `remote.rs` | List GitHub Actions runs (`gh run list`) |

**React (`src/`)** — `App` (left-rail shell + ⌘K + theme), `features/dashboard`, `features/inspector`
(run list/detail/live/remote/launch/spec), `components/` (reusable `Markdown` / `CodeBlock` / `Callout` /
`AgentText`).

## Notes & limits

- **Credentials** are inherited from the operator environment; the app never stores or brokers them
  (design spec §12). A *bundled* `.app` launched from Finder has a minimal env — run from a terminal for
  now.
- **Launch command** is operator-supplied (a local run launcher, like a terminal) — spawned via `sh -c`
  in the project dir. Not untrusted input.
- **Spec / remote** fetches require an authed `gh` / `linear` on `PATH`; they fail gracefully otherwise.

## Remaining / to harden

Full-product design in `../../design/brief.md`; rendered mockups in `../../docs/design/screens/`.

- **Workflow editor** — currently a config-backed block composer; the full drag-graph + HCL/JSONC
  round-trip (spec §13) awaits the format spike ("spike both").
- **Task board / spec fetch** — best-effort via CLI (`gh`/`linear`); needs live verification against
  authed sources + refined state→column mapping.
- **Remote depth** — live log tail (`glab ci trace`), artifact-download-into-inspector, GitHub↔GitLab
  parity (spec §14).
- **Shell** — the design puts the per-project screens in the left rail (project switcher); the build
  hosts them as an Inspector sub-nav. Cosmetic alignment to the mockups is pending.
