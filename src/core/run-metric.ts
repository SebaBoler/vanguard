import { cacheEfficiency } from '../agents/provider.js';
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

/**
 * Fold a follow-up attempt (auto-resume, gate repair, losing fork variant) into a stage's result so
 * the persisted stage metric reflects what the stage actually cost. Identity fields (session,
 * completion, exit reason, final text, model) come from `next`; cost, turns, tokens and duration are
 * summed. Without this, metrics.jsonl recorded only the LAST attempt of a resumed/repaired stage.
 */
export function mergeAttempts(prior: RunResult, next: RunResult): RunResult {
  const usage =
    prior.usage !== undefined || next.usage !== undefined
      ? {
          inputTokens: (prior.usage?.inputTokens ?? 0) + (next.usage?.inputTokens ?? 0),
          outputTokens: (prior.usage?.outputTokens ?? 0) + (next.usage?.outputTokens ?? 0),
          cacheReadInputTokens: (prior.usage?.cacheReadInputTokens ?? 0) + (next.usage?.cacheReadInputTokens ?? 0),
        }
      : undefined;
  const costUsd =
    prior.costUsd !== undefined || next.costUsd !== undefined
      ? Math.round(((prior.costUsd ?? 0) + (next.costUsd ?? 0)) * 1e6) / 1e6
      : undefined;
  const durationMs =
    prior.durationMs !== undefined || next.durationMs !== undefined
      ? (prior.durationMs ?? 0) + (next.durationMs ?? 0)
      : undefined;
  return {
    ...next,
    turns: prior.turns + next.turns,
    ...(usage !== undefined ? { usage, cacheEfficiency: cacheEfficiency(usage) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
