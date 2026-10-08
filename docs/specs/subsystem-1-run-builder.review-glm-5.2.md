# Review — Subsystem 1: Structured Run Builder

**Reviewer:** Claude Sonnet 4.5
**Date:** 2026-07-11
**Spec:** [`subsystem-1-run-builder.md`](./subsystem-1-run-builder.md)
**Method:** Every factual claim cross-checked against the current codebase (anchors verified by reading the files, not just trusting the spec's self-citations).

**Verdict:** The plan is sound and its core technical thesis is correct. It is **ready to implement after addressing the lifecycle gap (Finding 3)**, which is the one item that isn't covered by the acceptance criteria but will bite during build. Everything else is minor / clarifying.

---

## Summary

The spec accurately reads the code it builds on. Part 1 (the `repoPath` fix) is correct and well-motivated — I confirmed the sidecar is genuinely cwd-blind. Parts 2–3 are feasible with the UI primitives that exist today. The main hole is a **run-lifecycle / reconnect gap**: a typed-API run is only live while the component that started it stays mounted and holds the `api:event` stream, and the spec doesn't say how (or whether) it survives navigation or shows up in the runs table. That deserves an explicit decision before implementation, not "during build".

Findings are tagged: 🟢 confirmed-accurate · 🟡 clarification/heads-up · 🔴 gap/blocker · 🛠 suggestion.

---

## Findings

### 🟢 F1 — The spec's central premise (sidecar is cwd-blind) is correct and verified

The spec says: *"Today the sidecar is a cwd-blind singleton and `productionDeps().createRun` uses `process.cwd()`."* Verified true, and the contrast the spec draws is exactly right:

- `apps/desktop/src-tauri/src/spawn.rs` (the **raw-CLI** `spawnRun` path) sets `.current_dir(&cwd)` → for *that* path the child cwd IS the project dir, so `process.cwd()` happens to work.
- `apps/desktop/src-tauri/src/sidecar.rs` (`ensure`) spawns `exec vanguard __sidecar` with **no `.current_dir()`** → the sidecar child inherits the desktop app's cwd, which is meaningless for a multi-project app.

So `repoPath = process.cwd()` in `src/sidecar/deps.ts:50` genuinely returns the wrong value on the typed path. Part 1 is necessary, not cosmetic.

### 🟢 F2 — "repoPath is already the field's home" is accurate

`RunIssueDeps.repoPath` is the established field (`src/runners/source-adapter.ts:106`), extended by `RunGithubIssueDeps` / `RunGitlabIssueDeps` / `RunLinearIssueDeps`. In `deps.ts` a single local `repoPath = process.cwd()` is threaded into `githubDepsFromEnv` / `gitlabDepsFromEnv` / `linearExtras`. So Part 1 step 3 is a **one-line replacement** (`process.cwd()` → `params.repoPath`), exactly as claimed. The runners then persist run records under `<repoPath>/.vanguard` consistently (see F8).

### 🟡 F3 — The deps.ts comment is wrong for the sidecar and will mislead

`src/sidecar/deps.ts:40-41` currently says: *"The child's cwd is the project dir (spawned per `spawn.rs`), so `repoPath = process.cwd()`."* This conflates the two paths — it's true for `spawn.rs`, false for `sidecar.rs`. Part 1 must rewrite this comment as part of the change, or the next reader re-introduces the bug. Suggest: note that the sidecar child inherits the app cwd (not a project dir), which is *why* `repoPath` must be passed explicitly.

### 🔴 F4 — Run lifecycle / reconnect for typed-API runs is not addressed (the real gap)

This is the one substantive issue. The spec's Part 3 says: *"The `⟳ in progress` table row (shipped) opens this view instead of the bare log."* But there is **no shipped in-progress row for typed-API runs**. The three sources of rows are:

1. `spawns` — raw-CLI PIDs from `SpawnState` (`spawn.rs`). A typed-API run is **not** a spawn.
2. `active` — from `list_active(repoPath)` (`active.rs`), which detects runs purely by **session-file mtime within a 120s window** under `<repoPath>/.vanguard/sessions/<task>/`.
3. `runs` — completed records under `<repoPath>/.vanguard/runs/`.

So a run started via `apiCreateRun`:

- **Will** eventually surface in `active` *once its session `.jsonl` is being written* — because it dispatches to the same runners (`runGithubIssue`/`runGitlabIssue`/`runLinearIssue`) that write sessions, and those write under `deps.repoPath` (so Part 1 is what makes this work — good, but the spec doesn't connect these dots).
- **Exists only in the `api:event` stream** between clicking Run and the first session bytes landing — a window that spans sandbox spin-up + auth + first stage. During that window, if the user navigates away (or reloads), there is **no row** and **no way to reattach**: the sidecar holds the stdio pipe under a mutex (`sidecar.rs`), emits events to whoever subscribed at launch, and offers no replay/resubscribe. The Tauri `app.emit("api:event", …)` is a fire-and-forget broadcast; a newly-mounted listener only sees events emitted *after* it subscribes.

Consequences the spec should make an explicit decision on:

- **What shows the run as "in progress" in the table during the pre-session window?** If "nothing", that's a UX regression vs. the spawn path (which shows a row instantly). If "component-held state", then navigating away loses it.
- **Reconnect after navigation.** Once the run *is* in `active` (session file exists), the existing `LiveRun`/`readSession` path can show it — but that path reads the session transcript, **not** the structured `api:event` stream. So a reattached run would show the raw `LiveRun` view (turns/tokens/cost bar), not the new stage strip. The spec's "in progress row opens *this* view" is only true for the launching component; it's not true after navigation. State this, or design a reattach.
- **Single-in-flight is stricter than "one sidecar".** Because the sidecar serializes requests on one stdio pipe with the mutex held for the whole exchange (`sidecar.rs` `request`), a second `apiCreateRun` while one is running **blocks** (or queues) behind the first. The spec mentions single-in-flight under "Out of scope" but doesn't note that the *desktop UI* must prevent/disabled launching a second concurrent typed run, or the Run button will appear to hang. (Raw-CLI spawns are unaffected — they're separate processes.)

**Recommendation:** add a short "Run lifecycle" subsection deciding (a) whether typed runs get an instant placeholder row (e.g., optimistic `active`-style entry keyed by run id, reconciled when the session file appears), and (b) the reattach story (does navigating to an in-flight typed run show the strip or fall back to `LiveRun`?). Even a documented "v0: reattach falls back to the raw `LiveRun` view" is fine — but it needs to be a decision, with an acceptance criterion, not an omission.

### 🟡 F5 — `run-start.flow` is hardcoded to `'plan' | 'default'`, not the selected flow key

`src/runners/source-adapter.ts:~285` emits `flow: deps.plan === true ? 'plan' : 'default'`. The builder lets the user pick a `flow` from `capabilities().flows`, and `validateCreateRun` accepts any registered key, but the event the strip renders reports only `plan`/`default`. Harmless for v0 (those are the only two flows), but worth a one-line note: the strip's flow label should come from `run-start.flow` matched against `capabilities().flows` for the label, and once Subsystem 2 adds flows, the emitter must be updated to carry the real key or the strip will mislabel. (Related: the `params.flow === 'plan'` branch in `deps.ts` already carries the silent-default footgun the code comment warns about — the spec inherits it.)

### 🟢 F6 — Event contract claims are all verified

Every event-field claim in Part 3 checks out against `src/pipeline/events.ts` + emission sites:

- `run-start.stages` is the **full** stage list (`pipeline.map((s) => s.name)` in `source-adapter.ts`), so rendering pending stages greyed-ahead is data-supported. ✅
- `stage-start`/`stage-end` carry `index`/`of`/`outcome`; `outcome` is `'completed'` or the stage's `exitReason`. ✅
- `cost` carries only `usdSpent` (no cap) — the budget-bar note (read `budgetUsd` from app config, as `LiveRun` does) is correct. ✅
- `run-end` carries `prUrl?`/`secretBlocked?`. ✅ (Emission sites: success → `prUrl`; secret-blocked → `secretBlocked: true`; other failure → neither.)

One nuance: `cost` is emitted **after each `stage-end`** (per stage), not continuously — so `usdSpent` is a step function that ticks at stage boundaries. Fine for a strip; just don't expect sub-stage granularity.

### 🟢 F7 — S0 API is shipped as claimed

`apiCapabilities`/`apiCreateRun` exist in `apps/desktop/src/ipc.ts` and the Rust commands are registered in `generate_handler!` (`apps/desktop/src-tauri/src/lib.rs:149-150`). `CreateRunParams` in **both** `src/sidecar/sidecar.ts` and `apps/desktop/src/ipc.ts` currently lack `repoPath` — matching the spec's "add it to both" claim. No hidden wiring missing.

### 🟡 F8 — Client validation parity: mirror the *full* `validateCreateRun`, not just `issueRef`/`repoPath`

The spec says client validation "mirrors `validateCreateRun`" but the acceptance criterion (item 2) only asserts disabling Run on blank `issueRef`. `validateCreateRun` (`sidecar.ts`) also enforces: `maxTurns` positive integer, `baseBranch` non-blank, provider ∈ `PROVIDER_NAMES`, transport ∈ `TRANSPORTS`, flow ∈ `FLOWS`. Since the selects are populated from `capabilities()`, the enum checks are largely free, but **`maxTurns` and `baseBranch`** (advanced fields) need the same guards client-side or the user gets a `bad-request` round-trip the spec explicitly wants to avoid. Suggest acceptance criterion 2 enumerate: Run disabled on blank `issueRef` **and** invalid `maxTurns` (non-positive/non-integer) / blank `baseBranch`.

### 🛠 F9 — UI primitives: no `Select` exported; use `Combobox`/`Input`

The spec describes "selects" for transport/provider/flow. `@/ui` (`apps/desktop/src/ui/index.ts`) exports `Combobox`, `Input`, `Chip`, `Collapsible`, `Tooltip`, `Tabs` — **no `Select`**. `Combobox` is the natural fit (and doubles for provider, which may grow). `Collapsible` cleanly covers both the "Advanced" section and the collapsible raw log. Not a blocker — just calibrate the spec's "select" wording to the available kit, or note a `Select` may need adding to the UI seam.

### 🛠 F10 — Migration impact on `command.ts` is unstated

`apps/desktop/src/command.ts` (`runCommand`/`runPresets`) is the current single source for the CLI string and feeds the existing `NewRunForm` presets. Once the structured form composes the command from fields, `runCommand` becomes the **escape-hatch string composer** (read-only preview) rather than the primary input. `command.test.ts` will need updating. The spec's "escape hatch stays" covers the *behavior*; flag that `command.ts`'s role shifts and its test should be revisited (don't delete it — the spawn path and Fleet still use `watchCommand`/`runCommand`).

### 🟡 F11 — Acceptance criterion 4 should also assert the *order/transition*, not just final state

AC4 scripts `run-start → 2× stage-start/end → cost → run-end` and asserts stages shown/done, spend, PR link. Good. Strengthen by also asserting the **intermediate** state mid-sequence (a `stage-start` with no matching `stage-end` renders a spinner, not a check), since that's the live-view's whole point and the easiest thing to get wrong (e.g., a reducer that only renders terminal states). A component test that steps the listener event-by-event and snapshots after each is the high-value test here.

### 🟢 F12 — Back-compat / safety section is accurate

- `spawnRun` path untouched and still sets cwd per project — confirmed. ✅
- `apiCreateRun` dispatches to the same Docker-sandboxed runners — confirmed (`deps.ts` calls `runGithubIssue` etc.). ✅
- CLI contract untouched — confirmed; this is desktop + an additive param on an internal protocol. ✅
- `cargo`/`clippy` green is achievable with **zero Rust changes** for Part 1 (the Rust `api_create_run` already forwards `params` opaquely as `serde_json::Value`), so the spec's "no Rust change" for F6 is correct. ✅ (The only Rust touch this subsystem might want is the lifecycle fix in F4 — and that's optional depending on the decision.)

---

## Acceptance-criteria deltas suggested

| # | Spec AC | Suggested change |
|---|---|---|
| 1 | keep | — (accurate; add "rewrite the misleading deps.ts cwd comment") |
| 2 | "Run disabled until `issueRef` non-blank" | Extend: also disabled on invalid `maxTurns`/blank `baseBranch` (mirror full `validateCreateRun`). |
| 3 | keep | — |
| 4 | final-state assertions | Add: step event-by-event; assert spinner-before-`stage-end` transition, not just terminal state. |
| — | *(new)* | Add an AC for the lifecycle decision from F4: e.g., "an in-flight typed run either shows an instant placeholder row, or the spec documents that reattach falls back to `LiveRun`." |
| 5,6 | keep | — |

---

## Things explicitly fine / no action

- Single shared sidecar + per-run `repoPath` (Path A) is the right call; sidecar-per-project would fight the mutex model.
- "Live view augments, not replaces" — correct; keeping `LaunchPanel` for raw output + Kill on the spawn path is clean.
- Out-of-scope list is well-scoped (flow authoring, doc editor, multi-run typed concurrency). The single-in-flight constraint is real and correctly deferred to Fleet/watch.
- Dependencies on S0 are all satisfied.

---

## TL;DR for the implementer

1. Do Part 1 exactly as written (it's a one-liner + a comment fix + two type additions + one validation clause). It's correct.
2. Before Part 3, **decide the run-lifecycle/reattach story (F4)** and add an AC for it — this is the only thing that'll otherwise surface as a bug during build.
3. Mirror the *full* `validateCreateRun` client-side (F8), not just `issueRef`.
4. Plan to use `Combobox` (no `Select` in `@/ui`), and expect to touch `command.ts`'s role/tests (F9, F10).
5. Everything else is verified-accurate; build with confidence.
