import { alignTable } from '../core/table.js';
import { KINDS } from './types.js';
import type { EvalReport } from './types.js';

function rate(passed: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${Math.round((passed / total) * 100)}%`;
}

/** Render an EvalReport as a per-kind table + overall total, mirroring the vanguard stats format. */
export function formatEvalReport(report: EvalReport): string {
  const kindRows = KINDS.map((kind) => {
    const t = report.byKind[kind];
    return [kind, String(t.total), String(t.passed), rate(t.passed, t.total)];
  });
  const rows = [
    ['EVAL RESULTS', 'total', 'passed', 'rate'],
    ...kindRows,
    ['', '', '', ''],
    ['OVERALL', String(report.total), String(report.passed), rate(report.passed, report.total)],
  ];
  return alignTable(rows);
}
