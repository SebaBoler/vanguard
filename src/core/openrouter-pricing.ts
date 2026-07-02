/** USD per 1M tokens on OpenRouter; cacheRead stored explicitly (never derived from input). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  /** OpenRouter slug this row was priced from (documentation/traceability). */
  openRouterModel: string;
}

// Prices as of 2026-07-01, source openrouter.ai/api/v1/models; refresh by hand on model updates.
// Base routes only — do NOT map to premium `-fast` routes.
// Aliases (opus/sonnet/haiku) point to the current-generation base route; refresh together with dated rows.
const PRICED_MODELS = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, openRouterModel: 'anthropic/claude-opus-4.8' },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, openRouterModel: 'anthropic/claude-sonnet-4.6' },
  // $2/$10 is Anthropic's introductory rate (through 2026-08-31); reverts to $3/$15 after — refresh then. Fetched 2026-07-02.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, openRouterModel: 'anthropic/claude-sonnet-5' },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, openRouterModel: 'anthropic/claude-haiku-4.5' },
  'glm-5.2': { input: 0.93, output: 3, cacheRead: 0.18, openRouterModel: 'z-ai/glm-5.2' },
} satisfies Record<string, ModelPricing>;

export const OPENROUTER_PRICING: Record<string, ModelPricing> = {
  ...PRICED_MODELS,
  // CLI aliases used by the pipeline (src/pipeline/pipeline.ts); map to current-generation base route.
  opus: PRICED_MODELS['claude-opus-4-8'],
  sonnet: PRICED_MODELS['claude-sonnet-5'],
  haiku: PRICED_MODELS['claude-haiku-4-5-20251001'],
};

export interface EstimateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/** OpenRouter-priced estimate in USD, or undefined for an unknown/unmapped model. */
export function estimateOpenRouterCost(usage: EstimateUsage, model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  const p = OPENROUTER_PRICING[model];
  if (p === undefined) return undefined;
  return (
    (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadInputTokens * p.cacheRead) /
    1_000_000
  );
}
