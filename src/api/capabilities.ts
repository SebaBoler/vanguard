import { PROVIDER_NAMES } from '../agents/registry.js';
import { implementReviewSimplifyStages, planImplementReviewStages, type PipelineStage } from '../pipeline/pipeline.js';

/** A selectable flow: its stable key and a human label for the UI. */
export interface FlowInfo {
  name: string;
  label: string;
}

/** What the run builder renders from — providers, flows, transports, and initial field defaults. */
export interface Capabilities {
  providers: string[];
  flows: FlowInfo[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

/**
 * Name-addressable flow registry. v0 registers only the TS-authored flows that already exist;
 * Subsystem 2 populates HCL-loaded flows (A/B). Kept intentionally tiny — this is not the HCL loader.
 */
export const FLOWS: Record<string, { label: string; build: () => PipelineStage[] }> = {
  default: { label: 'Implement → review → simplify', build: implementReviewSimplifyStages },
  plan: { label: 'Plan → implement → review', build: planImplementReviewStages },
};

/** Pure capability surface for the typed API. No side effects. */
export function capabilities(): Capabilities {
  return {
    providers: [...PROVIDER_NAMES],
    flows: Object.entries(FLOWS).map(([name, f]) => ({ name, label: f.label })),
    transports: ['github', 'gitlab', 'linear'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  };
}
