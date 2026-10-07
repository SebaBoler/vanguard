import { describe, it, expect } from 'vitest';
import { stageMetric, mergeAttempts } from './run-metric.js';
import type { RunResult } from './types.js';

const baseResult: RunResult = {
  taskId: 'task-1',
  completed: true,
  exitReason: 'completed',
  turns: 3,
  worktreePath: '/tmp/wt',
  worktreePreserved: false,
  finalText: 'done',
};

describe('stageMetric', () => {
  it('builds a flat metric from usage/cost/duration', () => {
    const result: RunResult = {
      ...baseResult,
      costUsd: 1.23,
      cacheEfficiency: 0.5,
      durationMs: 4200,
      model: 'claude-sonnet-4',
      usage: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 50 },
    };
    expect(stageMetric(result)).toEqual({
      taskId: 'task-1',
      exitReason: 'completed',
      completed: true,
      turns: 3,
      costUsd: 1.23,
      cacheEfficiency: 0.5,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 50,
      durationMs: 4200,
      model: 'claude-sonnet-4',
    });
  });

  it('defaults numbers to zero when usage/cost/duration are absent', () => {
    expect(stageMetric(baseResult)).toEqual({
      taskId: 'task-1',
      exitReason: 'completed',
      completed: true,
      turns: 3,
      costUsd: 0,
      cacheEfficiency: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 0,
    });
  });

  it('omits the stage key when stageName is not given', () => {
    expect(stageMetric(baseResult)).not.toHaveProperty('stage');
  });

  it('includes the stage key when stageName is given', () => {
    expect(stageMetric(baseResult, 'plan').stage).toBe('plan');
  });

  it('includes budget fields only when provided', () => {
    expect(stageMetric(baseResult, 'plan', { stageCapUsd: 0.5, remainingBudgetUsd: 1 })).toMatchObject({
      stageCapUsd: 0.5,
      remainingBudgetUsd: 1,
    });
    expect(stageMetric(baseResult, 'plan', {})).not.toHaveProperty('stageCapUsd');
  });
});

describe('mergeAttempts', () => {
  it('sums cost/turns/tokens/duration and keeps the follow-up attempt identity', () => {
    const prior: RunResult = {
      ...baseResult, completed: false, exitReason: 'incomplete', turns: 4, sessionId: 's1', costUsd: 0.3,
      durationMs: 1000, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900 },
    };
    const next: RunResult = {
      ...baseResult, turns: 2, sessionId: 's2', costUsd: 0.1, durationMs: 500, finalText: 'fixed',
      usage: { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 50 }, model: 'claude-sonnet-5',
    };
    const merged = mergeAttempts(prior, next);
    expect(merged).toMatchObject({
      completed: true, exitReason: 'completed', sessionId: 's2', finalText: 'fixed', model: 'claude-sonnet-5',
      turns: 6, costUsd: 0.4, durationMs: 1500,
      usage: { inputTokens: 150, outputTokens: 15, cacheReadInputTokens: 950 },
    });
    expect(merged.cacheEfficiency).toBeCloseTo(950 / 1100);
  });

  it('leaves cost/usage/duration absent when neither attempt reports them', () => {
    const merged = mergeAttempts(baseResult, { ...baseResult, turns: 1 });
    expect(merged.turns).toBe(4);
    expect(merged).not.toHaveProperty('costUsd');
    expect(merged).not.toHaveProperty('usage');
    expect(merged).not.toHaveProperty('durationMs');
  });
});
