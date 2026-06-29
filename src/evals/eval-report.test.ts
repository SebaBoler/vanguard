import { describe, it, expect } from 'vitest';
import { formatEvalReport } from './eval-report.js';
import type { EvalReport } from './types.js';

const report: EvalReport = {
  total: 3,
  passed: 2,
  failed: 1,
  passRate: 2 / 3,
  byKind: {
    control: { total: 1, passed: 1 },
    edge: { total: 1, passed: 1 },
    refusal: { total: 1, passed: 0 },
  },
  results: [],
};

describe('formatEvalReport', () => {
  it('renders a header and per-kind rows', () => {
    const output = formatEvalReport(report);
    expect(output).toContain('EVAL RESULTS');
    expect(output).toContain('control');
    expect(output).toContain('edge');
    expect(output).toContain('refusal');
  });

  it('renders an OVERALL total line', () => {
    const output = formatEvalReport(report);
    expect(output).toContain('OVERALL');
    expect(output).toContain('3'); // total
    expect(output).toContain('2'); // passed
  });

  it('renders pass rates correctly', () => {
    const output = formatEvalReport(report);
    expect(output).toContain('100%'); // control: 1/1
    expect(output).toContain('0%'); // refusal: 0/1
  });

  it('renders n/a for a kind with zero cases', () => {
    const emptyReport: EvalReport = {
      ...report,
      byKind: { ...report.byKind, edge: { total: 0, passed: 0 } },
    };
    expect(formatEvalReport(emptyReport)).toContain('n/a');
  });

  it('is deterministic for the same report', () => {
    expect(formatEvalReport(report)).toBe(formatEvalReport(report));
  });
});
