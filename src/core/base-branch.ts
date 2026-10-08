import { execa } from 'execa';
import { VanguardError } from './errors.js';
import { createLogger } from './logger.js';
import type { VanguardLogger } from './logger.js';

/**
 * Reject a base branch git would misread when it is passed as a bare argument. A leading "-" parses
 * as an option (e.g. --upload-pack=<cmd>). A ":" or a leading "+" makes `git fetch origin <base>` a
 * refspec that writes, or force-overwrites, a local branch. A blank base names no branch at all, and
 * git never allows a control character in a ref, which would otherwise reach log lines raw.
 */
export function assertSafeBaseBranch(base: string): void {
  if (base.trim() === '') throw new VanguardError('Invalid base branch: it cannot be empty');
  if (base.startsWith('-') || base.startsWith('+') || base.includes(':') || /[\x00-\x1f\x7f]/.test(base)) {
    throw new VanguardError(`Invalid base branch ${JSON.stringify(base)}: it cannot start with "-" or "+", or contain ":" or a control character`);
  }
}

export interface ResolveRemoteBaseRefOptions {
  logger?: VanguardLogger;
  /** Log-line prefix naming the pass ('spec', 'worktree'). */
  label?: string;
}

/**
 * Resolve the ref a task worktree is cut from: fetch `base` from `origin` and prefer the remote
 * copy when it is ahead of the local branch, so the run (sandbox, verification, review) sees the
 * branch as it exists on the remote — on Actions the checkout is the event SHA and main may already
 * have moved (#423). A local base that is ahead of, or diverged from, origin is kept: it carries
 * commits the remote does not have yet. Best-effort: with no `origin`, offline, or a branch the
 * remote does not carry, it logs and returns the local `base` so the run still happens.
 *
 * @throws VanguardError when git would misread `base` (see assertSafeBaseBranch).
 */
export async function resolveRemoteBaseRef(repoPath: string, base: string, opts: ResolveRemoteBaseRefOptions = {}): Promise<string> {
  assertSafeBaseBranch(base);
  const label = opts.label ?? 'worktree';
  // Default a logger so the resolved baseline is ALWAYS announced — the one positive signal that tells
  // you which ref the run was actually cut from (vs a silent fallback to a stale local copy).
  const log = opts.logger ?? createLogger();
  const hasOrigin = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).then(() => true, () => false);
  if (!hasOrigin) {
    log.info({ base }, `${label}: no origin remote — using local ${base}`);
    return base;
  }
  try {
    await execa('git', ['fetch', '--end-of-options', 'origin', base], { cwd: repoPath });
  } catch (err) {
    const reason = err instanceof Error ? (err.message.split('\n').find((l) => l.startsWith('fatal:')) ?? err.message.split('\n')[0]) : String(err);
    log.warn({ base, reason }, `${label}: git fetch origin ${base} failed — using local ${base} (may be stale)`);
    return base;
  }
  let sha: string;
  try {
    // Cut from the freshly-fetched remote-tracking ref so the worktree reflects origin, not local.
    ({ stdout: sha } = await execa('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { cwd: repoPath }));
  } catch {
    log.warn({ base }, `${label}: origin has no ${base} — using local ${base}`);
    return base;
  }
  try {
    await execa('git', ['merge-base', '--is-ancestor', base, `refs/remotes/origin/${base}`], { cwd: repoPath });
  } catch {
    // Local base missing (fresh single-branch clone) or ahead/diverged: keep whatever is local when it
    // exists, since it may carry unpushed commits.
    const local = await execa('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd: repoPath }).then(() => true, () => false);
    if (local) {
      log.warn({ base, sha }, `${label}: local ${base} is ahead of or diverged from origin/${base} — using local ${base}`);
      return base;
    }
  }
  log.info({ base, sha }, `${label}: using origin/${base} @ ${sha.slice(0, 7)}`);
  return `origin/${base}`;
}
