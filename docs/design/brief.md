# Vanguard Inspector — Design Brief (Final, Full-Product)

> **For:** a Designer AI producing high-fidelity mockups for **every screen** of Vanguard Inspector.
> **Status:** Final full-product brief. Covers all phases (P0–P4), not an MVP slice.
> **Deliver:** every screen below, in **light and dark**, at desktop size, with all key states, composed
> from the **chunks-ui** component library and its Tailwind v4 tokens.
>
> Ground truth for scope: `docs/superpowers/specs/2026-07-06-vanguard-desktop-design.md`.
> Ground truth for vocabulary: `CONTEXT.md`. Use its **exact terms** — getting labels right matters.

---

## 1. Product overview

**Vanguard Inspector** is a local **Tauri 2** desktop app (Rust backend · React 19 · Tailwind v4 · the
`chunks-ui` component library) — a **cockpit over Vanguard**, an autonomous software-factory CLI. Vanguard
claims **Tasks** off a **Task Source** (GitHub / GitLab / Linear), runs an AI-agent pipeline inside isolated
git worktrees, gates every **Run** behind a **Proof of Work** command, and opens draft **PRs / MRs** for
human review. The desktop app lets a developer **watch, inspect, drive, configure, and remotely observe**
these Runs — turning "why did this Run fail?" from a JSON-reading errand into a first-class, glanceable
action. The guiding ethos: **watch development happen** — a calm, live window onto the fleet, not a
dashboard template.

**Two personas** (spec §1):

- **Sebastian — mobile / automated.** Specs are filed as issues; a cloud runner picks them up and drives
  Vanguard unattended. Wants minimal UI: a glance from a phone-narrow window, remote observation of
  CI-hosted Runs, high-signal status. The pipeline is the product.
- **Paweł — local / hands-on.** Runs Vanguard locally alongside cloud orchestration and *wants to watch it
  happen* — see the fleet, read live Run traces, inspect failures directly, and eventually launch and steer
  Runs from the app.

Design for both: **legible at a glance** (Sebastian) **and rewarding to lean into** (Paweł).

---

## 2. Design direction — Conductor-forward cockpit

The **preferred aesthetic is [Conductor](https://www.conductor.build/)** (a native macOS SwiftUI app for
running parallel Claude Code agents). Emulate its calm, Mac-native polish. The target reads *"like a
document, not a terminal dump."*

> **Conductor is direction, not law — chunks UI rules style & implementation.** Conductor sets the
> general aesthetic *mood* (calm, classy, Mac-native, quiet chrome). It does **not** dictate concrete
> styling. The **chunks UI design system is the ruling authority** on tokens, components, spacing, and
> implementation — and "Claude Design" already ships it in its toolkit. We do **not** force chunks UI to
> mimic Conductor-specific mechanics (very tight line heights, undersized buttons, hairline-cramped
> controls). Aim for Conductor's *class*, delivered through chunks UI primitives at their native
> proportions. Where the two conflict, **chunks UI wins**; treat Conductor as taste, not spec.

**Adjectives:** calm · precise · Mac-native · quiet · dense-but-breathable · engineered · trustworthy.
Not: flashy, gamified, neon, "SaaS marketing dashboard," heavy gradients, decorative illustration.

**Do**

- Treat this as a **cockpit**, not a template dashboard. Every pixel earns its place; the live fleet is the
  hero.
- **Restrained color.** Surfaces are neutral (background / card / muted). **Status color is used sparingly
  and only to mean something:** green = running / passed, red = failed, amber = warn / verify-issue, sky =
  informational (tool calls, diff hunks), violet = review. A screen at rest should be mostly grayscale.
- **Generous whitespace, quiet chrome.** Thin 1px borders, subtle `bg-muted/30` fills, hairline separators.
  Toolbars are low-contrast and recede.
- **Information density where it pays** — tables, stage cards, transcripts pack in detail — balanced by
  airy headers, summary strips, and clear grouping.
- **Live, not busy.** A single pulsing dot signals "live." Motion is subtle: smooth tab/route transitions,
  gentle auto-scroll of streams. Nothing spins for decoration.
- **Content reads like a document:** markdown with real headings, syntax-highlighted code with copy
  buttons, clickable links, colored diffs, blockquote-style callouts.
- **Keyboard-first affordances:** command palette, quick reload, back navigation.
- **Light AND dark**, first-class in both. Conductor uses a continuous luminance slider; we use a crisp
  light/dark toggle (already built). Design both themes for every frame.

**Don't**

- Don't invent product scope beyond the spec. Don't add marketing hero sections, avatars-of-teammates,
  social feeds, or gauges/speedometers.
- Don't let status color bleed onto non-status surfaces. No full-bleed colored panels for "passed."
- Don't crowd the top bar. Don't stack more than one accent per element.

**Window & responsiveness:** desktop-first, **minimum ~1100×800**, designed to **narrow gracefully** toward
a phone-width column (Sebastian's glance). At full width the target is a **cockpit shell** (persistent left
rail + main content, Conductor-style). Show wide content (tables, diffs, transcripts) inside their own
horizontally-scrolling containers — the page body never scrolls sideways.

> **Note on the built baseline vs the target shell.** The app *today* renders as a single centered
> `max-w-4xl` column under a sticky top bar (see §5 Global / shell). The design **north star** is to evolve
> this into a Conductor-style cockpit: a slim persistent **left rail** (project switcher + primary nav) plus
> a main content region, with the top bar reserved for identity, breadcrumb context, live indicator, and
> global actions. Mock the **target shell**; preserve the built screens' content within it, and mark the
> centered layout as the current built state.

