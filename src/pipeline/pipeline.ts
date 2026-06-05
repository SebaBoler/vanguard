import { execa } from 'execa';
import { runAgent } from '../core/vanguard.js';
import type { RunContext } from '../core/vanguard.js';
import type { ReasoningEffort, RunResult } from '../core/types.js';
import type { AgentProvider } from '../agents/provider.js';

export interface PipelineStage {
  name: string;
  /** Template; may reference {{PREVIOUS_DIFF}}, {{PREVIOUS_STAGE}}, task variables, and !`cmd`. */
  promptTemplate: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  /** Resume the previous stage's session so this stage keeps context. Default true. */
  resumePrevious?: boolean;
}

export interface StageOutcome {
  name: string;
  result: RunResult;
}

export interface RunStagesOptions {
  agent: AgentProvider;
  variables?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Run stages sequentially over one shared context. Chains the agent session stage-to-stage
 * and exposes the previous stage's diff as {{PREVIOUS_DIFF}} (substituted after command
 * expansion, so backticks inside a diff never trigger sandbox commands).
 */
export async function runStages(
  ctx: RunContext,
  stages: PipelineStage[],
  opts: RunStagesOptions,
): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  let previous: RunResult | undefined;
  let prevName = '';
  let sessionId: string | undefined;
  for (const stage of stages) {
    const resume = stage.resumePrevious ?? true;
    const variables: Record<string, string> = {
      ...(opts.variables ?? {}),
      PREVIOUS_DIFF: previous?.diff ?? '',
      PREVIOUS_STAGE: prevName,
    };
    const result = await runAgent(ctx, {
      promptTemplate: stage.promptTemplate,
      agent: opts.agent,
      variables,
      ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
      ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
      ...(resume && sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    outcomes.push({ name: stage.name, result });
    previous = result;
    prevName = stage.name;
    if (result.sessionId !== undefined) sessionId = result.sessionId;
  }
  return outcomes;
}

/** Canonical Implementer -> Reviewer -> Simplifier stages (Merger is commitStage). */
export function implementReviewSimplifyStages(): PipelineStage[] {
  return [
    {
      name: 'implementer',
      promptTemplate:
        'Zadanie: {{TITLE}}\n\n{{DESCRIPTION}}\n\nZaimplementuj rozwiązanie w bieżącym repo. Gdy skończysz, napisz dokładnie <promise>COMPLETE</promise>.',
    },
    {
      name: 'reviewer',
      promptTemplate:
        'Przejrzyj poniższy diff pod kątem błędów i braków, a następnie popraw kod:\n\n{{PREVIOUS_DIFF}}\n\nGdy skończysz, napisz <promise>COMPLETE</promise>.',
      effort: 'high',
    },
    {
      name: 'simplifier',
      promptTemplate:
        'Uprość i uporządkuj zmieniony kod bez zmiany zachowania (DRY, czytelność). Gdy skończysz, napisz <promise>COMPLETE</promise>.',
    },
  ];
}

export interface CommitOptions {
  message: string;
  authorName?: string;
  authorEmail?: string;
}

export interface CommitOutcome {
  committed: boolean;
  branch: string;
  sha?: string;
}

/**
 * Merger stage: commit the agent's work onto the worktree branch. Returns committed=false
 * when there is nothing to commit. Push / PR is the caller's explicit opt-in step.
 */
export async function commitStage(ctx: RunContext, opts: CommitOptions): Promise<CommitOutcome> {
  if (!(await ctx.wm.isDirty(ctx.worktreePath))) return { committed: false, branch: ctx.branch };
  const name = opts.authorName ?? 'Vanguard';
  const email = opts.authorEmail ?? 'vanguard@local';
  await execa('git', ['add', '-A'], { cwd: ctx.worktreePath });
  await execa('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', opts.message], {
    cwd: ctx.worktreePath,
  });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktreePath });
  return { committed: true, branch: ctx.branch, sha: stdout.trim() };
}
