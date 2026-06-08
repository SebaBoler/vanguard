import { stageMetric } from './run-metric.js';
import type { RunResult } from './types.js';

/** A single stage's outcome, as produced by the pipeline. */
export interface SummaryOutcome {
  name: string;
  result: RunResult;
}

interface Row {
  stage: string;
  exit: string;
  turns: string;
  input: string;
  output: string;
  cacheRead: string;
  cachePct: string;
  cost: string;
  duration: string;
}

const HEADERS: Row = {
  stage: 'stage',
  exit: 'exit',
  turns: 'turns',
  input: 'in',
  output: 'out',
  cacheRead: 'cacheR',
  cachePct: 'cache%',
  cost: '$cost',
  duration: 'time',
};

const COLUMNS: ReadonlyArray<keyof Row> = [
  'stage',
  'exit',
  'turns',
  'input',
  'output',
  'cacheRead',
  'cachePct',
  'cost',
  'duration',
];

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function cachePercent(cacheRead: number, input: number): string {
  const total = input + cacheRead;
  if (total === 0) return '0%';
  return `${Math.round((cacheRead / total) * 100)}%`;
}

/**
 * Render a compact, dependency-free aligned table summarising every stage of a run plus a TOTAL row
 * summing cost, tokens and duration. Each row is built from `stageMetric` so the summary, the metrics
 * file and the logs all share one metric shape and never drift.
 */
export function summarizeOutcomes(outcomes: ReadonlyArray<SummaryOutcome>): string {
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalDurationMs = 0;
  let totalTurns = 0;

  const stageRows: Row[] = outcomes.map(({ name, result }) => {
    const m = stageMetric(result, name);
    totalCost += m.costUsd;
    totalInput += m.inputTokens;
    totalOutput += m.outputTokens;
    totalCacheRead += m.cacheReadInputTokens;
    totalDurationMs += m.durationMs;
    totalTurns += m.turns;
    return {
      stage: name,
      exit: m.exitReason,
      turns: String(m.turns),
      input: String(m.inputTokens),
      output: String(m.outputTokens),
      cacheRead: String(m.cacheReadInputTokens),
      cachePct: cachePercent(m.cacheReadInputTokens, m.inputTokens),
      cost: m.costUsd.toFixed(4),
      duration: seconds(m.durationMs),
    };
  });

  const totalRow: Row = {
    stage: 'TOTAL',
    exit: '',
    turns: String(totalTurns),
    input: String(totalInput),
    output: String(totalOutput),
    cacheRead: String(totalCacheRead),
    cachePct: cachePercent(totalCacheRead, totalInput),
    cost: totalCost.toFixed(4),
    duration: seconds(totalDurationMs),
  };

  const allRows: Row[] = [HEADERS, ...stageRows, totalRow];
  const widths = new Map<keyof Row, number>(
    COLUMNS.map((col) => [col, Math.max(...allRows.map((row) => row[col].length))]),
  );

  const formatRow = (row: Row): string =>
    COLUMNS.map((col) => row[col].padEnd(widths.get(col) ?? 0)).join('  ').trimEnd();

  return [formatRow(HEADERS), ...stageRows.map(formatRow), formatRow(totalRow)].join('\n');
}
