# Vanguard App — Vision Map

**Status:** vision / umbrella spec. Not an implementation plan.
**Date:** 2026-07-10
**Purpose:** Turn the current "Run Vanguard in CLI" desktop experience into a proper,
structured, workflow-driven task runner. This document maps the whole idea into
independently-shippable subsystems, fixes the load-bearing architectural decisions,
and sets a build order. Each subsystem gets its own spec → plan → implementation
cycle later.

---

## Problem

Today the desktop app's "New run" is effectively **"Run Vanguard in CLI"**: a single
raw `<Textarea>` holding a `vanguard run …` command string. The user must already
know Vanguard's CLI surface — args aren't proposed, aren't validated, aren't
discoverable in the UI. There is no real API; the desktop shells out to the `vanguard`
CLI via `sh -c "<cmd>"` and parses stdout.

We want: write an idea → shape it into a plan → push it to the right task tracker →
run it through a **named workflow** — all from the app, without touching the CLI.

---

## Keystone decisions (locked)

### 1. API boundary — typed API over the same core, CLI frozen

Vanguard core is already a library: `runSourcedIssue`, `assembleReviewPipeline`,
`TaskFetcher`, `SourceAdapter` are plain TS functions; the CLI is a thin arg-parser
over them.

- **The CLI is a frozen public contract.** Sebastian (SebaBoler) runs `vanguard` in
  GitHub Actions building **latest** on every run. Any rename/removal/behavior change
  to an existing flag breaks his CI and loses work. **CLI changes are additive-only**
  (new flags, new subcommands — never touch existing ones).
- The desktop gets a **typed API surface** that calls the *same* core functions the
  CLI calls, returning typed requests + structured events instead of stdout lines.
- One brain (core), two mouths (CLI + typed API). Neither reimplements the other.

### 2. Flow format — two-layer HCL (Terraform model)

Flows are TS-authored `PipelineStage[]` arrays today (`src/pipeline/pipeline.ts`).
For app-authored, visually-editable workflows we adopt **HCL** (Terraform's format),
using Terraform's own escape-hatch discipline:

- **Layer 1 — HCL is composition only.** A flow = an ordered list of *stage-name
  references* + routing + budgets + loops. Vanguard's Flow A / Flow B are pure
  composition of stages that already exist in the `STAGE` table
  (`planner, implementer, reviewer, adversary, repairer, …`). No new logic — just
  ordering. HCL expresses this cleanly.
- **Layer 2 — the escape hatch.** When HCL can't express something (custom step,
  custom transformer), an HCL block references a TS export by name:

  ```hcl
  stage "my_custom" { ref = "scripts/custom.ts#myStage" }
  ```

  Core resolves the name → function. Turing-completeness is never lost; TS stays
  forever as the escape hatch, not as debt.

**Why this is right (the three questions answered):**

1. *Clean migration off TS one day?* — Wrong goal, and unnecessary. HCL owns the
   **graph**; TS owns **custom stage logic**. A stage is ~90% data
   (`promptTemplate`, `effort`, `model`, `maxTurns`), so most flows become pure HCL
   while the tail keeps a `ref =`. TS and HCL coexist indefinitely.
