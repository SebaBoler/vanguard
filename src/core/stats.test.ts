import { describe, it, expect } from 'vitest';
import { parseMetrics, parseProbes, aggregateMetrics, formatStats, modelKey, probeReport } from './stats.js';

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
    expect(report.byModel.map((m) => m.key)).toEqual(['(no model recorded)']);
    expect(report.total.costUsd).toBeCloseTo(0.60);
    expect(report.total.cacheReadInputTokens).toBe(950);
  });

  it('buckets by served model so a model swap can be compared', () => {
    const report = aggregateMetrics(
      parseMetrics(
        [
          line({ taskId: 'a', stage: 'implementer', model: 'claude-sonnet-5', costUsd: 0.3 }),
          line({ taskId: 'a', stage: 'reviewer', model: 'claude-fable-5', costUsd: 0.5 }),
          line({ taskId: 'b', stage: 'implementer', model: 'claude-sonnet-5', costUsd: 0.2 }),
        ].join('\n'),
      ),
    );
    const sonnet = report.byModel.find((m) => m.key === 'claude-sonnet-5');
    expect(sonnet?.entries).toBe(2);
    expect(sonnet?.costUsd).toBeCloseTo(0.5);
    expect(report.byModel.find((m) => m.key === 'claude-fable-5')?.costUsd).toBeCloseTo(0.5);
  });

  it('modelKey makes a gateway substitution its own row', () => {
    expect(modelKey({ model: 'claude-fable-5', requestedModel: 'claude-fable-5' })).toBe('claude-fable-5');
    expect(modelKey({ model: 'claude-sonnet-4-6', requestedModel: 'claude-fable-5' })).toBe('claude-sonnet-4-6 (requested claude-fable-5)');
    expect(modelKey({ model: 'claude-opus-4-8' })).toBe('claude-opus-4-8');
    expect(modelKey({ requestedModel: 'opus' })).toBe('opus');
    expect(modelKey({})).toBe('(no model recorded)');
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
    expect(out).toContain('BY MODEL');
    expect(out).toContain('TOTAL');
    expect(out).toContain('0.2500');
    expect(out).toContain('90%'); // 900/(100+900)
  });
});

describe('decision probe join', () => {
  const probe = (taskId: string, difficulty: number, completesFirstTry: number): string =>
    JSON.stringify({ evt: 'decision_probe', ts: 't', taskId, completesFirstTry, difficulty, specClear: 0.8 });

  it('buckets probes by predicted level and reports predicted vs observed first-try rate', () => {
    const text = [
      probe('a', 0.9, 0.9), line({ taskId: 'a', stage: 'implementer', exitReason: 'completed' }),
      probe('b', 1.2, 0.8), line({ taskId: 'b', stage: 'implementer', exitReason: 'completed', attempts: 2, firstExitReason: 'maxTurns' }),
      probe('c', 3.4, 0.2), line({ taskId: 'c', stage: 'implementer', exitReason: 'incomplete' }),
      probe('d', 2.0, 0.5), // no implementer record → dropped
      line({ taskId: 'e', stage: 'implementer', exitReason: 'completed' }), // no probe → not in the table
    ].join('\n');
    const report = probeReport(parseMetrics(text), parseProbes(text));
    expect(report).toEqual([
      { level: 'Routine', runs: 2, repaired: 1, predictedFirstTry: 0.85, observedFirstTry: 0.5 },
      { level: 'Hard', runs: 1, repaired: 1, predictedFirstTry: 0.2, observedFirstTry: 0 },
    ]);
    expect(formatStats(aggregateMetrics(parseMetrics(text), parseProbes(text)))).toContain('PROBE: predicted difficulty');
    expect(aggregateMetrics(parseMetrics(text))).not.toHaveProperty('probes');
  });
});
