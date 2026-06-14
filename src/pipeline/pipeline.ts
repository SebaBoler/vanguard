import { execa } from 'execa';
import { runAgent } from '../core/vanguard.js';
import { forkAndSelect } from './fork-select.js';
import { buildXmlPrompt } from '../context/xml-prompt.js';
import { extractJson } from '../structured/extract.js';
import { verdictSchema } from '../evals/judges.js';
import type { RunContext } from '../core/vanguard.js';
import type { ReasoningEffort, RunResult } from '../core/types.js';
import type { AgentProvider } from '../agents/provider.js';
import type { Complete } from '../evals/judges.js';
import type { EvalVerdict } from '../evals/types.js';

export interface PipelineStage {
  name: string;
  /** Template; may reference {{PREVIOUS_DIFF}}, {{PREVIOUS_FINAL}}, {{PREVIOUS_STAGE}}, task variables, and !`cmd`. */
  promptTemplate: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  model?: string;
  /** System prompt appended for this stage (role/policy/guidelines/tradeoffs). */
  systemPrompt?: string;
  /** Resume the previous stage's session so this stage keeps context. Default true. */
  resumePrevious?: boolean;
  /** Run this stage on a specific provider instead of RunStagesOptions.agent (cross-provider review). */
  provider?: AgentProvider;
  /** When false, skip syncing sandbox files back to the worktree (read-only stage: no diff). Default true. */
  copyBack?: boolean;
}

export interface StageOutcome {
  name: string;
  result: RunResult;
}

export interface FrozenRun {
  status: 'frozen';
  reason: 'needs_human' | 'budget_exceeded';
  taskId: string;
  worktreePath: string;
  branch: string;
  shellCommand: string;
  spentUsd: number;
  outcomes: StageOutcome[];
}

export type PipelineResult = { status: 'completed'; outcomes: StageOutcome[] } | FrozenRun;

export interface ForkOptions {
  /** Number of implementation variants to generate. Default 2. */
  n?: number;
  /** LLM completion function used to score each variant's diff. Higher score wins. */
  complete: Complete;
  /**
   * Name of the stage to run via forkAndSelect. Defaults to 'implementer'.
   * If no stage with this name exists in the pipeline, fork is silently ignored.
   */
  stageName?: string;
}

export interface RunStagesOptions {
  agent: AgentProvider;
  variables?: Record<string, string>;
  signal?: AbortSignal;
  maxCostUsd?: number;
  /** When set, run the implementer stage via forkAndSelect instead of a single pass. */
  fork?: ForkOptions;
}

/** Sandbox dir for the fork scorer: a throwaway cwd so any stray write never touches the worktree. */
const SCORER_WORKDIR = '/tmp';

/**
 * A Complete backed by a one-shot agent run in the shared sandbox, used to score fork variants. Runs
 * the given provider (provider-agnostic) with maxTurns 1 in /tmp — the diff to rate is supplied
 * entirely in the prompt, so the scorer needs no worktree access and any stray file write lands in a
 * throwaway dir, never the code under review. Lets `run --fork` score variants without a host LLM SDK.
 */
export function sandboxComplete(ctx: RunContext, agent: AgentProvider, signal?: AbortSignal): Complete {
  return async (prompt: string): Promise<string> => {
    const gen = agent.run({
      prompt,
      sandbox: ctx.sandbox,
      workdir: SCORER_WORKDIR,
      home: ctx.home,
      maxTurns: 1,
      ...(signal !== undefined ? { signal } : {}),
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) return next.value.finalText;
    }
  };
}

/** Build a scorer that asks the LLM to rate a diff, returning an EvalVerdict. */
function makeDiffScorer(complete: Complete): (diff: string, result: RunResult) => Promise<EvalVerdict> {
  return async (diff) => {
    const prompt = buildXmlPrompt({
      role: 'You are a strict judge evaluating a code diff.',
      guidelines:
        'Rate the quality of the diff. Return JSON in a <verdict> tag with fields: passed (bool), score (0..1, higher is better), reason (string).',
      task: `Diff:\n${diff || '(empty diff — no changes)'}\n\nReturn the verdict as <verdict>{...}</verdict>.`,
    });
    const text = await complete(prompt);
    return extractJson(text, 'verdict', verdictSchema);
  };
}

