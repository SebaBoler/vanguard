import { describe, it, expect } from 'vitest';
import { parseMetrics, aggregateMetrics, formatStats } from './stats.js';

const line = (o: Record<string, unknown>): string => JSON.stringify({ evt: 'run_complete', ...o });

describe('parseMetrics', () => {
  it('parses run_complete lines and skips blanks/malformed/non-run_complete', () => {
    const text = [
      line({ taskId: 'a', stage: 'implementer', costUsd: 0.1, inputTokens: 10, durationMs: 1000 }),
      '',
      'not json',
      JSON.stringify({ evt: 'something_else', taskId: 'a' }),
      line({ stage: 'x' }), // no taskId → skipped
      line({ taskId: 'b', costUsd: 0.2 }),
    ].join('\n');
    const recs = parseMetrics(text);
    expect(recs).toHaveLength(2);
    expect(recs[0]?.taskId).toBe('a');
    expect(recs[0]?.costUsd).toBe(0.1);
    expect(recs[1]?.taskId).toBe('b');
    expect(recs[1]?.outputTokens).toBe(0); // missing → 0
  });
});

describe('aggregateMetrics', () => {
  it('sums per task, per stage, and grand total', () => {
    const recs = parseMetrics(
      [
        line({ taskId: 'a', stage: 'implementer', costUsd: 0.30, inputTokens: 100, cacheReadInputTokens: 900, durationMs: 2000 }),
        line({ taskId: 'a', stage: 'reviewer', costUsd: 0.10, inputTokens: 50, cacheReadInputTokens: 50, durationMs: 1000 }),
        line({ taskId: 'b', stage: 'implementer', costUsd: 0.20, inputTokens: 100, cacheReadInputTokens: 0, durationMs: 500 }),
      ].join('\n'),
    );
    const report = aggregateMetrics(recs);

    const taskA = report.byTask.find((t) => t.key === 'a');
    expect(taskA?.entries).toBe(2);
    expect(taskA?.costUsd).toBeCloseTo(0.40);
    expect(taskA?.durationMs).toBe(3000);

    const impl = report.byStage.find((s) => s.key === 'implementer');
    expect(impl?.entries).toBe(2);
    expect(impl?.costUsd).toBeCloseTo(0.50);

    expect(report.total.entries).toBe(3);
    expect(report.total.costUsd).toBeCloseTo(0.60);
    expect(report.total.cacheReadInputTokens).toBe(950);
  });

  it('empty input yields a zeroed report', () => {
    const report = aggregateMetrics(parseMetrics(''));
    expect(report.byTask).toEqual([]);
    expect(report.total.entries).toBe(0);
  });
});

describe('formatStats', () => {
  it('renders task, stage and total sections with numbers', () => {
    const report = aggregateMetrics(parseMetrics(line({ taskId: 'a', stage: 'implementer', costUsd: 0.25, inputTokens: 100, cacheReadInputTokens: 900, durationMs: 2000 })));
    const out = formatStats(report);
    expect(out).toContain('BY TASK');
    expect(out).toContain('BY STAGE');
    expect(out).toContain('TOTAL');
    expect(out).toContain('0.2500');
    expect(out).toContain('90%'); // 900/(100+900)
  });
});
