import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseJsonlLines } from './stats.js';

/**
 * Durable run metrics for hosts whose checkout does not survive the run (GitHub Actions): the
 * `metrics.jsonl` lines a run wrote under `.vanguard/runs/` are appended to a single file on an
 * orphan branch of the repo, with git plumbing only — no checkout, no worktree, no merge. The branch
 * can hold more than one file (e.g. the approver's decisions.jsonl); appendBranchLines preserves every
 * tree entry it does not touch, so unrelated files never conflict with each other. `vanguard stats
 * --branch` reads the metrics copy from anywhere the repo is cloned.
 */

export const METRICS_BRANCH_DEFAULT = 'vanguard-metrics';
export const METRICS_FILE = 'metrics.jsonl';

export interface MetricsBranchOptions {
  branch?: string;
  remote?: string;
}

export interface BranchFileOptions {
  branch?: string;
  remote?: string;
  file?: string;
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

async function fileAtName(cwd: string, commit: string | undefined, file: string): Promise<string> {
  if (commit === undefined) return '';
  try {
    return await git(cwd, ['show', `${commit}:${file}`]);
  } catch {
    return '';
  }
}

/** The named file as currently on the branch ('' when absent or the branch does not exist). */
export async function readBranchFile(repoPath: string, opts: BranchFileOptions = {}): Promise<string> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  const file = opts.file ?? METRICS_FILE;
  return fileAtName(repoPath, await fetchTip(repoPath, remote, branch), file);
}

/** The metrics file as currently on the branch ('' when the branch does not exist). */
export async function readBranchMetrics(repoPath: string, opts: MetricsBranchOptions = {}): Promise<string> {
  return readBranchFile(repoPath, { ...opts, file: METRICS_FILE });
}

/** `git ls-tree <tip>` entries other than `file`, kept byte-for-byte so a mktree rewrite never drops a sibling file. */
async function sidelinedEntries(cwd: string, tip: string | undefined, file: string): Promise<string[]> {
  if (tip === undefined) return [];
  const out = await git(cwd, ['ls-tree', tip]);
  return out.split('\n').filter((entry) => entry.trim() !== '' && !entry.endsWith(`\t${file}`));
}

/**
 * Append JSONL lines to `opts.file` on the branch, preserving every other tree entry (so, for example,
 * `decisions.jsonl` and `metrics.jsonl` can coexist on the same orphan branch). Dedupe: by
 * `opts.key(record)` when given (skipping any record a key maps to undefined for), else by exact line
 * (the original metrics semantics). A malformed input line is dropped. Idempotent per key/line; a
 * concurrent push from another run is retried once on a fresh tip.
 */
export async function appendBranchLines(
  repoPath: string,
  lines: string[],
  opts: BranchFileOptions & { file: string; key?: (record: Record<string, unknown>) => string | undefined },
): Promise<PushMetricsResult> {
  const branch = opts.branch ?? METRICS_BRANCH_DEFAULT;
  const remote = opts.remote ?? 'origin';
  const file = opts.file;

  for (let attempt = 0; ; attempt += 1) {
    const tip = await fetchTip(repoPath, remote, branch);
    const existingText = await fileAtName(repoPath, tip, file);
    const existingRecords = parseJsonlLines(existingText);
    const existingLines = existingRecords.map((o) => JSON.stringify(o));
    const seenKeys = new Set<string>(
      opts.key !== undefined
        ? existingRecords.map((r) => opts.key!(r)).filter((k): k is string => k !== undefined)
        : existingLines,
    );

    const fresh: string[] = [];
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const dedupeKey = opts.key !== undefined ? opts.key(parsed) : JSON.stringify(parsed);
      if (dedupeKey === undefined || seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      fresh.push(JSON.stringify(parsed));
    }
    if (fresh.length === 0) return { branch, pushed: 0, total: existingLines.length };

    const content = `${[...existingLines, ...fresh].join('\n')}\n`;
    const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: repoPath, input: content })).stdout;
    const others = await sidelinedEntries(repoPath, tip, file);
    const treeInput = `${[...others, `100644 blob ${blob}\t${file}`].join('\n')}\n`;
    const tree = (await execa('git', ['mktree'], { cwd: repoPath, input: treeInput })).stdout;
    const message = `${file}: +${fresh.length} line${fresh.length === 1 ? '' : 's'}`;
    const commit = await git(repoPath, [
      '-c', 'user.name=Vanguard', '-c', 'user.email=vanguard@local',
      'commit-tree', tree, ...(tip !== undefined ? ['-p', tip] : []), '-m', message,
    ]);
    try {
      await git(repoPath, ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
      return { branch, pushed: fresh.length, total: existingLines.length + fresh.length };
    } catch (err) {
      // Another run pushed in between: re-fetch and append on top of its tip, once.
      if (attempt >= 1) throw err;
    }
  }
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
  return appendBranchLines(repoPath, localText.split('\n'), { branch, remote, file: METRICS_FILE });
}