/**
 * Run stages sequentially over one shared context, enforcing a cumulative cost ceiling
 * (default $5). Chains the agent session stage-to-stage and exposes the previous stage's diff as
 * {{PREVIOUS_DIFF}} (substituted after command expansion, so backticks inside a diff never trigger
 * sandbox commands). Before each stage, if the cost spent so far has reached maxCostUsd, it stops
 * and returns a frozen `budget_exceeded` result with the outcomes so far; the caller keeps the
 * context alive and may resume with a higher limit.
 */
export async function runBudgetedStages(
  ctx: RunContext,
  stages: PipelineStage[],
  opts: RunStagesOptions,
): Promise<PipelineResult> {
  const maxCostUsd = opts.maxCostUsd ?? 5;
  const outcomes: StageOutcome[] = [];
  let previous: RunResult | undefined;
  let prevName = '';
  let sessionId: string | undefined;
  let spentUsd = 0;
  for (const stage of stages) {
    if (spentUsd >= maxCostUsd) {
      return {
        status: 'frozen',
        reason: 'budget_exceeded',
        taskId: ctx.taskId,
        worktreePath: ctx.worktreePath,
        branch: ctx.branch,
        shellCommand: ctx.sandbox.shellCommand(),
        spentUsd,
        outcomes,
      };
    }
    const resume = stage.resumePrevious ?? true;
    const agent = stage.provider ?? opts.agent;
    const variables: Record<string, string> = {
      ...(opts.variables ?? {}),
      PREVIOUS_DIFF: previous?.diff ?? '',
      PREVIOUS_FINAL: previous?.finalText ?? '',
      PREVIOUS_STAGE: prevName,
    };

    if (opts.fork !== undefined && stage.name === (opts.fork.stageName ?? 'implementer')) {
      const forkResult = await forkAndSelect(ctx, stage, {
        agent,
        ...(opts.fork.n !== undefined ? { n: opts.fork.n } : {}),
        score: makeDiffScorer(opts.fork.complete),
        variables,
        ...(resume && sessionId !== undefined ? { forkFromSessionId: sessionId } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      const result = forkResult.winner;
      outcomes.push({ name: stage.name, result });
      previous = result;
      prevName = stage.name;
      if (result.sessionId !== undefined) sessionId = result.sessionId;
      for (const v of forkResult.variants) spentUsd += v.result.costUsd ?? 0;
      continue;
    }

    const result = await runAgent(ctx, {
      promptTemplate: stage.promptTemplate,
      agent,
      stageName: stage.name,
      variables,
      ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
      ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
      ...(stage.model !== undefined ? { model: stage.model } : {}),
      ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt } : {}),
      ...(resume && sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(stage.copyBack !== undefined ? { copyBack: stage.copyBack } : {}),
    });
    outcomes.push({ name: stage.name, result });
    previous = result;
    prevName = stage.name;
    if (result.sessionId !== undefined) sessionId = result.sessionId;
    spentUsd += result.costUsd ?? 0;
  }
  return { status: 'completed', outcomes };
}

/** Run stages with no budget ceiling, returning just the outcomes (unchanged behaviour). */
export async function runStages(
  ctx: RunContext,
  stages: PipelineStage[],
  opts: RunStagesOptions,
): Promise<StageOutcome[]> {
  const result = await runBudgetedStages(ctx, stages, { ...opts, maxCostUsd: Number.POSITIVE_INFINITY });
  return result.outcomes;
}

/** Advisory retrospective-memory block appended to task-bearing prompts. The {{RETROSPECTIVE_MEMORY}} placeholder renders empty when the runner supplies no memory. */
export function retrospectiveMemoryBlock(): string {
  return [
    '<retrospective_memory>',
    'Retrospective memory from prior Vanguard runs; use only when relevant to this task.',
    '{{RETROSPECTIVE_MEMORY}}',
    '</retrospective_memory>',
  ].join('\n');
}

/**
 * XML system prompt with explicit trade-off reasoning (Anthropic playbook). Appended to every
 * canonical stage so the agent weighs cost-of-error against cost-of-verification, not just follows
 * instructions. Pass it as PipelineStage.systemPrompt (the canonical stage sets do this by default).
 */
export function defaultSystemPrompt(): string {
  return [
    '<role>',
    'You are a senior software engineer working autonomously in an isolated sandbox on a single task.',
    '</role>',
    '<policy>',
    'Make the smallest correct change that satisfies the task. Do not commit or push; the host commits and opens a pull request for human review. Keep changes scoped to the task.',
    '</policy>',
    '<guidelines>',
    'Prefer tools over assumptions: when a tool is available (typecheck, run_tests), call it to verify instead of guessing. Read the relevant files before editing. Match the existing code style. When a knowledge or test tool is available, use it before guessing.',
    '</guidelines>',
    '<tradeoffs>',
    'A wrong or sloppy change costs reviewer trust and rework, far more than the few seconds a typecheck or test run takes. An over-large change costs review time and risks regressions. Favor a minimal, verified change over a fast, unverified one.',
    '</tradeoffs>',
    '<efficiency>',
    'Spend tokens on the change, not on prose. Read only the files you need, keep reasoning brief, and keep your messages terse — no preamble, no restating the task, no summaries of what you are about to do. Verification still matters; verbosity does not.',
    '</efficiency>',
  ].join('\n');
}

/**
 * Fast single-stage preset: one implementer pass with low effort on a fast model. Cheaper and
 * quicker than the multi-stage pipeline, and still runs on the Claude subscription via the CLI.
 */
export function fastStages(): PipelineStage[] {
  return [
    {
      name: 'implementer',
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nImplement the solution in the current repo. When done, write exactly <promise>COMPLETE</promise>.',
      effort: 'low',
      model: 'haiku',
      maxTurns: 12,
      systemPrompt: defaultSystemPrompt(),
    },
  ];
}

/** Canonical Implementer -> Reviewer -> Simplifier stages (Merger is commitStage). */
export function implementReviewSimplifyStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: 'implementer',
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nContext from the ticket comments (includes any Vanguard Tech Spec):\n{{COMMENTS}}\n\nImplement the solution in the current repo.\n\n' +
        retrospectiveMemoryBlock() +
        '\n\nWhen done, write exactly <promise>COMPLETE</promise>.',
      maxTurns: 30,
    },
    {
      name: 'reviewer',
      // Fresh context (resumePrevious:false): an independent reviewer judges the diff cold, without
      // inheriting the implementer's reasoning. The files are still on disk in the shared worktree.
      resumePrevious: false,
      promptTemplate:
        'You are an independent code reviewer of the change below — you did not write it. If a code-review skill is available, use it. Review adversarially for bugs, security, missing tests, and convention violations, then fix what you find in the repo.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
      effort: 'high',
      maxTurns: 20,
    },
    {
      name: 'simplifier',
      resumePrevious: false,
      promptTemplate:
        'Improve the changed code for clarity, reuse, and simplicity without changing behaviour. If a simplify skill is available, use it.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
      maxTurns: 20,
    },
  ];
  return stages.map((stage) => ({ systemPrompt, ...stage }));
}

