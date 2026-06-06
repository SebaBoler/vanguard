import { describe, it, expect } from 'vitest';
import { cacheEfficiency } from './provider.js';

describe('cacheEfficiency', () => {
  it('is the cached fraction of input tokens', () => {
    expect(cacheEfficiency({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 300 })).toBeCloseTo(0.75);
  });
  it('is 0 when there is no input', () => {
    expect(cacheEfficiency({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 })).toBe(0);
  });
});