---

## 3. Reference apps — what to borrow, and how it maps

### 3a. Conductor (PRIMARY — the look to hit)

Native macOS SwiftUI. Concrete patterns to emulate and how they map onto Vanguard:

| Conductor pattern | What it looks like | Map onto Vanguard |
|---|---|---|
| **Three-panel workspace layout** | Left: workspace sidebar (each workspace named after a city). Middle: agent chat/conversation. Right: live git **diff** + integrated **terminal**. | **Run detail / Live Run** as a 2–3 pane view: left = Run/stage nav, center = agent transcript, right = diff (and, for launched Runs, a log/terminal tail). |
| **Workspace sidebar shows PR title or branch, git status, lifecycle logs at a glance** | Compact rows, quiet status glyphs, "at a glance what each agent is doing." | **Left rail / project rail**: each project and each running Run shows a one-line status (branch/Task id, Claim state, live dot, last activity). |
| **Side-by-side diff, auto-fallback to unified in narrow windows** | PR-review-style diff, toggle side-by-side vs inline. | **Diff tab / diff pane**: default to the built colored unified diff; offer side-by-side at wide widths, unified when narrow. |
| **Status bar: per-turn cost, budget tracking, token %, savings** | Persistent, quiet metrics row. | **Run cost strip**: per-stage cost, tokens, cache efficiency, budget cap vs remaining. Reuse Vanguard's already-persisted cost data. |
| **Command palette (Cmd+K), session browser (Cmd+S), dashboard toggle (Tab)** | Keyboard-driven, actions grouped by category. | **Command palette** (open project, open Run, launch Run, toggle theme, jump to Task board) — a designed Future screen. |
| **Markdown that "reads like a document"** — blockquotes, code with line numbers + copy buttons, links | Content pane feels editorial, not console. | Already partly built (`Markdown`, `CodeBlock`, `Callout`, `AgentText`). Keep this quality bar across all agent output. |
| **Vibe-Coder / distraction-free mode (hide tools + metadata)** | Collapses tool noise to just the prose. | Maps to the built **Show raw ↔ Formatted** transcript toggle; extend to a "prose only" density control. |
| **Toasts summarizing events (e.g. context compaction)** | Non-blocking, summarizing. | Toasts for Run started / Run complete / Proof failed / process exited. |
| **Each task = its own workspace/branch/terminal/diff/review path; review → PR → merge → archive** | Lifecycle is visible and linear. | A **Run** already *is* a worktree + branch + Proof + draft PR/MR. Surface that lifecycle explicitly. |

**Aesthetic takeaways:** quiet chrome, thin borders, restrained color, generous spacing, keyboard-driven,
document-quality content, a persistent low-contrast metrics/status strip, native-feeling window with
traffic-light-aware top bar padding.

### 3b. Vibe Kanban (SECONDARY — the task-board reference)

React + Rust; a kanban board to orchestrate coding agents. Borrow specifically for the **Task board** and
**Task detail** screens:

| Vibe Kanban pattern | Map onto Vanguard |
|---|---|
| **Board columns = lifecycle states** (To Do → In Progress → Review → Done) | Columns = the **Task Source label lifecycle**: `queued → claimed → running → verify-failed → review → done`, derived from issue labels + `metrics.jsonl`. On GitLab these are **Scoped Labels** (`vanguard::running`, `vanguard::review`). |
| **Cards = tasks/agent runs with debug metadata** | **Task cards**: Task id + title, Claim state chip, running dot, last Run status, cost, #Runs. |
| **Card carries full context** (acceptance criteria, file paths, constraints) | Task card → **Task detail** shows the source-issue spec text. |
| **Task detail: title, description, list of attempts, "+" to create attempt, pick agent profile** | Task detail = **spec pane + Run history**; "+" = **launch a new Run**, picking `provider` / `reviewProvider`. |
| **Multiple attempts, mark success/failure; compare diffs; inline comments back to agent; reject → new attempt** | Multiple **Runs** per Task; compare Run diffs; a Run's Proof + stages stand in for success/failure. (Inline-comment-to-agent is out of current scope; may inform the launch/re-run flow.) |

Use Vibe Kanban for **board structure and card/attempt semantics only** — render it in the *Conductor*
visual language (calm, quiet), not Vibe Kanban's brighter styling.

---

## 4. Design system & foundations

### 4a. Component library — compose from **chunks-ui** (shadcn-like, built on Base UI)

The Designer must build every screen from these exported components (do not invent new primitives):

`Accordion` · `Avatar` · `Breadcrumb` · `Button` · `Calendar` · `Card` · `Checkbox` · `Chip` ·
`ClearButton` · `Collapsible` · `Combobox` · `CopyButton` · `DatePicker` · `Dialog` · `Drawer` · `Empty` ·
`Field` · `IconButton` · `Input` · `InputCopy` · `Label` · `Loader` · `Menu` · `NumberField` · `Pagination`
· `Popover` · `Progress` · `Radio` · `ScrollArea` · `Select` · `Separator` · `Skeleton` · `Slider` ·
`Switch` · `Table` · `Tabs` · `Textarea` · `ThemeToggle` · `ToggleGroup` · `Tooltip` · `Toast`
(`createToastManager`). Utilities: `cn`, `springs`, `useMotion`, `useReducedMotion`.