/**
 * Route one named stage (default 'reviewer') to a different provider, leaving the rest on the
 * pipeline's default agent. This is the cross-provider review toggle: the implementer stays on the
 * main provider while the reviewer runs on an independent one to catch different classes of bugs.
 */
export function withStageProvider(
  stages: PipelineStage[],
  provider: AgentProvider,
  stageName = 'reviewer',
): PipelineStage[] {
  return stages.map((stage) => (stage.name === stageName ? { ...stage, provider } : stage));
}

/** Set `model` on one named stage (default: all stages when stageName is omitted). */
export function withStageModel(stages: PipelineStage[], model: string, stageName?: string): PipelineStage[] {
  return stages.map((stage) => (stageName === undefined || stage.name === stageName ? { ...stage, model } : stage));
}

/**
 * Plan with the most capable model, then implement and review with a faster one. The planner
 * (opus, high effort) emits a <plan>; the implementer and reviewer run on sonnet to cut cost and
 * latency. Each later stage gets the plan / diff via variables, in a fresh context.
 */
export function planImplementReviewStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: 'planner',
      model: 'opus',
      effort: 'high',
      maxTurns: 10,
      resumePrevious: false,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nProduce a concise implementation plan inside <plan>...</plan>. Do not edit files yet. When done, write <promise>COMPLETE</promise>.',
    },
    {
      name: 'implementer',
      model: 'sonnet',
      maxTurns: 30,
      resumePrevious: false,
      promptTemplate:
        'Implement the change in the current repo, following this plan:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
    {
      name: 'reviewer',
      model: 'sonnet',
      effort: 'high',
      maxTurns: 20,
      resumePrevious: false,
      promptTemplate:
        'Review the diff below for bugs and gaps, then fix the code:\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
  ];
  return stages.map((stage) => ({ systemPrompt, ...stage }));
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
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
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
  return stages.map((stage) => ({ systemPrompt, ...stage }));
}

