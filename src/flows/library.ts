import { planImplementAdversaryStages, type PipelineStage } from '../pipeline/pipeline.js';

/**
 * Name → record for the composable stages HCL flows reference by name. Layer 1 of the two-layer
 * format: HCL supplies ordering + overrides, the library supplies each stage's identity
 * (promptTemplate/systemPrompt/defaults). Single source of truth: `planImplementAdversaryStages()`
 * — its four records (planner/implementer/adversary/repairer) carry inline systemPrompt and no
 * `.map`, so they extract cleanly by name with no cross-builder prompt collision (spec §2). A name
 * enters here only when a shipped HCL flow needs it, with its source builder named.
 */
export const STAGE_LIBRARY: Record<string, PipelineStage> = Object.fromEntries(
  planImplementAdversaryStages().map((s) => [s.name, s]),
);
