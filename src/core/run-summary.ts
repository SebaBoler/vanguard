import { stageMetric } from './run-metric.js';
import { cacheEfficiency } from '../agents/provider.js';
import { alignTable } from './table.js';
import type { RunResult } from './types.js';

/** A single stage's outcome, as produced by the pipeline. */
export interface SummaryOutcome {
  name: string;
  result: RunResult;
}

const HEADER = ['stage', 'exit', 'turns', 'in', 'out', 'cacheR', 'cache%', '$cost', 'time'];

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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

  const stageRows: string[][] = outcomes.map(({ name, result }) => {
    const m = stageMetric(result, name);
    totalCost += m.costUsd;
    totalInput += m.inputTokens;
    totalOutput += m.outputTokens;
    totalCacheRead += m.cacheReadInputTokens;
    totalDurationMs += m.durationMs;
    totalTurns += m.turns;
    return [
      name,
      m.exitReason,
      String(m.turns),
      String(m.inputTokens),
      String(m.outputTokens),
      String(m.cacheReadInputTokens),
      pct(m.cacheEfficiency),
      m.costUsd.toFixed(4),
      seconds(m.durationMs),
    ];
  });

  const totalRow = [
    'TOTAL',
    '',
    String(totalTurns),
    String(totalInput),
    String(totalOutput),
    String(totalCacheRead),
    pct(cacheEfficiency({ inputTokens: totalInput, outputTokens: totalOutput, cacheReadInputTokens: totalCacheRead })),
    totalCost.toFixed(4),
    seconds(totalDurationMs),
  ];

  return alignTable([HEADER, ...stageRows, totalRow]);
}