/** Red-team system prompt for the adversarial reviewer (reports only, never edits). */
export function adversarySystemPrompt(): string {
  return [
    '<role>Adversarial security and performance reviewer. Assume the change is guilty until proven safe.</role>',
    '<policy>You never edit files. You only report findings. Prefer false positives over missed vulnerabilities.</policy>',
    '<guidelines>Hunt for: injection, secret or PII exposure, auth/authz gaps, unsafe deserialization, path traversal, ReDoS, N+1 and quadratic patterns, unbounded growth, race conditions. Verify each claim against the diff.</guidelines>',
    '<tradeoffs>A missed vulnerability is far more costly than a false positive; when unsure, report it.</tradeoffs>',
  ].join('\n');
}

/**
 * Plan (opus) -> implement (sonnet) -> adversary (opus, red-team, reports <findings>) -> repair (sonnet).
 * The adversary runs on a different model than the implementer and only reports; the repairer fixes
 * from the findings via {{PREVIOUS_FINAL}}.
 */
export function planImplementAdversaryStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: 'planner',
      model: 'opus',
      effort: 'high',
      maxTurns: 10,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nProduce a concise implementation plan inside <plan>...</plan>. Do not edit files yet. When done, write <promise>COMPLETE</promise>.',
    },
    {
      name: 'implementer',
      model: 'sonnet',
      maxTurns: 30,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Implement the change in the current repo, following this plan:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
    {
      name: 'adversary',
      model: 'opus',
      effort: 'high',
      maxTurns: 12,
      resumePrevious: false,
      systemPrompt: adversarySystemPrompt(),
      promptTemplate:
        'Review the diff below. Emit ONLY <findings>{...}</findings> matching the schema (severity low|medium|high|critical, kind security|perf|correctness|style, title, evidence), sorted by severity. Do not edit files.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
    {
      name: 'repairer',
      model: 'sonnet',
      maxTurns: 20,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Apply targeted fixes for these findings, highest severity first; fix only what is listed:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
  ];
  return stages;
}

/** System prompt for the tech-spec stage: strict architect role, read-only, no file edits. */
export function techSpecSystemPrompt(): string {
  return [
    '<role>',
    'You are a strict software architect producing a technical specification. You do not edit, create, or delete any source files.',
    '</role>',
    '<policy>',
    'Read existing code and documentation to understand the current system. Do not modify source files. Your only output is the technical specification wrapped in <tech_spec>...</tech_spec>.',
    '</policy>',
    '<guidelines>',
    'Research the codebase read-only: read files, inspect interfaces, understand data flows and dependencies. Use all available information to produce a precise, actionable spec. Cover the problem, architecture, acceptance criteria, tests, risks, and performance/scalability.',
    '</guidelines>',
    '<tradeoffs>',
    'An under-specified tech spec causes rework and mis-implementation. A precise spec that does not touch source is far safer than one that guesses and edits. When uncertain about a detail, note it as an open question rather than inventing an answer.',
    '</tradeoffs>',
  ].join('\n');
}

/**
 * Tech-spec stage: a single read-only stage that researches the codebase and produces a technical
 * specification wrapped in <tech_spec>...</tech_spec>. Sets copyBack: false — no source files are
 * modified. Use extractTag(result.finalText, 'tech_spec') to pull the spec out of the outcome.
 *
 * Defaults to the same fast model as fastStages() ('haiku') to keep cost low. Override via opts.model.
 */
export function techSpecStage(opts?: { model?: string }): PipelineStage[] {
  return [
    {
      name: 'tech-spec',
      model: opts?.model ?? 'haiku',
      copyBack: false,
      resumePrevious: false,
      maxTurns: 15,
      systemPrompt: techSpecSystemPrompt(),
      promptTemplate: [
        'Task: {{TITLE}}',
        '',
        '{{DESCRIPTION}}',
        '',
        'Existing discussion on the ticket:',
        '{{COMMENTS}}',
        '',
        retrospectiveMemoryBlock(),
        '',
        'Research the existing codebase read-only (do not edit any files). Produce a technical specification for this task.',
        '',
        'The spec MUST include:',
        '- **Problem** — what exactly needs to be solved and why',
        '- **Architecture** — components, interfaces, data flows, and integration points',
        '- **Acceptance Criteria** — precise, testable conditions for done',
        '- **Tests** — what test cases and scenarios must be covered',
        '- **Risks** — known unknowns, edge cases, and failure modes',
        '- **Performance / Scalability** — throughput, latency, and growth considerations',
        '',
        'Wrap the complete specification in <tech_spec>...</tech_spec>.',
        '',
        'When done, write <promise>COMPLETE</promise>.',
      ].join('\n'),
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