2. *Will HCL cover every use case?* — No, and forcing it to is the classic trap
   (Terraform's `count` / `for_each` / `dynamic` rot HCL into a bad language). Keep
   HCL declarative; the `ref =` escape hatch covers the long tail.
3. *Automated TS→HCL migration by name-reference?* — Yes — and it is the **primary
   design**, not just a migration tool. The `STAGE` table is the name registry. An
   emitter walks an existing `PipelineStage[]` and prints HCL mechanically (stages
   are already data records); custom transformers become `ref =` blocks.
   `planImplementAdversaryStages()` → `flow-b.hcl` almost 1:1.

**Loops** (Flow A's plan↔user-review): do **not** invent HCL control flow. One
declarative block maps to loop constructs core already has (`runJudgedRepair`,
`resumeUntilComplete`):

```hcl
loop {
  stages = ["planner", "user_review"]
  until  = "user_accept"
  max    = 3
}
```

**Cost to name:** both core (TS) and desktop must **parse** HCL — a shared
HCL-in-TS parser dependency (`@cdktf/hcl2json` or equivalent), plus a canonical
formatter (like `terraform fmt`) so hand-edits and app-edits round-trip. Bounded,
not free.

App-authored HCL flows live alongside TS flows (e.g. under `.vanguard/scripts/` or a
sibling `.vanguard/flows/`); both are readable by core and by the desktop app.

---

## The two named flows (motivating example)

- **Flow A** — full loop: `idea/draft → planner ⇄ user-review (loop until accept)
  → implementer → adversary → repairer`.
- **Flow B** — skip planning (spec arrives complete from elsewhere):
  `planner → implementer → adversary → repairer`.
- **default** — the existing TS-coded pipeline (`implementReviewSimplifyStages`),
  kept for full back-compat.

You pick A or B (or default) when creating a task.

---

## Subsystems (dependency-ordered)

### Subsystem 0 — Typed core API *(foundation, net-new seam)*

A thin typed surface over the existing `runSourcedIssue` / `assembleReviewPipeline`
/ `TaskFetcher` functions. Desktop sends typed requests and receives structured
events (stage-start, cost, verdict) instead of parsing stdout. The CLI is left
untouched and continues to call the same core. **Everything below depends on this.**

### Subsystem 0.5 — Sidecar hardening *(net-new, unblocks 1)*

Three spec reviews of Subsystem 1 found the typed `apiCreateRun` path rests on a
sidecar S0 shipped deliberately minimal — not ready for a real run UI. 0.5 hardens
it: **run-id-tagged + buffered events** (S0's global `{id:"run"}` broadcast has no
per-run key and no replay) with a **re-attach** command so a renavigated live view
replays the backlog; a **non-blocking capabilities** path (S0's single mutex lets a
minutes-long run starve `apiCapabilities`); **`cancelRun`** (`AbortSignal` →
`api_cancel`; the typed path has no PID for `killRun`); the **`repoPath` param** (F6
— `deps.ts` uses `process.cwd()`, wrong for multi-project); and a **provider gate**
(interim — `capabilities().providers` returns only proxy-less providers the typed
path runs today; superseded by Subsystem 6). *Depends on: 0. Blocks: 1.*

### Subsystem 1 — Structured run builder

Kills "know the CLI." Replace the raw `<Textarea>` in
`apps/desktop/src/features/inspector/NewRunForm.tsx` with proposed, validated fields
— provider, budget, flow, transport, max-turns — sourced from the API's option
surface (typed `apiCreateRun` + live event strip). Still keeps a composed CLI command
as an escape hatch, but the user never hand-types it. *Depends on: 0, **0.5**.*

### Subsystem 2 — Named workflows (HCL)

Flow B ≈ `planImplementAdversaryStages` **already ships**. Flow A adds a **human
review gate** into the plan↔review loop (the `reviewGate` seam exists in
`RunIssueDeps` but is currently unused). Both are authored as HCL, loaded over
`runBudgetedStages` + `resolveRouting`. Selection via an additive `--flow` flag plus
a UI dropdown. Needs the shared HCL parser + canonical formatter. *Depends on: 0.
Defines the format that 5 consumes.*

### Subsystem 3 — Doc editor + transport push

Embed a code editor (the app's first — no Monaco/CodeMirror exists today; only a
`<Textarea>`). Flow: write idea → hand to the planner stage → refine loop → on ready,
**create** the task on gh/glab/linear.

- **v1 — sidebar chat.** Chat pane beside the doc; LLM proposes whole-doc edits you
  accept/reject. Cheap, useful immediately. No range anchoring.
- **v2 — inline selection comments.** VS Code Claude-Code style: select a span →
  comment → LLM edits that span. Span-precise; higher build (anchoring, decorations).

Stage the editor, not the LLM plumbing. *Depends on: 0, 2 (planner handoff).*

### Subsystem 4 — Transport write-side

Generalize `TaskFetcher` / `SourceAdapter` with `createTask` + status push-back. The
read + publish-PR paths already exist; this adds the create side (gh/glab/linear CLIs
support issue creation — mechanically cheap). Folds into 3; listed separately because
it changes the transport interface. *Depends on: 0.*

### Subsystem 5 — Visual workflow editor

`apps/desktop/src/features/workflow/WorkflowEditor.tsx` exists but edits `AppConfig`
blocks and renders **read-only** HCL. Upgrade it to a canvas that **reads and writes
flow HCL**: blocks = stages referenced by name, drag to reorder, `ref =` blocks for
custom TS steps. Fully unblocked by the Layer-1/Layer-2 decision. *Depends on: 2
(HCL format must land first).*

### Subsystem 6 — Custom providers

Today `src/agents/registry.ts` `PROVIDERS` is a hardcoded name→factory map, so the
typed run path can only run the built-ins — and proxy-requiring ones (zai/openrouter)
fail because `deps.ts` hardcodes `egress:true/llmProxy:false`. Make providers
**user-configurable**: a custom provider = `{ name, endpoint, apiKey, via: proxy }`
stored in `AppConfig` (`.vanguard/app.json`, the same store Settings edits), merged
with the built-ins in the registry. `capabilities().providers` then returns built-ins
+ configured customs; the typed path runs them with their per-provider proxy/endpoint.
Motivating case: a Zai subscription routed through a self-hosted LLM proxy with a
global proxy key. **Supersedes Subsystem 0.5's interim provider gate** — proxy becomes
a per-provider config field, not a global hardcode. *Depends on: 0.5 (typed path +
gate it replaces). Spans core (registry), config schema, UI.*

---

## Build order

```
0    Typed core API         (foundation)
0.5  Sidecar hardening       (unblocks 1)
1    Structured run builder
2    Named workflows (HCL)
3+4  Doc editor + transport write-side
5    Visual workflow editor
6    Custom providers        (supersedes 0.5's provider gate)
```

---

## What already exists (feasibility, verified in code)

| # | Subsystem | Status today | Gap |
|---|-----------|--------------|-----|
| 0 | Typed API | Core is already a library; CLI = thin wrapper. Desktop shells `sh -c` (`spawn.rs`) | Typed request/event surface over existing fns |
| 1 | Run builder | `command.ts` builds CLI strings; UI = one raw `<Textarea>` | Structured proposed fields |
| 2 | Named workflows | Flows = TS `PipelineStage[]`; `planImplementAdversaryStages` ≈ Flow B; judged-repair loop exists | HCL format + human review gate + `--flow` |
| 3 | Doc editor | No Monaco/CodeMirror; only `<Textarea>`; specs read-only | Editor embed + chat/inline + create path |
| 4 | Transport | `TaskFetcher`/`SourceAdapter` clean interfaces; read + publish-PR only | `createTask` + status push-back |
| 5 | Visual editor | `WorkflowEditor.tsx` edits AppConfig, read-only HCL | Read/write flow HCL on a canvas |

**Key code anchors:**
- Pipeline/stages: `src/pipeline/pipeline.ts` (`STAGE` table `:17`, `runBudgetedStages`
  `:219`, `assembleReviewPipeline` `:649`, `planImplementAdversaryStages` `:826`)
- Loops: `src/pipeline/judged-repair.ts` (`runJudgedRepair`),
  `src/runners/source-adapter.ts:312` (conformance/verify repair loop)
- Transports: `src/tasks/fetcher.ts` (`TaskFetcher`),
  `src/runners/source-adapter.ts:134` (`SourceAdapter`)
- Run config: `RunOptions` `src/runners/source-adapter.ts:38`
- Desktop boundary: `apps/desktop/src/ipc.ts` ↔ `apps/desktop/src-tauri/src/spawn.rs`
- Desktop UI: `NewRunForm.tsx`, `Fleet.tsx`, `board/TaskBoard.tsx`,
  `workflow/WorkflowEditor.tsx`

---

## Out of scope (this document)

- Detailed per-subsystem design (each gets its own spec).
- The HCL schema itself (defined when Subsystem 2 is specced).
- Any change to existing CLI flags (additive-only, always).
