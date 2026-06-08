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
});
