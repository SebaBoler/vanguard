# Per-stage model selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Choose the model per pipeline stage from the CLI — `--provider-model <m>` for the implementer/simplifier stages and `--review-model <m>` for the review stage — so a run can implement on a capable model and review on a cheap one (or vice-versa), independently of provider selection.

**Architecture:** `PipelineStage` already has `model?: string` (runAgent forwards it). Add a `withStageModel` helper symmetric to the existing `withStageProvider`, plumb two CLI flags through args → cli → runner deps → the pipeline. Provider selection (`--provider`/`--review-provider`) is unchanged and composes with this.

**Tech Stack:** TypeScript (strict, exactOptionalPropertyTypes), Vitest. Conventions: Polish commits no co-author, English code, `.js` imports, no `any`.

**Model strategy for executing THIS plan:** implementer/reviewer/simplifier subagents run on **sonnet**; planning (this doc) is opus.

---

## Task 1: withStageModel + CLI flags + wiring

**Files:** `src/pipeline/pipeline.ts` (+ pipeline.test.ts), `src/cli/args.ts` (+ args.test.ts), `src/cli/run.ts`, `src/cli/watch.ts`, `src/runners/linear.ts`, `src/runners/github.ts`, `README.md`.

- [ ] **Step 1 (TDD): `withStageModel` in pipeline.ts.** Symmetric to `withStageProvider`:
  ```ts
  /** Set `model` on one named stage (default: all stages when stageName is omitted). */
  export function withStageModel(stages: PipelineStage[], model: string, stageName?: string): PipelineStage[] {
    return stages.map((stage) => (stageName === undefined || stage.name === stageName ? { ...stage, model } : stage));
  }
  ```
  pipeline.test.ts: assert `withStageModel(stages, 'opus')` sets model on every stage; `withStageModel(stages, 'haiku', 'reviewer')` sets it only on the reviewer stage and leaves others untouched. Red→green.

- [ ] **Step 2: args.ts.** Add options `provider-model: { type: 'string' }`, `review-model: { type: 'string' }`. Add `providerModel?: string; reviewModel?: string` to BOTH the run and watch Command members. Parse: `...(typeof values['provider-model'] === 'string' ? { providerModel: values['provider-model'] } : {})` and same for `review-model`, in both the run and watch return objects. USAGE: under the provider lines add:
  `--provider-model <m>     Model for the implementer/simplifier stages (default: provider's default)`
  `--review-model <m>       Model for the review stage (default: provider's default)`
  args.test.ts: `parseCli(['run','--linear','TES-1','--provider-model','opus','--review-model','haiku'])` → providerModel='opus', reviewModel='haiku'; absent → keys omitted.

- [ ] **Step 3: runner deps.** `RunLinearIssueDeps` and `RunGithubIssueDeps` gain `providerModel?: string; reviewModel?: string`. In `runLinearIssue`/`runGithubIssue`, after building the base pipeline (and after the existing `withStageProvider` review-provider step), apply models:
  ```ts
  let pipeline = /* existing stages, with withStageProvider already applied if reviewProvider set */;
  if (deps.providerModel !== undefined) pipeline = withStageModel(pipeline, deps.providerModel);
  if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, 'reviewer');
  ```
  Order: providerModel first (all stages), then reviewModel overrides the reviewer. Import `withStageModel`. Do NOT change behavior when neither is set.

- [ ] **Step 4: cli/run.ts + cli/watch.ts.** Thread `cmd.providerModel`/`cmd.reviewModel` into the linear + github (issue/project) deps, exactly like `provider`/`reviewProvider` are threaded today (`...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {})` for linearDeps; `if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;` for the github mutate-style deps; same for reviewModel; and in watch's linear deps object + buildGithubDeps).

- [ ] **Step 5: README.** In the Providers/Models section note: `--provider-model` / `--review-model` pick the model per stage, independent of `--provider`/`--review-provider`; default is each provider's default model. Example: `vanguard run --linear TES-1 --provider-model opus --review-model haiku`.

- [ ] **Step 6:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: wybór modelu per etap (--provider-model / --review-model)"`.

## Verification
- typecheck clean, all tests green (+ new withStageModel and args tests).
- The non-flag path is byte-for-byte unchanged (no model set → provider default, as today).
- Composes with cross-provider: `--provider claude --review-provider codex --provider-model opus --review-model gpt-5` sets both provider and model per stage.

## Self-review
- `withStageModel` mirrors `withStageProvider` (consistent). Flags mirror `--provider`/`--review-provider`. Reviewer-model override applied after the all-stages model so precedence is correct.
