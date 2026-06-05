import { execa } from 'execa';
import { runAgent } from '../core/vanguard.js';
import type { RunContext } from '../core/vanguard.js';
import type { ReasoningEffort, RunResult } from '../core/types.js';
import type { AgentProvider } from '../agents/provider.js';

export interface PipelineStage {
  name: string;
  /** Template; may reference {{PREVIOUS_DIFF}}, {{PREVIOUS_FINAL}}, {{PREVIOUS_STAGE}}, task variables, and !`cmd`. */
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
      PREVIOUS_FINAL: previous?.finalText ?? '',
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
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nImplement the solution in the current repo. When done, write exactly <promise>COMPLETE</promise>.',
      maxTurns: 30,
    },
    {
      name: 'reviewer',
      promptTemplate:
        'Review the diff below for bugs and gaps, then fix the code:\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
      effort: 'high',
      maxTurns: 20,
    },
    {
      name: 'simplifier',
      promptTemplate:
        'Simplify and tidy the changed code without changing behaviour (DRY, readability). When done, write <promise>COMPLETE</promise>.',
      maxTurns: 20,
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

/**
 * Generate -> Evaluate -> Repair (Anthropic playbook). The Evaluator only reports violations
 * (no edits); the Repairer applies targeted fixes from that report. Evaluator and Repairer run
 * in fresh contexts (resumePrevious: false) to cut tokens, operating on the shared worktree plus
 * the diff / report passed in.
 */
export function generateEvaluateRepairStages(): PipelineStage[] {
  return [
    {
      name: 'generator',
      promptTemplate:
        '<task_instructions>\nTask: {{TITLE}}\n\n{{DESCRIPTION}}\n\nGenerate a first version of the solution in the current repo. Implement, do not review. When done, write <promise>COMPLETE</promise>.\n</task_instructions>',
    },
    {
      name: 'evaluator',
      promptTemplate:
        '<role>Strict reviewer. You do not change files.</role>\n<task_instructions>\nAnalyse the diff below and list ONLY violations and bugs inside <violations>...</violations>. Do not edit code.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.\n</task_instructions>',
      effort: 'high',
      resumePrevious: false,
    },
    {
      name: 'repairer',
      promptTemplate:
        '<task_instructions>\nApply targeted fixes based on the violations report. Fix only what is listed:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.\n</task_instructions>',
      resumePrevious: false,
    },
  ];
}

export type CommandRunner = (file: string, args: string[], cwd: string) => Promise<string>;

const defaultRunner: CommandRunner = async (file: string, args: string[], cwd: string): Promise<string> =>
  (await execa(file, args, { cwd })).stdout;

export interface PublishOptions {
  title: string;
  body?: string;
  baseBranch?: string;
  draft?: boolean;
  remote?: string;
  /** Injected for tests; defaults to running git/gh via execa. */
  runner?: CommandRunner;
}

export interface PublishOutcome {
  branch: string;
  prUrl: string;
}

/**
 * Merger review output: push the worktree branch and open a GitHub PR for human/CI review.
 * Outward-facing and opt-in — call after commitStage and before disposeContext. GitHub is the
 * review surface only; the task source of truth (e.g. Linear) is separate.
 */
export async function publishForReview(ctx: RunContext, opts: PublishOptions): Promise<PublishOutcome> {
  const run = opts.runner ?? defaultRunner;
  await run('git', ['push', '-u', opts.remote ?? 'origin', ctx.branch], ctx.worktreePath);
  const args = [
    'pr',
    'create',
    '--head',
    ctx.branch,
    '--base',
    opts.baseBranch ?? 'main',
    '--title',
    opts.title,
    '--body',
    opts.body ?? '',
  ];
  if (opts.draft === true) args.push('--draft');
  const out = await run('gh', args, ctx.worktreePath);
  const prUrl =
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http'))
      .pop() ?? out.trim();
  return { branch: ctx.branch, prUrl };
}