**Component → screen cheatsheet:** `Card` (project cards, stage cards, proof gate, running rows) · `Table`
(Run list, remote runs) · `Tabs` (Run detail Overview/Diff/Transcript) · `Breadcrumb` (shell nav) · `Chip`
(status: running/passed/failed/warn, Claim state, "N in 24h") · `Empty` (no projects / no runs / no tasks) ·
`Dialog` (launch Run, confirm kill, add project) · `Drawer` (Task detail, node inspector in workflow editor)
· `Select` / `Combobox` (provider + reviewProvider, label filter, model) · `NumberField` / `Slider`
(concurrency, budget cap) · `Switch` (Watch Loop on/off, Loop v1 toggle, theme) · `ToggleGroup` (board ↔
list view, side-by-side ↔ unified diff) · `Progress` (budget cap vs remaining) · `Skeleton` / `Loader`
(loading states) · `Toast` (Run lifecycle events) · `Tooltip` (metric definitions) · `CopyButton` /
`InputCopy` (SHA256, PR/MR URL, command) · `Popover` / `Menu` (row actions, command palette items).

### 4b. Tokens — Tailwind v4, shadcn-style CSS variables

Semantic tokens (light + dark via a `.dark` class on `:root`): `background` · `foreground` · `card` ·
`card-foreground` · `muted` · `muted-foreground` · `border` · `input` · `ring` · `primary` ·
`primary-foreground` · `secondary` · `destructive` · `success` · `warning`. A **radius scale** and a spacing
scale come from Tailwind v4. Design against the tokens, never hard-coded hex — so both themes derive
automatically.

**Status palette (use sparingly, only for meaning):**

| Meaning | Token / color | Where |
|---|---|---|
| Running / live / passed | `success` / success | live dot, running chip, passed chip, accent stat |
| Failed / error | `destructive` / destructive | failed chip, proof-fail output, diff `-` lines, error banners |
| Warn / verify-issue / incomplete stage | `warning` / warning | stage `exitReason` chip, verify-failed column, findings callout |
| Informational (tool calls, diff hunks, plan) | sky-500 | `→` tool lines, `@@` diff hunks, plan callout |
| Review | violet-500 | review callout / review stage accent |

Numbers use **tabular-nums**. Muted metadata uses `text-muted-foreground` at `text-xs`.

### 4c. Typography, spacing, radius

- **Type scale:** app/system UI sans for chrome and body; **monospace** for code, diffs, transcripts,
  commands, SHA256, Task ids, timestamps. Headings are modest (`font-semibold`, `text-base`/`text-lg`) —
  no oversized display type. Metadata `text-xs`, body `text-sm`.
- **Spacing:** vertical rhythm around `space-y-2 / -3 / -4`; card padding `p-3`/`p-4`; page padding `p-4`.
  Prefer roomy over cramped, but tables and stage cards may be dense.
- **Radius:** rounded cards/inputs from the radius scale; pills fully rounded (`Chip`, live dot).

### 4d. Brand mark & identity

- **Logo:** the **shield-cog** mark (a shield with a cog/gear inset) — an inline SVG using `currentColor`,
  sized via className, tinted `text-primary` in the top bar. It reads as *guardian + machinery*: the
  autonomous factory that guards quality behind Proof of Work.
- **Wordmark:** "**Vanguard**" `font-semibold` beside the mark; a small `Chip` (e.g. "Inspector") denotes
  the active mode.
- **Iconography:** **lucide-react**, thin stroke, matched to the shield-cog line weight. Seen in the built
  app: `Home`, `RefreshCw`, `FolderPlus`, `LayoutGrid`, `Inbox`, `X`. Extend consistently (e.g.
  `Play`/`Square` for launch/kill, `GitBranch`, `Boxes`/`Layers` for fleet, `Cloud` for remote, `Settings`,
  `Search`/`Command` for palette).

### 4e. Motion

Subtle and purposeful (respect `useReducedMotion`): the **pulsing "live" dot** (`animate-pulse` green),
smooth **tab indicator** slide and route/pane transitions (`springs`), gentle **auto-scroll** of live
streams to the newest line, quiet hover elevation on clickable cards/rows (`hover:border-primary/40`). No
decorative spinners; loading is `Skeleton`/`Loader`.

---

## 5. Navigation & information architecture

**Shell (target, Conductor-style cockpit):**

- **Top bar** (built, keep): sticky, translucent (`bg-background/80 backdrop-blur`), 1px bottom border.
  Left → right: shield-cog logo (`text-primary`) · "Vanguard" wordmark · mode `Chip` · **breadcrumb**
  context · **live** indicator (pulsing dot + "live") · right-aligned global actions (Reload, command
  palette trigger, `ThemeToggle`).
