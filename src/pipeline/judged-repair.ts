import { runAgent } from '../core/vanguard.js';
import type { RunContext, StageInput } from '../core/vanguard.js';
import type { PipelineStage, PipelineResult, StageOutcome } from './pipeline.js';
import type { AgentProvider } from '../agents/provider.js';
import type { Judge } from '../evals/types.js';

export interface JudgedRepairOptions {
  agent: AgentProvider;
  /** First pass that produces the change. */
  generate: PipelineStage;
  /** Repair pass; receives {{JUDGE_REASON}}, {{PREVIOUS_DIFF}}, {{PREVIOUS_FINAL}}. */
  repair: PipelineStage;
  /** Judge of the produced diff after each pass. */
  judge: Judge;
  variables?: Record<string, string>;
  /** Consecutive rejects before escalating to a human. Default 3. */
  maxRejects?: number;
  signal?: AbortSignal;
}

function toStageInput(
  stage: PipelineStage,
  agent: AgentProvider,
  variables: Record<string, string>,
  signal: AbortSignal | undefined,
  resumeSessionId: string | undefined,
): StageInput {
  return {
    promptTemplate: stage.promptTemplate,
    agent,
    variables,
    ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
    ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
    ...(stage.model !== undefined ? { model: stage.model } : {}),
    ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Generate, then judge-and-repair in a loop. After `maxRejects` consecutive rejections the run is
 * frozen (sandbox + worktree left alive) and returned as `needs_human` with a shell command the
 * operator can use to inspect the live sandbox. Caller disposes: keep the context on a frozen result.
 */
export async function runJudgedRepair(ctx: RunContext, opts: JudgedRepairOptions): Promise<PipelineResult> {
  const maxRejects = opts.maxRejects ?? 3;
  const baseVariables = opts.variables ?? {};
  const outcomes: StageOutcome[] = [];

  let result = await runAgent(ctx, toStageInput(opts.generate, opts.agent, baseVariables, opts.signal, undefined));
  outcomes.push({ name: opts.generate.name, result });
  let sessionId = result.sessionId;
  let spentUsd = result.costUsd ?? 0;
  let rejects = 0;

  for (;;) {
    const verdict = await opts.judge.judge({
      testCase: { id: ctx.taskId, kind: 'control', input: opts.generate.name },
      output: result.diff ?? result.finalText,
    });
    if (verdict.passed) {
      return { status: 'completed', outcomes };
    }
    rejects += 1;
    if (rejects >= maxRejects) {
      return {
        status: 'frozen',
        reason: 'needs_human',
        taskId: ctx.taskId,
        worktreePath: ctx.worktreePath,
        branch: ctx.branch,
        shellCommand: ctx.sandbox.shellCommand(),
        spentUsd,
        outcomes,
      };
    }
    const variables: Record<string, string> = {
      ...baseVariables,
      JUDGE_REASON: verdict.reason,
      PREVIOUS_DIFF: result.diff ?? '',
      PREVIOUS_FINAL: result.finalText,
    };
    result = await runAgent(ctx, toStageInput(opts.repair, opts.agent, variables, opts.signal, sessionId));
    outcomes.push({ name: `${opts.repair.name}#${rejects}`, result });
    if (result.sessionId !== undefined) sessionId = result.sessionId;
    spentUsd += result.costUsd ?? 0;
  }
}
