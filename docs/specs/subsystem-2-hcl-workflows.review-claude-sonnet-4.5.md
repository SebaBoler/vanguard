# Review — Subsystem 2: Named Workflows (HCL)

**Reviewer:** Claude Sonnet 4.5
**Date:** 2026-07-11
**Spec:** [`subsystem-2-hcl-workflows.md`](./subsystem-2-hcl-workflows.md)
**Method:** Every file:line anchor and technical claim cross-checked against the current codebase by reading the files. Subsystem 1 was assumed landed (verified — `deps.ts` comment already rewritten to describe the cwd-blind sidecar).

**Verdict:** A well-researched, coherent spec — the line anchors are almost all exact, the seam design is sound, and the two-layer HCL thesis lands cleanly on the existing `PipelineStage[]` contract. **Ready to implement after deciding two things:** the stage-precedence story (Finding F4 — the real one) and whether `watch` gets `--flow` (F5). Everything else is minor/clarifying.

---

## Summary

The spec's central bet — that HCL is *only* a source of `PipelineStage[]` and changes nothing downstream — is *almost* true, and the places it isn't are undocumented interactions with `assembleReviewPipeline` / `withStageMaxTurns` that will produce "HCL says X, run did Y" confusion if not stated (F4). The line citations are unusually accurate (only one off-by-one). The scope cuts are well-reasoned and the open questions are the right ones.

Findings tagged: 🟢 confirmed-accurate · 🟡 clarification/heads-up · 🔴 gap/blocker · 🛠 suggestion.

---

## Findings

### 🟢 F1 — Line anchors are accurate (verified, with one off-by-one)

Every cited seam was checked against the source:

| Spec claim | Actual | Status |
|---|---|---|
| `FLOWS` registry `capabilities.ts:25` | line 25 | ✅ exact |
| `capabilities()` `:31` | line 31 | ✅ exact |
| sidecar `plan` fork `deps.ts:73` | line 73 (`...(params.flow === 'plan' ? { plan: true } : {})`) | ✅ exact |
| CLI `plan` fork `source-adapter.ts:277` | line 277 (`deps.plan === true ? planImplementReviewStages() : adapter.stages()`) | ✅ exact |
| `run-start.flow` hardcoded `:289` | line 288 | 🟡 off by one (the `flow: deps.plan === true ? ...` line) |
| `runBudgetedStages` `pipeline.ts:222` | line 223 | 🟡 off by one |
| `implementReviewSimplifyStages()` `:465` | line 465 | ✅ exact |
| `conformanceStage()` `:510` | line 508 | 🟡 off by two |
| `planImplementAdversaryStages()` `:839` | line 839 | ✅ exact |
| sidecar validation `Object.hasOwn(FLOWS, flow)` `sidecar.ts:62` | line 62 | ✅ exact |
| `plan: { type: 'boolean' }` `args.ts:375` | line 375 | ✅ exact |

The `// Subsystem 2 replaces this` comment exists verbatim in `deps.ts` (and the equivalent intent comment sits at `source-adapter.ts:275-276`). Anchors this tight make the spec easy to act on.

### 🟢 F2 — The "stub" framing is exactly right

Confirmed: `FLOWS` already has `default` + `plan` as TS builders, but both dispatch paths collapse the entire registry to a single `plan` boolean (`deps.ts:73`, `source-adapter.ts:277`), and `run-start.flow` is hardcoded to `'plan' | 'default'`. A third `FLOWS` entry today would pass `sidecar.ts:62` validation then **silently run the default pipeline** — the `deps.ts:69-72` comment even calls this out ("any new FLOWS entry MUST be wired here too"). So S2 isn't gilding a working seam; it's filling a real gap. Good motivation.

### 🟢 F3 — The two-layer model maps cleanly onto the existing types

Verified the `PipelineStage` shape (`pipeline.ts:41`) and the override pipeline:

- `effort` reaches the agent (`pipeline.ts:308` spreads `stage.effort`), so an HCL `effort = "high"` override is effective end-to-end. ✅
- `resolveRouting` (`pipeline.ts:635`) is a last-writer-wins `{ ...stage, ...routing }` spread — exactly the mechanism the spec proposes to reuse for applying HCL overrides. ✅
- The `STAGE` name table (`pipeline.ts:18-27`) contains every library name the spec lists (`planner`, `implementer`, `reviewer`, `simplifier`, `adversary`, `repairer`, plus `conformance`). ✅ So the stage library can be populated 1:1.