- **Left rail** (target, Future): project switcher + primary nav (Dashboard, Task board, Remote, Fleet,
  Settings). Collapsible; each running Run may appear as a live sub-row (Conductor's workspace list).
- **Main content:** the active screen.

**Breadcrumb model (built):** `Home / <project> / <Task id> [ / <tab context> ]`. `Home` = the shield/house
icon returns to Dashboard; `<project>` returns to the project's Run list/board; `<Task id>` is the current
Run/Task. Clicking a crumb navigates up; the deepest crumb is the current page.

**Connections / deep-linking:** Dashboard project card → Project view (Run list or board). Project board card
→ Task detail. Task detail attempt → Run detail. Running row → Live Run. Run detail tabs (Overview / Diff /
Transcript) preserve breadcrumb + selected Run. Remote runs → an artifact opens in the same Run inspector.
Back/up always follows the breadcrumb; the app uses in-memory routing (`MemoryRouter`) so navigation is
instant and stateful.

---

## 6. Full screen inventory

**Legend — status:** **Built** (exists in `apps/desktop/src`) · **Partial** (partly built) · **Future**
(designed here, not yet implemented). **Phase** per spec §9: P0 Inspector (read-only) · P1 Launch · P2 Fleet
· P3 Remote/two-axis · P4 Workflow editor & SQLite (spec §13).

| # | Screen | Status | Phase | One-line purpose |
|---|---|---|---|---|
| 6.1 | Global shell (top bar, left rail, breadcrumb) | Built (top bar) / Future (rail) | P0/P2 | Identity, nav, live indicator, global actions |
| 6.2 | Dashboard / Home | Built | P0 | Projects grid + cockpit summary strip |
| 6.3 | Project view — Run list | Built | P0 | Table of Runs + running-Runs section |
| 6.4 | Project view — Board | Future | P2/P3 | Kanban of Tasks by label lifecycle |
| 6.5 | Run detail — Overview | Built | P0 | Proof gate + per-stage cards |
| 6.6 | Run detail — Diff | Built | P0 | Colored diff of the Run |
| 6.7 | Run detail — Transcript | Built | P0 | Agent transcript (raw ↔ formatted) |
| 6.8 | Live Run | Partial | P0/P1 | Streaming agent transcript + live cost |
| 6.9 | Task board | Future | P3 | Tasks from the Task Source as lifecycle columns |
| 6.10 | Task / spec detail | Future | P3 | Source spec pane + Run history |
| 6.11 | New Run / launch flow | Future | P1 | Pick Task + provider + options → spawn; kill |
| 6.12 | Fleet control | Future | P2 | Start/stop the Watch Loop with concurrency |
| 6.13 | Remote runs | Future | P3 | CI-hosted Runs via gh/glab; two-axis model |
| 6.14 | Workflow editor | Future | P4 | Visual flag-composer node graph |
| 6.15 | Settings | Future | P1/P2 | Per-project config, providers, theme, remote host |
| 6.16 | Command palette | Future | P1 | Keyboard-driven action launcher |
| 6.17 | Global states & overlays | Built/Future | all | Empty / loading / error / toast / dialog conventions |

---

### 6.1 Global shell — top bar · left rail · breadcrumb  · *Built (top bar) / Future (rail)*

- **Purpose:** persistent identity + navigation + live status.
- **Layout:** sticky top bar (see §5). Target adds a collapsible left rail (project switcher + primary nav).
- **Key components:** `Breadcrumb`, `Chip`, `ThemeToggle`, `Button`/`IconButton`, `Tooltip`, `Separator`.
- **Data:** active project/Task/tab; whether the filesystem watcher is live; theme.
- **States:** default · **live** (pulsing green dot + "live") · not-watching (dot hidden) · deep breadcrumb
  (3 crumbs) · narrow (rail collapses to icons; breadcrumb truncates with `Breadcrumb.Ellipsis`).

### 6.2 Dashboard / Home  · *Built · P0*

- **Purpose:** at-a-glance fleet overview across all tracked projects.
- **Layout:** header row ("Projects" + **Add project** button) · **cockpit summary strip** · responsive
  **project cards grid** (`sm:grid-cols-2`, target up to 3 at wide widths).
- **Key components:** `Card` (project), `Button` (`FolderPlus` add), `Chip` ("N in 24h"), `Empty` (no
  projects), summary `Stat` tiles, `X`/`IconButton` (remove), pulsing live dot.
- **Data / summary strip:** **Projects · Running · Runs · Last 24h · Spend** (`$` total). Each **project
  card:** name (+ "N running" with pulsing dot when active), repo path (muted, truncated), `N runs`,
  `N tasks`, `$cost`, `N failed` (destructive), "N in 24h" chip, relative last-Run time, remove (X).
- **States:**
  - *Empty* — `Empty` block: "No projects yet / Add a repo containing `.vanguard/runs`" + Add action.
  - *Loading* — `Skeleton` cards + skeleton strip.
  - *Populated at rest* — mostly grayscale; only "Running" stat + running dots carry green.
  - *Live* — running counts tick; cards with active Runs show the green pulse.
  - *Error* — inline destructive banner (`border-destructive/40 bg-destructive/10`).
- **Interactions:** click card → Project view; add via native directory picker; remove via X (stop
  propagation). Polls ~5s to keep counts live.

### 6.3 Project view — Run list  · *Built · P0*

- **Purpose:** every Run for a project, newest first, plus what's running now.
- **Layout:** breadcrumb `Home / <project>`; header actions (Reload, live indicator, status chips);
  **Running-Runs section** (pulsing cards) above the **Run table**. Target adds a **board ↔ list**
  `ToggleGroup` (list built; board = 6.4).
- **Key components:** `Table` (Run list), `Card` (running rows), `Chip` (status), `Button` (Reload,
  `RefreshCw`), `Empty` (no runs), pulsing dot.
- **Data — Run table columns:** **Task** (id) · **When** (`YYYY-MM-DD HH:MM`, tabular) · **Stages**
  (comma list, e.g. implementer, reviewer, simplifier) · **Cost** (`$`, right-aligned) · **Status**
  (`passed` success / `failed` destructive chip). **Running-Runs cards:** pulsing green dot · Task id ·
  `running` chip · "Ns ago" last activity.
- **States:** *empty* (`Empty`: "No runs found / no `.vanguard/runs` yet") · *loading* (skeleton rows) ·
  *live* (running section present, rows update on FS events) · *no active Runs* (running section hidden) ·
  *error* (banner). Rows are **clickable** (`cursor-pointer`) → Run detail; running cards → Live Run.

### 6.4 Project view — Board  · *Future · P2/P3*

- **Purpose:** the same project as a **kanban** — Runs/Tasks by lifecycle instead of a flat table.
- **Layout:** horizontal **columns = label lifecycle**: `queued → claimed → running → verify-failed →
  review → done`. Column header shows count. Cards are compact Run/Task summaries. Scrolls horizontally
  inside its own container.
- **Key components:** `Card` (column card), `Chip` (Claim/label state), `ScrollArea`, `ToggleGroup` (board ↔
  list), `Empty` per column, pulsing dot on the `running` column.
- **Data:** each card = Task id + short title, current Claim/label state, running dot, last Run status +
  cost. `running` column mirrors the Running-Runs section.
- **States:** empty column ("nothing here") · fully-loaded board · live (cards animate between columns as
  labels change) · error banner. Reference: **Vibe Kanban** structure, **Conductor** calm styling.

### 6.5 Run detail — Overview tab  · *Built · P0*

- **Purpose:** the headline inspection surface — did the Run pass, and what did each stage do?
- **Layout:** `Tabs` (**Overview** / Diff / Transcript). Overview = **Proof-of-Work gate card** on top, then
  a stack of **per-stage cards**.
- **Key components:** `Tabs`, `Card` (proof gate + stage cards), `Chip` (passed/failed, exitReason),
  `AgentText` (final text), `CopyButton` (SHA256/command), monospace `pre`.
- **Data — Proof gate:** title "Proof of work", `passed`/`failed` chip, `command` (mono) · `exit N`,
  `outputTail` in a scrollable `pre` (**red text when failed**), border turns destructive on fail.
  **Stage card** (per pipeline stage — implementer / reviewer / simplifier): stage name, `exitReason` chip
  (`success` when completed else `warning`), meta row (`N turns · Ns · in/out tok · $cost · model`), and the
  stage's `finalText` rendered via `AgentText` (agent `<tag>` blocks → callouts).
- **States:** *passed* (green chips, neutral surfaces) · *failed* (destructive proof card + red output) ·
  *no proof recorded* ("No proof-of-work recorded.") · *incomplete stage* (amber exitReason) · *loading*
  (skeleton cards).

### 6.6 Run detail — Diff tab  · *Built · P0*

- **Purpose:** read the code change the Run produced (rendered from the Run's git bundle).
- **Layout:** full-width scrollable monospace diff (`max-h-[32rem] overflow-auto`). Target: optional
  side-by-side at wide widths via `ToggleGroup` (Conductor pattern), unified when narrow.
- **Key components:** colored `pre` diff, `ToggleGroup` (unified ↔ side-by-side), `Empty`/muted "No diff
  captured."
- **Data / colors:** `+` added → green (`bg-success/10`); `-` removed → red (`bg-destructive/10`); `@@` hunks
  → sky; file headers (`diff `, `+++`, `---`) → muted bold; context → `foreground/80`.
- **States:** with diff · *no diff* ("No diff captured.") · very large diff (scrolls within container) ·
  loading.

### 6.7 Run detail — Transcript tab  · *Built · P0*

- **Purpose:** read the full agent transcript for the Run.
- **Layout:** right-aligned **Show raw ↔ Formatted** toggle over the transcript body.
- **Key components:** `Button` (toggle), `StreamView`, `AgentText`, `Markdown`, `CodeBlock`, `Callout`,
  scrollable container.
- **Data / rendering (StreamView roles):** `assistant` → `AgentText` (markdown + agent `<tag>` callouts) ·
  `tool` → `→ …` sky mono line · `tool_result` → `← …` truncated muted mono · other → `✓ …` muted.
  **Raw** mode shows the untouched stream-json in a mono `pre`.
- **States:** formatted (default) · raw · *no transcript* ("No transcript.") · *no parseable transcript* ·
  loading.

### 6.8 Live Run  · *Partial · P0/P1*

- **Purpose:** watch an in-flight Run stream its agent activity in real time — the "watch development
  happen" moment.
- **Layout (built):** a single scrolling stream panel (`bg-muted/30`, bordered) that auto-scrolls to the
  newest line. **Target (Conductor three-pane):** center = live transcript, right = live **diff** as it
  grows + optional **terminal/log tail**, plus a live **cost strip** (per-turn cost, tokens, budget cap vs
  remaining) along the bottom.
- **Key components:** `StreamView` / `AgentText`, live `Chip` (`running`), pulsing dot, `Progress` (budget),
  `Button` (**Kill** — Future, `Square` icon), cost `Stat`s.
- **Data:** streamed session lines (assistant / tool / tool_result); last-activity time; live tokens & cost;
  budget cap and remaining (spec §10).
- **States:** *waiting* ("Waiting for output…") · *streaming* (lines append, auto-scroll, live dot) ·
  *completed* (transitions into the static Run detail) · *killed / process-exited* (toast + terminal state)
  · *error*.

### 6.9 Task board  · *Future · P3*

- **Purpose:** the **Tasks** in a project's **Task Source** (GitHub / GitLab / Linear) as a lifecycle
  board — before, during, and after Runs. (Vibe-Kanban-like.)
- **Layout:** columns by **label / state lifecycle**: `queued → claimed → running → verify-failed → review →
  done`. On GitLab these are **Scoped Labels** (`vanguard::running`, …); on Linear these are workflow
  states. Task **cards** carry id + title + Claim state + running dot + latest Run status.
- **Key components:** `Card`, `Chip` (label/Claim state), `ScrollArea`, `Select`/`Combobox` (label filter,
  source), `Empty`, `Button` (New Run / launch), pulsing dot.
- **Data:** Tasks from the configured Task Source (spec text sourced from the issue), joined with local Run
  history + `metrics.jsonl` to place each in a column.
- **States:** empty source · loaded board · live (cards move columns as Claim/label changes) · filtered ·
  error / source-unreachable banner. Click a card → **Task detail** (6.10).

### 6.10 Task / spec detail  · *Future · P3*

- **Purpose:** the source spec alongside that Task's Run history — decide, launch, compare.
- **Layout:** two-column (or `Drawer` at narrow width): **left** = the source-issue **spec pane** (markdown
  title + body from the Task Source); **right** = **Run history** for this Task (a mini Run list, newest
  first) + a **New Run** action ("+ attempt", Vibe-Kanban semantics).
- **Key components:** `Markdown` (spec), `Table`/`Card` (Run history), `Chip` (Claim state, per-Run status),
  `Button` (New Run), `Breadcrumb` (`Home / project / Task`), `Drawer` (narrow), `CopyButton` (issue URL).
- **Data:** Task id, title, spec body, Claim state, PR/MR link, list of Runs (timestamp, stages, cost,
  passed/failed).
- **States:** no Runs yet ("No attempts yet" `Empty`) · has Runs · claimed/running (live dot) · spec
  missing/unreachable · loading (skeleton spec + rows). Click a Run → Run detail (6.5).

### 6.11 New Run / launch flow  · *Future · P1*

- **Purpose:** launch a single **Run** for a Task, and stop it.
- **Layout:** a `Dialog` (or right `Drawer`) launched from Task detail / board / command palette. Fields
  grouped: **Task** (preselected or picker) · **provider** and **reviewProvider** (`Select`/`Combobox` from
  `PROVIDER_NAMES`; reviewProvider optional so review can run cheaper) · **model** · **verify command**
  override · **budget cap** (`NumberField`) · primary **Launch** button.
- **Key components:** `Dialog`/`Drawer`, `Select`/`Combobox` (provider, reviewProvider, model), `Input`
  (verify command), `NumberField`/`Slider` (budget), `Field`/`Label`, `Button` (Launch / Cancel), `Toast`
  (spawned), `Chip`. **Kill control:** a `Square` **Stop** button on the Live Run + a confirm `Dialog`.
- **Data:** available providers/reviewProviders, models, default verify command, budget defaults (from
  project config, §6 `app.json`).
- **States:** default (valid) · missing required field (`Field` error) · launching (button `loading`) ·
  spawned (toast → Live Run) · kill-confirm dialog · kill-in-progress · spawn error (banner). **Note:** the
  app spawns the CLI with the composed flags; **credentials are inherited from the environment, not entered
  here** (spec §12 — auth is out of scope/undecided; never show a secret field).

### 6.12 Fleet control  · *Future · P2*

- **Purpose:** start/stop the autonomous **Watch Loop** for a project with bounded concurrency.
- **Layout:** a **Fleet** panel: a big **Watch Loop** on/off `Switch`, a **concurrency** control
  (`NumberField`/`Slider`), an optional **Loop v1** toggle (cheap spec-generation pass first), and a live
  **fleet strip** listing currently-claimed/running Tasks (mirrors Conductor's workspace list).
- **Key components:** `Switch` (Watch Loop, Loop v1), `NumberField`/`Slider` (concurrency), `Card`/`Table`
  (active Runs), `Chip`/pulsing dot (per-slot status), `Progress` (slots in use / concurrency), `Button`
  (Stop all), `Toast`.
- **Data:** loop running? concurrency; number of slots busy; list of claimed/running Tasks; recent
  completions.
- **States:** *stopped* (idle) · *starting* · *running* (slots fill, live dots, cards flow) · *at capacity*
  (all slots busy) · *stopping* · *error*. Emphasize the two-pass difference when **Loop v1** is on.

### 6.13 Remote runs  · *Future · P3*

- **Purpose:** observe **CI-hosted Runs** (spawned by a cloud runner, not the local machine) — Sebastian's
  remote-observation need — surfacing the **two-axis model: Task Source × Runner host**.
- **Layout:** a **Remote** screen with a two-axis header (Task Source: GitHub/GitLab/Linear · Runner host:
  local vs CI), then a **Table** of remote Runs (status · started · duration · Task · pipeline/job). Opening
  a remote Run shows a **live tail** (GitLab pipeline logs via `glab`) **or step-status** (GitHub checks via
  `gh`), and an **artifact → inspector** action that loads a fetched Run into the same Run detail (6.5).
- **Key components:** `Table` (remote Runs), `Chip` (CI status; running/passed/failed), `Tabs` (Log tail ↔
  Steps), streaming `pre` (GitLab tail), step list (GitHub checks), `Button` (Open artifact in inspector),
  `Select` (source / host filter), `Empty`, `Tooltip`.
- **Data:** remote Run status + timing from the **Runner** CLI (`gh` for GitHub, `glab` for GitLab); GitLab
  gives a **live log tail**, GitHub gives **step/check status**; downloadable artifacts map back to the
  local inspector.
- **States:** no remote Runs · listed · live-tailing (GitLab) · step-status polling (GitHub) · artifact
  loading · runner-CLI unavailable / not-authed (guidance banner) · error. Make the **PR vs MR** distinction
  explicit (GitHub = PR, GitLab = MR).

### 6.14 Workflow editor  · *Future · P4 (spec §13)*

- **Purpose:** a **visual flag-composer** — build a Run/fleet configuration out of blocks instead of writing
  CLI flags/scripts, round-tripped to an HCL/JSONC file.
- **Layout:** a **node/block canvas** (left→right flow) over the CLI flag surface, with a right **inspector
  panel** for the selected node. Nodes/blocks: **Repo**, **Task Source** (+ label filter), **Models**
  (provider / reviewProvider), **Concurrency**, **Verify / Proof of Work**, **Budget**. A left **palette** of
  block types; a bottom/side **source preview** of the generated HCL/JSONC.
- **Key components:** node `Card`s + connectors (custom, styled in chunks-ui language), right **inspector**
  `Drawer`/panel with `Field`/`Select`/`NumberField`/`Switch`/`Input`, `ToggleGroup` (canvas ↔ source),
  `CodeBlock` (generated config), `Button` (Save / Validate), `Callout` (validation warnings).
- **Data:** the composed flag graph ↔ a declarative workflow file (round-trip). Mirrors `spawn_run` /
  `spawn_watch` flags: repo, source, label, models, concurrency, verify, budget.
- **States:** empty canvas (start block) · composing · node selected (inspector populated) · invalid config
  (node error + callout) · source-view · saved · dirty/unsaved. Clarify this depends on a Vanguard-side
  declarative-workflow capability (spec §13) — design it as an aspirational, cohesive editor.

### 6.15 Settings  · *Future · P1/P2*

- **Purpose:** per-project config (the app's own `.vanguard/app.json`, spec §6) + app-wide preferences.
- **Layout:** left settings nav (or `Tabs`): **Project** (repo path, Task Source, label filters, verify
  command override, concurrency, model) · **Providers** (provider + reviewProvider defaults from
  `PROVIDER_NAMES`) · **Credentials** (read-only note) · **Remote** (Runner host / CI settings) ·
  **Appearance** (theme). Right = the form.
- **Key components:** `Field`/`Label`/`Input`/`Textarea` (paths, verify command), `Select`/`Combobox`
  (source, provider, reviewProvider, model), `NumberField`/`Slider` (concurrency, budget), `Switch`
  (Loop v1, toggles), `ThemeToggle`, `Separator`, `Button` (Save), `Callout`/`Tooltip` (credentials note),
  `InputCopy` (config path).
- **Data:** the `app.json` fields (repo path, provider, label filters, verify override, concurrency, model);
  theme; remote runner host.
- **States:** clean · dirty (Save enabled) · saving · saved (toast) · validation error (`Field` error) ·
  **credentials note** (informational `Callout`: *"LLM credentials are inherited from your environment /
  keychain and never stored by the app or sent over any API"* — spec §12; never render a secret input).

### 6.16 Command palette  · *Future · P1 (suggested)*

- **Purpose:** keyboard-driven launcher (Conductor's Cmd+K), actions grouped by category.
- **Layout:** centered `Dialog` with a search `Input` + grouped result list (`Menu`/`Combobox`): **Go to**
  (project, Task board, Remote, Fleet, Settings) · **Actions** (New Run, Start/Stop Watch Loop, Reload,
  Toggle theme) · **Recent** (Runs, Tasks).
- **Key components:** `Dialog`, `Combobox`/`Command`-style list, `Menu`, `Chip` (category), keyboard hints.
- **States:** open (empty query → recents/suggestions) · typing (filtered) · no match (`Empty`) · executing.

### 6.17 Global states & overlays  · *Built + Future · all screens*

- **Empty:** always the `Empty` component — media icon + title + description + optional action (e.g. "No
  projects yet", "No runs found", "No attempts yet").
- **Loading:** `Skeleton` for lists/cards, `Loader`/button `loading` for actions. Avoid layout shift.
- **Error:** inline banner (`rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm
  text-destructive`) at the top of the affected region; never a blocking modal for transient errors.
- **Toasts:** `Toast` (`createToastManager`) for lifecycle events — Run spawned, Run complete, **Proof
  failed**, process exited/killed, config saved.
- **Dialogs:** `Dialog` for launch/confirm-kill/add-project/command-palette; `Drawer` for Task detail and
  the workflow node inspector at narrow widths.
- **Live indicator:** the pulsing green dot + "live" text whenever the filesystem watcher (or event stream)
  is active. Design its presence/absence in the top bar for every relevant frame.

---

## 7. Component states & interaction spec

- **Status chips (`Chip`):** `running` (success, outlined) · `passed` (success, solid) · `failed`
  (destructive, solid) · `warn`/exitReason (warning, outlined) · Claim/label states ("queued", "claimed",
  "review", …). One chip = one meaning; don't stack.
- **Live indicator:** `size-2 rounded-full bg-success animate-pulse` + optional "live"/"N running" text.
  Used on project cards, running rows, the top bar, board `running` column, fleet slots.
- **Tables (`Table`):** header row + clickable body rows (`cursor-pointer`, hover elevation), tabular-nums
  for time/cost, right-aligned numeric columns, status chip in the last column. Long lists → `Pagination`.
- **Tabs (`Tabs`):** `Tabs.List` + animated `Tabs.Indicator`; panels padded `pt-4`. Used for Run detail and
  Remote (Log ↔ Steps).
- **Code / markdown / diff:** `CodeBlock` (highlight.js, mono, copy button); `Markdown` (document-quality
  prose, links, blockquotes); diff colors per §6.6. Everything mono in a bordered `bg-muted` container.
- **Agent tags → callouts (`Callout` via `AgentText`):** agents emit `<plan>`, `<findings>`, `<promise>`,
  `<review>` blocks. Long blocks → left-accent `Callout` (plan = sky, findings = amber, promise = green,
  review = violet, other = border); short inline tags → a small `Chip` (`tag: value`). Uppercase muted
  label above the callout body.
- **Cards (`Card`):** clickable cards get `cursor-pointer hover:border-primary/40 transition-colors`;
  fail/attention state gets a `border-destructive/40` (proof fail) or `border-success/40` (running).
- **Buttons:** primary action solid; secondary/reload as `variant="text" color="secondary"` with a lucide
  start icon; destructive (kill) clearly styled + confirm dialog.

---

## 8. Domain vocabulary (glossary — use these EXACT labels in every design)

From `CONTEXT.md` — the words on screen must match:

- **Task Source** — the pluggable integration to an external task system (GitHub / GitLab / Linear). *Not*
  "provider / plugin / integration" in UI copy about the source. (Note: LLM **provider** is a separate,
  correct term for models.)
- **Task** — the unified internal work item, whatever its origin. *Not* "issue / ticket / item."
- **Task Fetcher** — the contract a Task Source implements (`fetch`/`list`). (Internal; rarely on screen.)
- **Watch Primitives** — the five loop operations (`listReady`, `claim`, `runOne`, `review`, `onFailure`).
- **Claim** — marking a Task in-progress so later polls skip it (adds a state label on GitHub/GitLab; moves
  state on Linear). *Not* "lock / assign / take."
- **Run** — one end-to-end execution: fetch a Task → implement in a sandbox → commit → open a draft PR/MR.
  *Not* "job / execution / task run."
- **Watch Loop** — the autonomous polling mode (list ready Tasks → Claim → Run), no human in the loop.
  *Not* "AFK loop / cron / daemon."
- **Loop v1** — a two-pass Watch Loop variant: a cheap spec-generation pass precedes the full agent pass;
  the spec pass labels vague Tasks as needing info.
- **Proof of Work** — the verification command run in the sandbox after the agent finishes; failure **flags**
  the PR/MR but does not block it. *Not* "verify step / sandbox test." (Built UI label: "Proof of work".)
- **Scoped Label** (GitLab) — a `::`-scoped, mutually-exclusive label; Vanguard's state labels
  (`vanguard::running`, `vanguard::review`, …). Use for board columns on GitLab.
- **MR** — a GitLab **Merge Request** (the GitLab equivalent of a PR). Say **MR** for GitLab, **PR** for
  GitHub — never "PR" when the source is GitLab.
- **Runner** — the CLI Vanguard shells out to for platform ops: `gh` (GitHub), `glab` (GitLab), `linear`
  (Linear). *Not* "CLI / client / SDK" in this sense.

Additional on-screen terms from the built app: **Stage** (pipeline stage: implementer / reviewer /
simplifier), **exitReason**, **turns**, **cost / spend**, **cache efficiency**, **budget cap / remaining
budget**.

---

## 9. Deliverables for the Designer AI

Produce **high-fidelity frames** for **every screen in §6** (6.1–6.17), each:

1. In **both light and dark** themes (tokens per §4b; `.dark` class semantics).
2. At **desktop size** (design canvas ~1440×900; the app's real minimum is **~1100×800**) **and** a
   **narrowed** variant showing graceful reflow toward a phone-width column (Sebastian's glance) — at least
   for Dashboard, Project view, Run detail, and Task board.
3. With **all key states** called out (empty · loading/skeleton · error · at-rest · **live** · success/passed
   · fail): Dashboard (empty, populated, live); Run detail (passed, failed, no-proof); Live Run (waiting,
   streaming, killed); Task board (empty column, live flow); Remote (list, live-tail, step-status, not-authed);
   launch dialog (default, error, launching); Settings (clean, dirty, credentials note); command palette
   (suggestions, filtered, no-match).
4. **Composed strictly from chunks-ui** (§4a) with its tokens, radius, and typography — no off-system
   primitives; status color used sparingly per §4b.
5. In the **Conductor-forward** visual language (§2–3): calm, Mac-native, quiet chrome, generous
   whitespace, restrained color, document-quality content, the pulsing live dot, subtle motion.
6. Carrying the **shield-cog** logo + "Vanguard" wordmark + mode chip in the top bar, and the **exact
   domain labels** from §8 everywhere.

Also provide: the **cockpit shell** (top bar + left rail + breadcrumb) as a reusable frame; the **status /
chip / live-indicator** system as a small component sheet; and the **board column lifecycle**
(`queued → claimed → running → verify-failed → review → done`) as a labeled reference.

**Explicitly mark each frame Built vs Future** (per §6 table) so implementation can prioritize P0 (Inspector)
first and treat P1–P4 as the roadmap.
