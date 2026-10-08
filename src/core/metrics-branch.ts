import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseJsonlLines } from './stats.js';

/**
 * Durable run metrics for hosts whose checkout does not survive the run (GitHub Actions): the
 * `metrics.jsonl` lines a run wrote under `.vanguard/runs/` are appended to a single file on an
 * orphan branch of the repo, with git plumbing only — no checkout, no worktree, no merge. Nothing
 * else lives on that branch, so it never conflicts with code, and `vanguard stats --branch` reads it
 * from anywhere the repo is cloned.
 */

export const METRICS_BRANCH_DEFAULT = 'vanguard-metrics';
export const METRICS_FILE = 'metrics.jsonl';

export interface MetricsBranchOptions {
  branch?: string;
  remote?: string;
}

export interface PushMetricsResult {
  branch: string;
  /** Lines appended (lines already on the branch are skipped, so a re-run never duplicates). */
  pushed: number;
  /** Lines the branch holds after the push. */
  total: number;
}

const git = (cwd: string, args: string[]): Promise<string> =>
  execa('git', args, { cwd }).then((r) => r.stdout);

/** The branch tip's commit sha, or undefined when the remote has no such branch yet. */
async function fetchTip(cwd: string, remote: string, branch: string): Promise<string | undefined> {
  try {
    await git(cwd, ['fetch', '--quiet', remote, `refs/heads/${branch}`]);
    return await git(cwd, ['rev-parse', 'FETCH_HEAD']);
  } catch {
    return undefined;
  }
}

async function fileAt(cwd: string, commit: string | undefined): Promise<string> {
  if (commit === undefined) return '';
  try {
    return await git(cwd, ['show', `${commit}:${METRICS_FILE}`]);
  } catch {
    return '';
  }
}

/** The metrics file as currently on the branch ('' when the branch does not exist). */
export async function readBranchMetrics(repoPath: string, opts: MetricsBranchOptions = {}): Promise<string> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  return fileAt(repoPath, await fetchTip(repoPath, remote, branch));
}

/** Only well-formed metric lines travel; blank/malformed lines are dropped on the way. */
function metricLines(text: string): string[] {
  return parseJsonlLines(text).map((o) => JSON.stringify(o));
}

/**
 * Append the local run's metric lines to the branch and push. Idempotent: lines already present are
 * skipped. A concurrent push from another run is retried once on a fresh tip. Never throws for "no
 * local metrics" — a run that produced none has nothing to persist.
 */
export async function pushMetrics(repoPath: string, opts: MetricsBranchOptions = {}): Promise<PushMetricsResult> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  let localText = '';
  try {
    localText = await readFile(join(repoPath, '.vanguard', 'runs', METRICS_FILE), 'utf8');
  } catch {
    return { branch, pushed: 0, total: 0 };
  }
  const local = metricLines(localText);

  for (let attempt = 0; ; attempt += 1) {
    const tip = await fetchTip(repoPath, remote, branch);
    const existing = metricLines(await fileAt(repoPath, tip));
    const have = new Set(existing);
    const fresh = local.filter((line) => !have.has(line));
    if (fresh.length === 0) return { branch, pushed: 0, total: existing.length };

    const content = `${[...existing, ...fresh].join('\n')}\n`;
    const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: repoPath, input: content })).stdout;
    const tree = (await execa('git', ['mktree'], { cwd: repoPath, input: `100644 blob ${blob}\t${METRICS_FILE}\n` })).stdout;
    const message = `metrics: +${fresh.length} line${fresh.length === 1 ? '' : 's'}`;
    const commit = await git(repoPath, [
      '-c', 'user.name=Vanguard', '-c', 'user.email=vanguard@local',
      'commit-tree', tree, ...(tip !== undefined ? ['-p', tip] : []), '-m', message,
    ]);
    try {
      await git(repoPath, ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
      return { branch, pushed: fresh.length, total: existing.length + fresh.length };
    } catch (err) {
      // Another run pushed in between: re-fetch and append on top of its tip, once.
      if (attempt >= 1) throw err;
    }
  }
}
