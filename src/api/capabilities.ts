import { PROVIDER_NAMES } from '../agents/registry.js';
import { STAGE_LIBRARY } from '../flows/library.js';
import {
  implementReviewSimplifyStages,
  planImplementReviewStages,
  planImplementAdversaryStages,
  type PipelineStage,
} from '../pipeline/pipeline.js';

// Capabilities/FlowInfo/TRANSPORTS live in src/wire.ts (the shared desktop contract — S7).
export type { Capabilities, FlowInfo } from '../wire.js';
export { TRANSPORTS } from '../wire.js';
import { TRANSPORTS } from '../wire.js';
import type { Capabilities } from '../wire.js';

/**
 * Name-addressable flow registry. v0 registers only the TS-authored flows that already exist;
 * Subsystem 2 populates HCL-loaded flows (A/B). Kept intentionally tiny — this is not the HCL loader.
 */
export const FLOWS: Record<string, { label: string; build: () => PipelineStage[] }> = {
  default: { label: 'Implement → review → simplify', build: implementReviewSimplifyStages },
  plan: { label: 'Plan → implement → review', build: planImplementReviewStages },
  'flow-b': { label: 'Plan → implement → adversary → repair', build: planImplementAdversaryStages },
};

/** Pure capability surface for the typed API. No side effects. */
export function capabilities(): Capabilities {
  return {
    providers: [...PROVIDER_NAMES],
    flows: Object.entries(FLOWS).map(([name, f]) => ({ name, label: f.label })),
    stages: Object.keys(STAGE_LIBRARY),
    transports: [...TRANSPORTS],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  };
}
