import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorktreeManager } from '../worktree/manager.js';
import { SkillRegistry } from '../context/skill-registry.js';
import { renderPrompt } from '../context/prompt-engine.js';
import { hasTerminationSignal } from '../structured/extract.js';
import { captureSession, restoreSession } from '../agents/session-store.js';
import { createLogger } from './logger.js';
import { SandboxError } from './errors.js';
import type { RunOptions, RunResult, ExitReason, ReasoningEffort } from './types.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider, AgentUsage } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

const WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TURNS = 6;
const GIT_PATH = /(^|[\\/])\.git([\\/]|$)/;

export interface PrepareOptions {
  taskId: string;
  localRepoPath: string;
  baseBranch?: string;
  skills?: string[];
  sandbox: IsolatedSandboxProvider;
  logger?: VanguardLogger;
}

export interface RunContext {
  taskId: string;
  sandbox: IsolatedSandboxProvider;
  worktreePath: string;
  branch: string;
  home: string;
  localRepoPath: string;
  wm: WorktreeManager;
  log: VanguardLogger;
}

export interface StageInput {
  promptTemplate: string;
  agent: AgentProvider;
  variables?: Record<string, string>;
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
  forkSession?: boolean;
  signal?: AbortSignal;
}

export interface RunDeps {
  worktrees?: WorktreeManager;
  skills?: SkillRegistry;
}

async function resolveHome(sandbox: IsolatedSandboxProvider): Promise<string> {
  const res = await sandbox.exec('printf %s "$HOME"');
  const home = res.stdout.trim();
  if (home === '') throw new SandboxError('Nie udało się ustalić $HOME w sandboxie');
  return home;
}

/** Provision worktree + sandbox + skills for one task. Caller owns disposeContext(). */
export async function prepareContext(opts: PrepareOptions, deps: RunDeps = {}): Promise<RunContext> {
  const log = opts.logger ?? createLogger();
  const wm = deps.worktrees ?? new WorktreeManager(opts.localRepoPath);
  const skills = deps.skills ?? new SkillRegistry({});
  const wt = await wm.create(opts.taskId, opts.baseBranch ?? 'main');
  await opts.sandbox.start();
  const home = await resolveHome(opts.sandbox);
  await opts.sandbox.copyIn(wt.path, WORKDIR);
  if (opts.skills && opts.skills.length > 0) await skills.inject(opts.skills, opts.sandbox);
  return {
    taskId: opts.taskId,
    sandbox: opts.sandbox,
    worktreePath: wt.path,
    branch: wt.branch,
    home,
    localRepoPath: opts.localRepoPath,
    wm,
    log,
  };
}

/** Run one agent stage against an existing context. Multiple stages can share a context (pipeline). */
export async function runAgent(ctx: RunContext, input: StageInput): Promise<RunResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sources = [input.signal, timeout.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = AbortSignal.any(sources);

  try {
    if (input.resumeSessionId !== undefined) {
      const hostFile = join(ctx.localRepoPath, '.vanguard', 'sessions', ctx.taskId, `${input.resumeSessionId}.jsonl`);
      await restoreSession(ctx.sandbox, { home: ctx.home, cwd: WORKDIR, sessionId: input.resumeSessionId, hostFile });
    }

    const prompt = await renderPrompt(input.promptTemplate, { variables: input.variables ?? {}, sandbox: ctx.sandbox });

    const gen = input.agent.run({
      prompt,
      sandbox: ctx.sandbox,
      workdir: WORKDIR,
      home: ctx.home,
      maxTurns,
      signal,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.forkSession !== undefined ? { forkSession: input.forkSession } : {}),
    });

    let finalText = '';
    let turns = 0;
    let sessionId = input.resumeSessionId;
    let usage: AgentUsage | undefined;
    let costUsd: number | undefined;

    for (;;) {
      const next = await gen.next();
      if (next.done) {
        finalText = next.value.finalText;
        turns = next.value.turns;
        if (next.value.sessionId !== undefined) sessionId = next.value.sessionId;
        usage = next.value.usage;
        costUsd = next.value.costUsd;
        break;
      }
      if (next.value.sessionId !== undefined) sessionId = next.value.sessionId;
      ctx.log.debug({ taskId: ctx.taskId, text: next.value.text }, 'agent turn');
    }
    const completed = hasTerminationSignal(finalText);

    const staging = join(ctx.localRepoPath, '.vanguard', 'staging', ctx.taskId);
    await mkdir(staging, { recursive: true });
    try {
      await ctx.sandbox.copyFileOut(WORKDIR, staging);
      await cp(staging, ctx.worktreePath, { recursive: true, force: true, filter: (src) => !GIT_PATH.test(src) });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const diff = await ctx.wm.diff(ctx.worktreePath);

    if (sessionId !== undefined) {
      const hostDir = join(ctx.localRepoPath, '.vanguard', 'sessions', ctx.taskId);
      await mkdir(hostDir, { recursive: true });
      await captureSession(ctx.sandbox, { home: ctx.home, cwd: WORKDIR, sessionId, hostDir });
    }

    const preserved = await ctx.wm.isDirty(ctx.worktreePath);
    const exitReason: ExitReason = completed ? 'completed' : turns >= maxTurns ? 'maxTurns' : 'incomplete';

    const result: RunResult = {
      taskId: ctx.taskId,
      completed,
      exitReason,
      turns,
      worktreePath: ctx.worktreePath,
      worktreePreserved: preserved,
      finalText,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(diff !== '' ? { diff } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Destroy the sandbox and remove the worktree unless it has uncommitted changes. */
export async function disposeContext(ctx: RunContext): Promise<void> {
  await ctx.sandbox.destroy().catch((error: unknown) => ctx.log.warn({ error }, 'destroy sandbox nie powiódł się'));
  const dirty = await ctx.wm.isDirty(ctx.worktreePath).catch(() => true);
  if (!dirty) {
    await ctx.wm.remove(ctx.worktreePath).catch((error: unknown) => ctx.log.warn({ error }, 'remove worktree nie powiódł się'));
  }
}

/** Single-stage convenience: prepare -> one agent run -> dispose. */
export async function run(opts: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const ctx = await prepareContext(
    {
      taskId: opts.taskId,
      localRepoPath: opts.localRepoPath,
      sandbox: opts.sandbox,
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    },
    deps,
  );
  try {
    return await runAgent(ctx, {
      promptTemplate: opts.promptTemplate,
      agent: opts.agent,
      ...(opts.variables !== undefined ? { variables: opts.variables } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } finally {
    await disposeContext(ctx);
  }
}
