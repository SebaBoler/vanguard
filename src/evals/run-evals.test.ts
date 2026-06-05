import { describe, it, expect } from 'vitest';
import { runEvals } from './run-evals.js';
import { programmaticJudge } from './judges.js';
import type { EvalCase } from './types.js';

const cases: EvalCase[] = [
  { id: 'a', kind: 'control', input: 'i1' },
  { id: 'b', kind: 'edge', input: 'i2' },
  { id: 'c', kind: 'refusal', input: 'i3' },
];

describe('runEvals', () => {
  it('produces, judges, and aggregates a report by kind', async () => {
    const report = await runEvals({
      cases,
      produce: async (testCase) => `out:${testCase.id}`,
      judge: programmaticJudge((testCase) => testCase.kind !== 'edge'),
    });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.byKind.edge).toEqual({ total: 1, passed: 0 });
    expect(report.byKind.control).toEqual({ total: 1, passed: 1 });
    expect(report.results[0]?.output).toBe('out:a');
  });

  it('returns a zero report for no cases', async () => {
    const report = await runEvals({ cases: [], produce: async () => '', judge: programmaticJudge(() => true) });
    expect(report.total).toBe(0);
    expect(report.passRate).toBe(0);
  });
});
