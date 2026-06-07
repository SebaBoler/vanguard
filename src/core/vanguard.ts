import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorktreeManager } from '../worktree/manager.js';
import { SkillRegistry } from '../context/skill-registry.js';
import { renderPrompt } from '../context/prompt-engine.js';
import { hasTerminationSignal } from '../structured/extract.js';
import { captureSession, restoreSession, sessionPath } from '../agents/session-store.js';
import { cacheEfficiency } from '../agents/provider.js';
import { createLogger } from './logger.js';
import { installSignalCleanup, trackSandbox, untrackSandbox } from './cleanup.js';
import { acquireSandboxSlot, releaseSandboxSlot } from './concurrency.js';
import { SandboxError } from './errors.js';
import type { RunOptions, RunResult, ExitReason, ReasoningEffort } from './types.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider, AgentUsage } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

const WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TURNS = 6;
// Skip on copy-back: .git (a linked worktree's .git is a file pointer; copying it corrupts the
// worktree) and node_modules (gitignored, huge, and its .bin symlinks make fs.cp throw EINVAL).
const COPY_BACK_SKIP = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

export interface PrepareOptions {
  taskId: string;
  localRepoPath: string;
  baseBranch?: string;
  reuse?: boolean;
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
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  model?: string;
  signal?: AbortSignal;
}

export interface RunDeps {
  worktrees?: WorktreeManager;
  skills?: SkillRegistry;
}

async function resolveHome(sandbox: IsolatedSandboxProvider): Promise<string> {
  const res = await sandbox.exec('printf %s "$HOME"');
  const home = res.stdout.trim();
  if (home === '') throw new SandboxError('Could not resolve $HOME in the sandbox');
  return home;
}

/** Provision worktree + sandbox + skills for one task. Caller owns disposeContext(). */
export async function prepareContext(opts: PrepareOptions, deps: RunDeps = {}): Promise<RunContext> {
  const log = opts.logger ?? createLogger();
  const wm = deps.worktrees ?? new WorktreeManager(opts.localRepoPath);
  const skills = deps.skills ?? new SkillRegistry({});
  const wt = await wm.create(opts.taskId, opts.baseBranch ?? 'main', opts.reuse !== undefined ? { reuse: opts.reuse } : {});
  // Acquire a host concurrency slot before booting the sandbox, so a fan-out can't start more
  // sandboxes than the host can hold (blocks until a slot frees).
  await acquireSandboxSlot(opts.sandbox);
  installSignalCleanup();
  try {
    await opts.sandbox.start();
    // The sandbox is live now: track it so a SIGINT/SIGTERM destroys it.
    trackSandbox(opts.sandbox);
    const home = await resolveHome(opts.sandbox);
    await opts.sandbox.copyIn(wt.path, WORKDIR);
    await skills.injectAll(opts.sandbox, home);
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
  } catch (error) {
    // Provisioning failed: untrack, free the slot, and tear down so nothing is orphaned.
    untrackSandbox(opts.sandbox);
    await opts.sandbox.destroy().catch(() => undefined);
    releaseSandboxSlot(opts.sandbox);
    throw error;
  }
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
      // Within a shared sandbox the session is already present natively (the prior stage wrote it).
      // Restoring it would overwrite the agent-owned jsonl with a root-owned copy the agent cannot
      // read, breaking resume. Only restore for a true cross-run resume, when it is not present.
      const present = await ctx.sandbox.exists(sessionPath(ctx.home, WORKDIR, input.resumeSessionId));
      if (!present) {
        const hostFile = join(ctx.localRepoPath, '.vanguard', 'sessions', ctx.taskId, `${input.resumeSessionId}.jsonl`);
        await restoreSession(ctx.sandbox, { home: ctx.home, cwd: WORKDIR, sessionId: input.resumeSessionId, hostFile });
      }
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
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.mcpConfig !== undefined ? { mcpConfig: input.mcpConfig } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    });

    let finalText = '';
    let turns = 0;
    let sessionId = input.resumeSessionId;
    let usage: AgentUsage | undefined;
    let costUsd: number | undefined;
    let transcript: string | undefined;

    for (;;) {
      const next = await gen.next();
      if (next.done) {
        finalText = next.value.finalText;
        turns = next.value.turns;
        if (next.value.sessionId !== undefined) sessionId = next.value.sessionId;
        usage = next.value.usage;
        costUsd = next.value.costUsd;
        transcript = next.value.transcript;
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
      await cp(staging, ctx.worktreePath, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
        filter: (src) => !COPY_BACK_SKIP.test(src),
      });
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
      ...(usage !== undefined ? { usage, cacheEfficiency: cacheEfficiency(usage) } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Destroy the sandbox and remove the worktree unless it has uncommitted changes. */
export async function disposeContext(ctx: RunContext, opts: { keep?: boolean } = {}): Promise<void> {
  // Free the host concurrency slot in both cases: a kept sandbox is parked for inspection/resume,
  // not actively running stages, so it should not count against the live-run budget.
  releaseSandboxSlot(ctx.sandbox);
  if (opts.keep === true) return; // leave the sandbox + worktree alive for inspection or resume
  untrackSandbox(ctx.sandbox);
  await ctx.sandbox.destroy().catch((error: unknown) => ctx.log.warn({ error }, 'failed to destroy sandbox'));
  const dirty = await ctx.wm.isDirty(ctx.worktreePath).catch(() => true);
  if (!dirty) {
    await ctx.wm.remove(ctx.worktreePath).catch((error: unknown) => ctx.log.warn({ error }, 'failed to remove worktree'));
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
      ...(opts.reuse !== undefined ? { reuse: opts.reuse } : {}),
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
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.mcpConfig !== undefined ? { mcpConfig: opts.mcpConfig } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } finally {
    await disposeContext(ctx);
  }
}
