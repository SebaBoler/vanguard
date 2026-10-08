import { execa } from 'execa';
import { VanguardError } from './errors.js';
import { createLogger } from './logger.js';
import { redactTokens } from './secret-scan.js';
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
  /**
   * Keep a local base that is ahead of or diverged from origin (it may carry unpushed commits).
   * Default: outside CI only — on a CI checkout the local branch is the event SHA and can never hold
   * unpushed work, so there the remote copy always wins.
   */
  keepLocalIfAhead?: boolean;
}

/** Git never prompts for credentials from a daemon; an unreachable origin fails fast instead. */
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0' } as const;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Resolve the ref a task worktree is cut from: fetch `base` from `origin` and prefer the remote
 * copy when it is ahead of the local branch, so the run (sandbox, verification, review) sees the
 * branch as it exists on the remote — on Actions the checkout is the event SHA and main may already
 * have moved (#423). Best-effort: with no `origin`, offline, or a branch the remote does not carry,
 * it logs and returns the local `base` so the run still happens. The fetch names the destination
 * ref explicitly, so a single-branch clone (actions/checkout) tracks the base too, and the returned
 * ref is the full `refs/remotes/origin/<base>` — a tag or branch literally named `origin/<base>`
 * cannot shadow it.
 *
 * @throws VanguardError when git would misread `base` (see assertSafeBaseBranch).
 */
export async function resolveRemoteBaseRef(repoPath: string, base: string, opts: ResolveRemoteBaseRefOptions = {}): Promise<string> {
  assertSafeBaseBranch(base);
  const label = opts.label ?? 'worktree';
  const keepLocal = opts.keepLocalIfAhead ?? process.env.CI === undefined;
  // Default a logger so the resolved baseline is ALWAYS announced — the one positive signal that tells
  // you which ref the run was actually cut from (vs a silent fallback to a stale local copy).
  const log = opts.logger ?? createLogger();
  const hasOrigin = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).then(() => true, () => false);
  if (!hasOrigin) {
    log.info({ base }, `${label}: no origin remote — using local ${base}`);
    return base;
  }
  const remoteRef = `refs/remotes/origin/${base}`;
  const fetch = await execa('git', ['fetch', '--end-of-options', 'origin', `+refs/heads/${base}:${remoteRef}`], { cwd: repoPath, reject: false, env: FETCH_ENV, timeout: FETCH_TIMEOUT_MS });
  if (fetch.exitCode !== 0) {
    if (/couldn't find remote ref|remote ref does not exist/i.test(fetch.stderr)) {
      log.warn({ base }, `${label}: origin has no ${base} — using local ${base}`);
    } else {
      log.warn({ base, reason: redactGitError(fetch) }, `${label}: git fetch origin ${base} failed — using local ${base} (may be stale)`);
    }
    return base;
  }
  const sha = (await execa('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repoPath, reject: false })).stdout.trim();
  const local = (await execa('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd: repoPath, reject: false })).exitCode === 0;
  if (local && keepLocal) {
    // Exit 1 = local is ahead of or diverged from origin: keep it, it may carry unpushed commits.
    // Any other failure is a git error, reported as such; the remote copy is still the better cut.
    const ancestor = await execa('git', ['merge-base', '--is-ancestor', `refs/heads/${base}`, remoteRef], { cwd: repoPath, reject: false });
    if (ancestor.exitCode === 1) {
      log.warn({ base, sha }, `${label}: local ${base} is ahead of or diverged from origin/${base} — using local ${base}`);
      return base;
    }
    if (ancestor.exitCode !== 0) log.warn({ base, reason: redactGitError(ancestor) }, `${label}: git merge-base failed — assuming origin/${base} is current`);
  }
  log.info({ base, sha }, `${label}: using origin/${base} @ ${sha.slice(0, 7)}`);
  return remoteRef;
}

/** First `fatal:` line (or first line) of a git error, tokens and URL userinfo masked. */
export function redactGitError(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err);
  const line = text.split('\n').find((l) => l.startsWith('fatal:')) ?? text.split('\n')[0] ?? '';
  return redactTokens(line).replace(/\/\/[^/@\s]+@/g, '//***@');
}
