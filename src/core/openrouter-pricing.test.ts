import { describe, it, expect } from 'vitest';
import { estimateOpenRouterCost } from './openrouter-pricing.js';

describe('estimateOpenRouterCost', () => {
  it('prices cache-read tokens at the cache-read rate, not the input rate (99% cache case)', () => {
    const usage = { inputTokens: 10_000, outputTokens: 20_000, cacheReadInputTokens: 990_000 };
    const est = estimateOpenRouterCost(usage, 'claude-sonnet-4-6');
    // (10_000*3 + 20_000*15 + 990_000*0.3) / 1_000_000 = (30_000 + 300_000 + 297_000) / 1e6 = 0.627
    expect(est).toBeCloseTo(0.627, 6);
    // Naive all-input price would be (1_000_000 * 3) / 1e6 = 3.0 — confirm estimate is far below
    expect(est!).toBeLessThan(1.0);
  });

  it('uses explicit cache-read rate for GLM (not 0.1x input heuristic)', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 };
    const est = estimateOpenRouterCost(usage, 'glm-5.2');
    // $0.18/M cache-read
    expect(est).toBeCloseTo(0.18, 6);
    // A 0.1x heuristic would give 0.093 — confirm we're not using that
    expect(est!).toBeGreaterThan(0.15);
  });

  it('opus alias matches dated claude-opus-4-8 row', () => {
    const usage = { inputTokens: 100_000, outputTokens: 50_000, cacheReadInputTokens: 500_000 };
    expect(estimateOpenRouterCost(usage, 'opus')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-opus-4-8')!,
      10,
    );
  });

  it('sonnet alias matches dated claude-sonnet-4-6 row', () => {
    const usage = { inputTokens: 100_000, outputTokens: 50_000, cacheReadInputTokens: 500_000 };
    expect(estimateOpenRouterCost(usage, 'sonnet')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-sonnet-4-6')!,
      10,
    );
  });

  it('haiku alias matches dated claude-haiku-4-5-20251001 row', () => {
    const usage = { inputTokens: 100_000, outputTokens: 50_000, cacheReadInputTokens: 500_000 };
    expect(estimateOpenRouterCost(usage, 'haiku')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-haiku-4-5-20251001')!,
      10,
    );
  });

  it('computes correct estimates for each mapped model', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 };
    // claude-opus-4-8: (5 + 25 + 0.5) / 1 = 30.5
    expect(estimateOpenRouterCost(usage, 'claude-opus-4-8')).toBeCloseTo(30.5, 6);
    // claude-sonnet-4-6: (3 + 15 + 0.3) = 18.3
    expect(estimateOpenRouterCost(usage, 'claude-sonnet-4-6')).toBeCloseTo(18.3, 6);
    // claude-haiku-4-5-20251001: (1 + 5 + 0.1) = 6.1
    expect(estimateOpenRouterCost(usage, 'claude-haiku-4-5-20251001')).toBeCloseTo(6.1, 6);
    // glm-5.2: (0.93 + 3 + 0.18) = 4.11
    expect(estimateOpenRouterCost(usage, 'glm-5.2')).toBeCloseTo(4.11, 6);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateOpenRouterCost({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 }, 'gpt-5.3-codex')).toBeUndefined();
    expect(estimateOpenRouterCost({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 }, 'glm-4.6')).toBeUndefined();
    expect(estimateOpenRouterCost({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 }, 'unknown-model')).toBeUndefined();
  });

  it('returns undefined for undefined model', () => {
    expect(estimateOpenRouterCost({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 }, undefined)).toBeUndefined();
  });

  it('returns 0 for zero usage with a known model', () => {
    expect(estimateOpenRouterCost({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, 'claude-sonnet-4-6')).toBe(0);
  });

  it('prices the OpenRouter dotted slug the same as the vanguard model id it was priced from (openrouter provider)', () => {
    const usage = { inputTokens: 100_000, outputTokens: 50_000, cacheReadInputTokens: 500_000 };
    expect(estimateOpenRouterCost(usage, 'anthropic/claude-sonnet-4.6')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-sonnet-4-6')!,
      10,
    );
    expect(estimateOpenRouterCost(usage, 'anthropic/claude-opus-4.8')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-opus-4-8')!,
      10,
    );
    expect(estimateOpenRouterCost(usage, 'anthropic/claude-haiku-4.5')).toBeCloseTo(
      estimateOpenRouterCost(usage, 'claude-haiku-4-5-20251001')!,
      10,
    );
  });
});
