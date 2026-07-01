import { stageMetric } from './run-metric.js';
import { cacheEfficiency } from '../agents/provider.js';
import { alignTable } from './table.js';
import { estimateOpenRouterCost } from './openrouter-pricing.js';
import type { RunResult } from './types.js';

/** A single stage's outcome, as produced by the pipeline. */
export interface SummaryOutcome {
  name: string;
  result: RunResult;
  model?: string;
}

const HEADER = ['stage', 'exit', 'turns', 'in', 'out', 'cacheR', 'cache%', '$cost', '$or-est', 'time'];

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatEstimate(knownCount: number, totalCount: number, estimate: number): string {
  if (knownCount === 0) return 'n/a';
  if (knownCount < totalCount) return `~${estimate.toFixed(4)}`;
  return estimate.toFixed(4);
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
  let totalEstimate = 0;
  let estimateKnownCount = 0;

  const stageRows: string[][] = outcomes.map(({ name, result, model }) => {
    const m = stageMetric(result, name);
    totalCost += m.costUsd;
    totalInput += m.inputTokens;
    totalOutput += m.outputTokens;
    totalCacheRead += m.cacheReadInputTokens;
    totalDurationMs += m.durationMs;
    totalTurns += m.turns;

    const est = estimateOpenRouterCost(m, model);
    if (est !== undefined) {
      totalEstimate += est;
      estimateKnownCount++;
    }

    return [
      name,
      m.exitReason,
      String(m.turns),
      String(m.inputTokens),
      String(m.outputTokens),
      String(m.cacheReadInputTokens),
      pct(m.cacheEfficiency),
      m.costUsd.toFixed(4),
      est !== undefined ? est.toFixed(4) : 'n/a',
      seconds(m.durationMs),
    ];
  });

  const totalEstimateCell = formatEstimate(estimateKnownCount, outcomes.length, totalEstimate);

  const totalRow = [
    'TOTAL',
    '',
    String(totalTurns),
    String(totalInput),
    String(totalOutput),
    String(totalCacheRead),
    pct(cacheEfficiency({ inputTokens: totalInput, outputTokens: totalOutput, cacheReadInputTokens: totalCacheRead })),
    totalCost.toFixed(4),
    totalEstimateCell,
    seconds(totalDurationMs),
  ];

  return alignTable([HEADER, ...stageRows, totalRow]);
}
