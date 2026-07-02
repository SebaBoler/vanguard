import { describe, it, expect } from 'vitest';
import { summarizeOutcomes } from './run-summary.js';
import type { RunResult } from './types.js';

const baseResult: RunResult = {
  taskId: 'task-1',
  completed: true,
  exitReason: 'completed',
  turns: 0,
  worktreePath: '/tmp/wt',
  worktreePreserved: false,
  finalText: 'done',
};

describe('summarizeOutcomes', () => {
  it('renders one row per stage with its numbers plus a summing TOTAL', () => {
    const implementer: RunResult = {
      ...baseResult,
      turns: 4,
      costUsd: 1.2345,
      durationMs: 4200,
      usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300 },
    };
    const reviewer: RunResult = {
      ...baseResult,
      exitReason: 'incomplete',
      turns: 2,
      costUsd: 0.5,
      durationMs: 1800,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 70 },
    };

    const out = summarizeOutcomes([
      { name: 'implementer', result: implementer },
      { name: 'reviewer', result: reviewer },
    ]);

    // Each stage name appears.
    expect(out).toContain('implementer');
    expect(out).toContain('reviewer');

    // Each stage's exit reason and turns.
    expect(out).toContain('completed');
    expect(out).toContain('incomplete');

    // Per-stage token counts.
    expect(out).toContain('100');
    expect(out).toContain('200');
    expect(out).toContain('300');
    expect(out).toContain('10');
    expect(out).toContain('20');
    expect(out).toContain('70');

    // Per-stage cost (4 decimals) and duration (seconds, 1 decimal).
    expect(out).toContain('1.2345');
    expect(out).toContain('0.5000');
    expect(out).toContain('4.2s');
    expect(out).toContain('1.8s');

    // TOTAL row with summed cost, tokens and duration.
    expect(out).toContain('TOTAL');
    expect(out).toContain('1.7345'); // 1.2345 + 0.5
    expect(out).toContain('110'); // inputTokens 100 + 10
    expect(out).toContain('220'); // outputTokens 200 + 20
    expect(out).toContain('370'); // cacheRead 300 + 70
    expect(out).toContain('6.0s'); // 4200 + 1800 = 6000ms
  });

  it('handles an empty outcome list with a zeroed TOTAL', () => {
    const out = summarizeOutcomes([]);
    expect(out).toContain('TOTAL');
    expect(out).toContain('0.0000');
    expect(out).toContain('0.0s');
  });

  it('includes $or-est column header', () => {
    const out = summarizeOutcomes([]);
    expect(out).toContain('$or-est');
  });

  it('renders per-stage OpenRouter estimate when model is known', () => {
    const result: RunResult = {
      ...baseResult,
      turns: 2,
      costUsd: 0.5,
      durationMs: 1000,
      usage: { inputTokens: 10_000, outputTokens: 20_000, cacheReadInputTokens: 990_000 },
    };
    // (10_000*3 + 20_000*15 + 990_000*0.3) / 1e6 = 0.627
    const out = summarizeOutcomes([{ name: 'impl', result, model: 'claude-sonnet-4-6' }]);
    expect(out).toContain('0.6270');
    // Provider $cost is still present
    expect(out).toContain('0.5000');
    // TOTAL should equal stage (all known, no ~)
    const lines = out.split('\n');
    const totalLine = lines.find(l => l.includes('TOTAL'))!;
    expect(totalLine).toContain('0.6270');
    expect(totalLine).not.toContain('~');
  });

  it('renders n/a for a stage with no model', () => {
    const result: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.1,
      durationMs: 500,
      usage: { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 },
    };
    const out = summarizeOutcomes([{ name: 'stage', result }]);
    expect(out).toContain('n/a');
  });

  it('renders n/a for a stage with an unmapped model', () => {
    const result: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.1,
      durationMs: 500,
      usage: { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 },
    };
    const out = summarizeOutcomes([{ name: 'stage', result, model: 'gpt-5.3-codex' }]);
    expect(out).toContain('n/a');
  });

  it('renders partial TOTAL (~-prefixed) when some stages are n/a', () => {
    const knownResult: RunResult = {
      ...baseResult,
      turns: 2,
      costUsd: 0.5,
      durationMs: 1000,
      usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0 },
    };
    const unknownResult: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.1,
      durationMs: 500,
      usage: { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 },
    };
    // sonnet output only: (0*3 + 1_000_000*15 + 0*0.3)/1e6 = 15.0
    const out = summarizeOutcomes([
      { name: 'known', result: knownResult, model: 'claude-sonnet-4-6' },
      { name: 'unknown', result: unknownResult },
    ]);
    const lines = out.split('\n');
    const totalLine = lines.find(l => l.includes('TOTAL'))!;
    expect(totalLine).toContain('~15.0000');
    // Must not be plain 0.0000 or missing
    expect(totalLine).not.toMatch(/\b0\.0000\b.*\b0\.0000\b/);
  });

  it('renders n/a in TOTAL when all stages are unknown', () => {
    const result: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.1,
      durationMs: 500,
      usage: { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 1000 },
    };
    const out = summarizeOutcomes([
      { name: 'a', result },
      { name: 'b', result },
    ]);
    const lines = out.split('\n');
    const totalLine = lines.find(l => l.includes('TOTAL'))!;
    expect(totalLine).toContain('n/a');
  });

  it('renders exact TOTAL when all stages are known', () => {
    const result1: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.1,
      durationMs: 500,
      usage: { inputTokens: 0, outputTokens: 100_000, cacheReadInputTokens: 0 },
    };
    const result2: RunResult = {
      ...baseResult,
      turns: 1,
      costUsd: 0.2,
      durationMs: 500,
      usage: { inputTokens: 0, outputTokens: 200_000, cacheReadInputTokens: 0 },
    };
    // haiku output: 100_000*5/1e6 = 0.5, 200_000*5/1e6 = 1.0 → total 1.5
    const out = summarizeOutcomes([
      { name: 'a', result: result1, model: 'haiku' },
      { name: 'b', result: result2, model: 'haiku' },
    ]);
    const lines = out.split('\n');
    const totalLine = lines.find(l => l.includes('TOTAL'))!;
    expect(totalLine).toContain('1.5000');
    expect(totalLine).not.toContain('~');
  });
});
