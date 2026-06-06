import { execa } from 'execa';

export interface ContainerInfo {
  id: string;
  ageMs: number;
}

export type ContainerLister = () => Promise<ContainerInfo[]>;
export type ContainerRemover = (id: string) => Promise<void>;

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Remove vanguard-labeled sandbox containers older than maxAgeMs. Lister/remover are
 * injected so this is unit-testable without Docker. Returns the removed container ids.
 */
export async function reapContainers(
  lister: ContainerLister,
  remover: ContainerRemover,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<string[]> {
  const stale = (await lister()).filter((container) => container.ageMs > maxAgeMs);
  const ids = stale.map((container) => container.id);
  await Promise.all(ids.map(remover));
  return ids;
}

/** Docker-backed lister of vanguard-labeled containers with their age in ms. */
export function dockerContainerLister(now: () => number = Date.now): ContainerLister {
  return async (): Promise<ContainerInfo[]> => {
    const { stdout } = await execa('docker', [
      'ps',
      '-a',
      '--filter',
      'label=vanguard.runId',
      '--format',
      '{{.ID}}\t{{.CreatedAt}}',
    ]);
    if (stdout.trim() === '') return [];
    return stdout
      .split('\n')
      .map((line): ContainerInfo => {
        const [id, createdAt] = line.split('\t');
        const created = createdAt !== undefined ? Date.parse(createdAt) : Number.NaN;
        const ageMs = Number.isNaN(created) ? 0 : now() - created;
        return { id: id ?? '', ageMs };
      })
      .filter((container) => container.id !== '');
  };
}

/** Docker-backed remover (force-remove, ignore missing). */
export function dockerContainerRemover(): ContainerRemover {
  return async (id: string): Promise<void> => {
    await execa('docker', ['rm', '-f', id], { reject: false });
  };
}

/** Prune git worktree admin entries whose directories were removed. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await execa('git', ['worktree', 'prune'], { cwd: repoPath, reject: false });
}

export interface RemoteBranchInfo {
  name: string;
  ageMs: number;
}

export type RemoteBranchLister = () => Promise<RemoteBranchInfo[]>;
export type MergedChecker = (branch: string) => Promise<boolean>;
export type RemoteBranchRemover = (branch: string) => Promise<void>;

const PR_CHECK_CONCURRENCY = 8;

/** Map with a bounded concurrency so a large branch backlog does not spawn one `gh` per branch at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/**
 * Delete stale remote `vanguard/*` branches left behind by merged runs (each run uses a unique
 * branch, so they accumulate). A branch is reaped only when it is older than maxAgeMs AND its PR was
 * MERGED — a branch that was never merged (closed/abandoned, or still under review with no PR yet) is
 * always kept. The merged check runs only for aged candidates, bounded to a small concurrency.
 * Lister/checker/remover are injected so this is unit-testable without git/gh. Returns removed names.
 */
export async function reapRemoteBranches(
  lister: RemoteBranchLister,
  isMerged: MergedChecker,
  remover: RemoteBranchRemover,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<string[]> {
  const aged = (await lister()).filter((branch) => branch.ageMs > maxAgeMs);
  const names = (
    await mapLimit(aged, PR_CHECK_CONCURRENCY, async (branch) => ((await isMerged(branch.name)) ? branch.name : null))
  ).filter((name): name is string => name !== null);
  await Promise.all(names.map(remover));
  return names;
}

/** Git-backed lister of remote `vanguard/*` branches with their age (from the last commit date). */
export function gitRemoteBranchLister(
  repoPath: string,
  opts: { remote?: string; prefix?: string; now?: () => number } = {},
): RemoteBranchLister {
  const remote = opts.remote ?? 'origin';
  const prefix = opts.prefix ?? 'vanguard/';
  const now = opts.now ?? Date.now;
  return async (): Promise<RemoteBranchInfo[]> => {
    const { stdout } = await execa(
      'git',
      ['for-each-ref', '--format', '%(refname:short)\t%(committerdate:unix)', `refs/remotes/${remote}/${prefix}`],
      { cwd: repoPath },
    );
    return stdout
      .split('\n')
      .map((line): RemoteBranchInfo => {
        const [short = '', unix] = line.split('\t');
        // refname:short is `<remote>/vanguard/<x>`; strip the remote so the name works with gh/push.
        const name = short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : short;
        const created = Number(unix) * 1000;
        const ageMs = Number.isFinite(created) ? now() - created : 0; // unparseable date -> treat as new (keep)
        return { name, ageMs };
      })
      .filter((branch) => branch.name !== '');
  };
}

/** gh-backed merged-PR checker. Conservative: on any gh error it reports NOT merged, so the branch is kept. */
export function ghMergedPrChecker(repoPath: string, repoSlug?: string): MergedChecker {
  return async (branch: string): Promise<boolean> => {
    const args = ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number'];
    if (repoSlug !== undefined) args.push('--repo', repoSlug);
    const result = await execa('gh', args, { cwd: repoPath, reject: false });
    if (result.exitCode !== 0) return false;
    try {
      return (JSON.parse(result.stdout) as unknown[]).length > 0;
    } catch {
      return false;
    }
  };
}

/** Git-backed remover that deletes the branch on the remote (ignores missing). */
export function gitRemoteBranchRemover(repoPath: string, remote: string = 'origin'): RemoteBranchRemover {
  return async (branch: string): Promise<void> => {
    await execa('git', ['push', remote, '--delete', branch], { cwd: repoPath, reject: false });
  };
}
