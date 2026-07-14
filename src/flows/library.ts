import { implementReviewSimplifyStages, planImplementAdversaryStages, STAGE, type PipelineStage } from '../pipeline/pipeline.js';

/**
 * Name → record for the composable stages HCL flows reference by name. Layer 1 of the two-layer
 * format: HCL supplies ordering + overrides, the library supplies each stage's identity
 * (promptTemplate/systemPrompt/defaults). Records are picked BY NAME FROM EACH BUILDER'S RETURNED
 * ARRAY, never copied from source literals — implementReviewSimplifyStages applies the shared
 * systemPrompt via a trailing `.map`, so its literals are incomplete. Sources, per entry:
 * - planner/implementer/adversary/repairer ← `planImplementAdversaryStages()` (S2).
 * - reviewer/simplifier ← `implementReviewSimplifyStages()` (S5 §3 — `reviewer` collides across
 *   builders; the library canonically carries the default flow's richer record, the recorded
 *   resolution of S2's F8 collision rule). Extra budget/timeout fields ride in the base record
 *   exactly like prompts do: supplied at lowering, never emitted.
 */
export const STAGE_LIBRARY: Record<string, PipelineStage> = Object.fromEntries([
  ...planImplementAdversaryStages().map((s) => [s.name, s] as const),
  ...implementReviewSimplifyStages()
    .filter((s) => s.name === STAGE.REVIEWER || s.name === STAGE.SIMPLIFIER)
    .map((s) => [s.name, s] as const),
]);
