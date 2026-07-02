import type { ExitReason, RunResult } from './types.js';

/** Flat, single-source metric shape consumed by metrics.jsonl, the run summary, and logs. */
export interface StageMetric {
  taskId: string;
  /** Stage name, present only when building a stage-scoped metric. */
  stage?: string;
  exitReason: ExitReason;
  completed: boolean;
  turns: number;
  costUsd: number;
  cacheEfficiency: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
  /** Model actually used for the run, when known. */
  model?: string;
  /** Effective per-stage budget cap in USD; present only when a finite cap is in effect. */
  stageCapUsd?: number;
  /** Remaining global budget before this stage started; present only when the global budget is finite. */
  remainingBudgetUsd?: number;
}

export type StageBudgetInfo = Pick<StageMetric, 'stageCapUsd' | 'remainingBudgetUsd'>;

/**
 * Build the canonical flat metric for a run result. Numeric fields default to 0 when absent so the
 * metric shape is stable. `stage` is included only when `stageName` is provided.
 */
export function stageMetric(result: RunResult, stageName?: string, budgetInfo?: StageBudgetInfo): StageMetric {
  return {
    taskId: result.taskId,
    ...(stageName !== undefined ? { stage: stageName } : {}),
    exitReason: result.exitReason,
    completed: result.completed,
    turns: result.turns,
    costUsd: result.costUsd ?? 0,
    cacheEfficiency: result.cacheEfficiency ?? 0,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
    durationMs: result.durationMs ?? 0,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(budgetInfo?.stageCapUsd !== undefined ? { stageCapUsd: budgetInfo.stageCapUsd } : {}),
    ...(budgetInfo?.remainingBudgetUsd !== undefined ? { remainingBudgetUsd: budgetInfo.remainingBudgetUsd } : {}),
  };
}
