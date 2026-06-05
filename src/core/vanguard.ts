import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorktreeManager } from '../worktree/manager.js';
import { SkillRegistry } from '../context/skill-registry.js';
import { renderPrompt } from '../context/prompt-engine.js';
import { hasTerminationSignal } from '../structured/extract.js';
import { captureSession, restoreSession } from '../agents/session-store.js';
import { createLogger } from './logger.js';
import { SandboxError } from './errors.js';
import type { RunOptions, RunResult, ExitReason } from './types.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentUsage } from '../agents/provider.js';

const WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_PATH = /(^|[\\/])\.git([\\/]|$)/;

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

/**
 * Orchestrate one agent run: worktree -> sandbox -> sync in -> skills -> prompt ->
 * single-shot agent -> sync working files back (never the .git linkage) -> capture
 * diff + session -> cleanup (preserve worktree iff it has uncommitted changes).
 */
export async function run(opts: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const log = opts.logger ?? createLogger();
  const wm = deps.worktrees ?? new WorktreeManager(opts.localRepoPath);
  const skills = deps.skills ?? new SkillRegistry({});
  const sandbox = opts.sandbox;
  const maxTurns = opts.maxTurns ?? 6;

  const wt = await wm.create(opts.taskId, opts.baseBranch ?? 'main');

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sources = [opts.signal, timeout.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = AbortSignal.any(sources);

  let completed = false;
  let turns = 0;
  let finalText = '';
  let sessionId = opts.resumeSessionId;
  let usage: AgentUsage | undefined;
  let costUsd: number | undefined;

  try {
    await sandbox.start();
    const home = await resolveHome(sandbox);
    await sandbox.copyIn(wt.path, WORKDIR);
    if (opts.skills && opts.skills.length > 0) await skills.inject(opts.skills, sandbox);

    if (opts.resumeSessionId !== undefined) {
      const hostFile = join(opts.localRepoPath, '.vanguard', 'sessions', opts.taskId, `${opts.resumeSessionId}.jsonl`);
      await restoreSession(sandbox, { home, cwd: WORKDIR, sessionId: opts.resumeSessionId, hostFile });
    }

    const prompt = await renderPrompt(opts.promptTemplate, { variables: opts.variables ?? {}, sandbox });

    const gen = opts.agent.run({
      prompt,
      sandbox,
      workdir: WORKDIR,
      home,
      maxTurns,
      signal,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
    });

    // Single-shot (R2): drain turns for observability, decide completion from the final output.
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
      log.debug({ taskId: opts.taskId, text: next.value.text }, 'agent turn');
    }
    completed = hasTerminationSignal(finalText);

    // Sync working files back without ever overwriting the worktree's .git linkage (R1/B3).
    const staging = join(opts.localRepoPath, '.vanguard', 'staging', opts.taskId);
    await mkdir(staging, { recursive: true });
    try {
      await sandbox.copyFileOut(WORKDIR, staging);
      await cp(staging, wt.path, { recursive: true, force: true, filter: (src) => !GIT_PATH.test(src) });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const diff = await wm.diff(wt.path);

    if (sessionId !== undefined) {
      const hostDir = join(opts.localRepoPath, '.vanguard', 'sessions', opts.taskId);
      await mkdir(hostDir, { recursive: true });
      await captureSession(sandbox, { home, cwd: WORKDIR, sessionId, hostDir });
    }

    const preserved = await wm.isDirty(wt.path);
    const exitReason: ExitReason = completed ? 'completed' : turns >= maxTurns ? 'maxTurns' : 'incomplete';

    const result: RunResult = {
      taskId: opts.taskId,
      completed,
      exitReason,
      turns,
      worktreePath: wt.path,
      worktreePreserved: preserved,
      finalText,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(diff !== '' ? { diff } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    return result;
  } catch (error) {
    log.error({ error, taskId: opts.taskId, timedOut: timeout.signal.aborted }, 'run nie powiódł się');
    throw error;
  } finally {
    clearTimeout(timer);
    await sandbox.destroy().catch((error: unknown) => log.warn({ error }, 'destroy sandbox nie powiódł się'));
    // Cleanup policy: preserve the worktree if it has uncommitted changes; on any error preserve it.
    const dirty = await wm.isDirty(wt.path).catch(() => true);
    if (!dirty) await wm.remove(wt.path).catch((error: unknown) => log.warn({ error }, 'remove worktree nie powiódł się'));
  }
}
