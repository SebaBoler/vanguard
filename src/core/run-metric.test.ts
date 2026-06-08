import { describe, it, expect } from 'vitest';
import { stageMetric } from './run-metric.js';
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
});
