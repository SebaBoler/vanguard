import {
  reapContainers,
  dockerContainerLister,
  dockerContainerRemover,
  reapEgressNetworks,
  dockerEgressNetworkLister,
  dockerEgressNetworkRemover,
  pruneWorktrees,
  reapRemoteBranches,
  gitRemoteBranchLister,
  ghMergedPrChecker,
  ghAbandonedPrChecker,
  gitRemoteBranchRemover,
} from '../core/gc.js';

export interface GcCliOptions {
  repoPath: string;
  maxAgeMs: number;
  remoteRepo?: string;
  dryRun: boolean;
  /** Also delete branches whose PR is closed-unmerged (not just merged). */
  abandoned: boolean;
}

export interface GcReport {
  containers: string[];
  networks: string[];
  branches: string[];
}

const noop = async (): Promise<void> => undefined;

/**
 * Reap stale sandbox containers, prune worktree admin entries, and (when remoteRepo is set) delete
 * merged remote vanguard/* branches. dryRun swaps in no-op removers, so the reapers still report what
 * they WOULD remove without touching anything. The entry point behind `vanguard gc`.
 */
export async function runGc(opts: GcCliOptions): Promise<GcReport> {
  const containers = await reapContainers(
    dockerContainerLister(),
    opts.dryRun ? noop : dockerContainerRemover(),
    opts.maxAgeMs,
  );
  const networks = await reapEgressNetworks(
    dockerEgressNetworkLister(),
    opts.dryRun ? noop : dockerEgressNetworkRemover(),
  );
  if (!opts.dryRun) await pruneWorktrees(opts.repoPath);

  let branches: string[] = [];
  if (opts.remoteRepo !== undefined) {
    branches = await reapRemoteBranches(
      gitRemoteBranchLister(opts.repoPath),
      ghMergedPrChecker(opts.repoPath, opts.remoteRepo),
      opts.dryRun ? noop : gitRemoteBranchRemover(opts.repoPath),
      opts.maxAgeMs,
      opts.abandoned ? { abandoned: true, isAbandoned: ghAbandonedPrChecker(opts.repoPath, opts.remoteRepo) } : undefined,
    );
  }
  return { containers, networks, branches };
}