### 🔴 F4 — Stage precedence between HCL and runtime flags is undocumented (the real issue)

The spec's constraint 2 says: *"HCL loading is a source of [the stage array] — it changes nothing downstream of `assembleReviewPipeline`."* That's literally true but **misleading**, because `assembleReviewPipeline` and the pre-pipeline mutators in `source-adapter.ts` actively rewrite an HCL-authored array based on other `deps`/flags. I traced four interactions the spec doesn't mention:

1. **`--no-simplify` silently drops an HCL-authored `simplifier` stage.**
   `assembleReviewPipeline` (`pipeline.ts:668`): `deps.noSimplify === true ? base.filter((s) => s.name !== STAGE.SIMPLIFIER) : base`. An author who explicitly writes `stage "simplifier" {}` and runs with `--no-simplify` (or a config/app.json that sets it) loses the stage with no warning. The HCL is not authoritative.

2. **`--conformance` appends a stage the flow didn't declare.**
   `pipeline.ts:669-671`: `if (deps.conformance === true) pipeline = [...pipeline, conformanceStage()]`. So a `--conformance` run injects an extra stage into *any* HCL flow, including ones that never mention conformance.

3. **`--provider-model <m>` overwrites HCL `model` on (almost) every stage.**
   `pipeline.ts:677-685`: `providerModel` routes `model` onto every stage except a cross-provider reviewer — last-writer-wins over the HCL `model = "opus"`. Probably desirable (CLI is the escape hatch), but unstated.

4. **`--max-turns <n>` overwrites HCL `max_turns`, but only on the implementer.**
   `source-adapter.ts:278` calls `withStageMaxTurns(baseStages, deps.maxTurns)` whose default `stageName` is `STAGE.IMPLEMENTER` (`pipeline.ts:574`). So a run launched with `--max-turns 10` overrides `stage "implementer" { max_turns = 30 }` → 10, while `stage "adversary" { max_turns = 12 }` survives at 12. Stage-specific, asymmetric, and invisible to the author.

Net effect: an HCL flow is **not** a complete description of what runs — it's a baseline that runtime flags can still mutate. This is fine as a *design* (the runner is unchanged, back-compat holds), but it must be **documented as the precedence contract**, or the first HCL author to set `max_turns = 30` and launch with `--max-turns 10` will file a bug.

**Recommendation:** add a "Precedence" subsection stating the resolved order explicitly, e.g.:

- *Library/ref record* supplies defaults.
- *HCL override block* wins over library defaults.
- *Runtime flags* (`--max-turns`, `--provider-model`, `--no-simplify`, `--conformance`) win over HCL — and specifically: `--max-turns` affects only the implementer; `--no-simplify` drops `simplifier`; `--conformance` appends a stage.
- Note that this is *intentional* (CLI/params are the escape hatch above HCL, mirroring HCL's `ref` being the escape hatch above composition).

Add an AC: "an HCL `max_turns` on a non-implementer stage is not overwritten by `--max-turns`; an HCL `simplifier` is dropped under `--no-simplify` (documented behavior)."

### 🔴 F5 — `watch` also branches on `plan`; the spec only mentions `run`

`args.ts` sets `{ plan: true }` in **two** commands: `run` (line 713) **and** `watch` (line 832). The spec's seam section adds `--flow` to the CLI and maps `--plan`, but only describes the `run` path (seam bullet: "CLI flag parse — `src/cli/args.ts`"). If `--flow` is added to `run` but not `watch`, then the **Fleet/watch loop cannot select named flows** — it's stuck on `default`/`plan` forever, which defeats half the point of named flows (autonomous fleet runs picking `flow-b`).

This isn't necessarily a defect — the spec *could* scope `watch` out and say "Fleet flow selection arrives with Fleet work." But it must be an explicit decision, because the symmetric `plan` wiring at line 832 strongly implies `watch` is expected to gain flow parity. Right now the spec is silent on it, which reads like an omission rather than a deliberate cut.

**Recommendation:** either (a) thread `--flow` into `watch` too (symmetric with `plan`), or (b) add `watch`/Fleet to Non-goals with the reason "Fleet picks flows in its own subsystem." Pick one and say so.

### 🟡 F6 — `effort` enum in HCL is narrower than the TS type

The override table specifies `effort: low|medium|high`. But `ReasoningEffort` (`src/core/types.ts:5`) is `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Two existing stages already use values outside the HCL set? Checking: the codebase uses `'low'` and `'high'` only — `xhigh`/`max` aren't used by any current builder. So today the narrower HCL enum loses nothing. But a future TS stage using `effort: 'max'` couldn't be round-tripped through HCL (the emitter would have to print a value the parser rejects, or the parser must be widened). Since AC3's round-trip test is the correctness contract, **the HCL `effort` enum must be at least as wide as every value the emitter can produce.** Cleanest fix: make the HCL enum the full `ReasoningEffort` set. Minor, but it's a latent round-trip break.

### 🟡 F7 — Override-keys table is a subset of `PipelineStage`; state the boundary

The table lists `model`, `effort`, `max_turns`, `provider`, `resume_previous`, `ref`. `PipelineStage` (`pipeline.ts:41`) has more fields: `promptTemplate` (required), `systemPrompt`, `copyBack`, `resumeUntilComplete`, `fallback`. These are intentionally not in the table — and that's *correct* (keeping prompts/system-prompts out of HCL is the whole point of Layer 1 being "composition only"). But the spec presents the table as "Override keys → fields" without saying these are the **only** keys and that prompt-shaped fields are deliberately excluded. A reader might wonder "can I override `promptTemplate` from HCL?" — and AC1 ("unknown keys are a load error") actually answers that (no — it'd error), but the *intent* deserves one sentence: *"Prompt and system-prompt fields are never overridable from HCL — they come from the library record or `ref` only; this keeps HCL declarative and prompts in TS."* This also reinforces the keystone (vision §2: HCL owns routing, TS owns prompts).

### 🛠 F8 — `capabilities(repoPath?)` (open Q3): recommend the optional-arg form

The spec asks whether to use `capabilities(repoPath?)` or a separate `repoCapabilities(repoPath)`. Verifying callers: `capabilities()` is called in `deps.ts` (via the `productionDeps().capabilities` field) and nowhere else in `src/` except the registry. It's pure and side-effect-free. The optional-arg form is cleaner because: (a) it's strictly additive (no-arg = built-ins only, preserving the one existing caller), (b) a separate function would force every caller that wants merged flows to remember to call the *other* function, and (c) the desktop already calls `apiCapabilities` with no args and will later pass `repoPath` — one function, one IPC. Recommend the optional arg.

### 🛠 F9 — `flow-b.hcl` fixture location (open Q4): recommend in-repo + real loader

The spec leans toward shipping `src/flows/flow-b.hcl` and loading at startup (dogfooding). I agree, with one concrete note: loading a *bundled* fixture means the loader's "rooted under `<repoPath>/.vanguard/flows/`" rule (D3) does **not** apply to built-in fixtures — they live under vanguard's install, not the operated repo. So the discovery/merge logic needs two roots: the repo's `.vanguard/flows/` (user flows) and the bundled `src/flows/` (built-in HCL flows, alongside the TS built-ins). Built-ins-win-on-collision (D4) then has to define the precedence *between* a TS built-in (`default`/`plan`) and an HCL built-in (`flow-b`) too — currently unambiguous (different names), but the rule should say "TS built-ins and HCL built-ins share the built-in namespace, which jointly wins over repo flows." Minor, but the two-root discovery is a real implementation detail the "Seams" section underspecifies.

### 🟡 F10 — Sidecar validation must become repo-aware (already flagged by spec, confirmed)

The spec correctly notes `sidecar.ts:62`'s `Object.hasOwn(FLOWS, flow)` must consult the *merged* registry. Verified: today it imports the static `FLOWS` and has no `repoPath`. Confirmed real. Implementation note: `validateCreateRun` would need `repoPath` (or the pre-merged registry) passed in, since it currently only sees `params`. The cleanest path is for `productionDeps().createRun` to build the merged registry once (it has `params.repoPath`) and pass *that* to validation + dispatch — don't make `validateCreateRun` do disk I/O itself (it's currently pure and synchronous; keep it so).

### 🟢 F11 — Deferral of `loop {}` and `ref =` is well-scoped

- `until = "user_accept"` rejected at load, `loop {}` rejected at run — verified the constraint is real (no pause/resume in the sidecar; `RunEvent` has no human-input variant). Reasonable.
- `ref =` path-escape guard (D2: must resolve inside `<repoPath>/.vanguard/`) is the right boundary and matches the trust model of `app.json`'s `runCommand` (already executed). Good.
- On open Q1 (cut `loop {}` from S2): I'd **keep parsing/emitting it** but lean toward the spec's own instinct. Rationale: S5 must *draw* Flow A (vision §2 line 78+), and if S2's emitter can't round-trip a `loop {}`, then S5's editor can't render Flow A from HCL and the format is incomplete on arrival. Parsing+emitting a block we don't execute is cheap; having to bolt loop grammar onto a shipped format later is not. Keep it.

### 🟢 F12 — Back-compat / safety claims hold

- `--plan` becoming an alias for `--flow plan` is additive and the CLI is a frozen contract (verified `args.ts:375` is the single definition; both `run` and `watch` consume `values.plan`). ✅
- Built-in TS flows unchanged (D4). ✅
- HCL is a new source of an existing array type — downstream (`runBudgetedStages`, `runStages`) genuinely doesn't change. ✅ (Subject to F4's precedence caveat — *what* runs can differ, but *the contract* is unchanged.)
- No `.github/workflows/` change. ✅ (Nothing in the spec touches CI.)

---

## Answers to the spec's open questions (for the record)

1. **Cut `loop {}`?** Keep. S5 needs to draw Flow A; a format that can't round-trip a loop block is incomplete. Parse/emit only, reject at run. (See F11.)
2. **Is `ref =` in scope?** Keep. Cheap, proves Layer 2, trust boundary is well-defined (D2). Deferring to "first consumer" means S5 becomes the first consumer *and* the proving ground — better to prove the path now with a fixture (T2 already covers it).
3. **`capabilities(repoPath?)` signature?** Optional arg. See F8.
4. **Flow B fixture location?** In-repo (`src/flows/flow-b.hcl`), loaded via the real loader. See F9 (mind the two-root discovery).

---

## Acceptance-criteria deltas suggested

| # | Spec AC | Suggested change |
|---|---|---|
| 1 | keep | — |
| 2 | keep | — |
| 3 | round-trip on `{name, model, effort, maxTurns}` | Also assert `effort` values outside `low/medium/high` round-trip (or widen the enum per F6). |
| 4 | keep | — |
| 5 | keep | Add: assert `run-start.flow` reflects a *repo* flow key too (not just the bundled `flow-b`). |
| 6 | keep | — |
| 7 | keep | — |
| — | *(new, for F4)* | Add an AC for precedence: HCL `max_turns` on a non-implementer stage survives `--max-turns`; HCL `simplifier` is dropped under `--no-simplify` (documented); `--conformance` appends to an HCL flow. |
| — | *(new, for F5)* | Either add `--flow` to `watch` with an AC, or move Fleet/`watch` flow selection to Non-goals explicitly. |

---

## TL;DR for the implementer

1. **Decide the precedence story (F4) and write it down** — this is the one substantive gap. HCL is a baseline, not a complete description; runtime flags still win in specific, stage-specific ways. Document it or the first author will be confused.
2. **Decide `watch`'s fate (F5)** — gain `--flow`, or be explicitly scoped out. Don't leave it silent.
3. Widen the `effort` enum to the full `ReasoningEffort` set (F6) so round-trip can't break.
4. Implementation note: `validateCreateRun` should stay pure — build the merged registry in `createRun` (where `repoPath` lives) and pass it in (F10).
5. Expect two discovery roots (repo `.vanguard/flows/` + bundled `src/flows/`) for built-in HCL flows (F9).
6. Everything else is verified-accurate; the seam design is sound and the line anchors are tight. Build with confidence once F4/F5 are decided.
