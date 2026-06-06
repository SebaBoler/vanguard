import {
  reapContainers,
  dockerContainerLister,
  dockerContainerRemover,
  pruneWorktrees,
  reapRemoteBranches,
  gitRemoteBranchLister,
  ghMergedPrChecker,
  gitRemoteBranchRemover,
} from '../core/gc.js';
import type { ContainerRemover, RemoteBranchRemover } from '../core/gc.js';

export interface GcCliOptions {
  repoPath: string;
  maxAgeMs: number;
  remoteRepo?: string;
  dryRun: boolean;
}

export interface GcReport {
  containers: string[];
  branches: string[];
}

const noopContainerRemover: ContainerRemover = async () => undefined;
const noopBranchRemover: RemoteBranchRemover = async () => undefined;

/**
 * Reap stale sandbox containers, prune worktree admin entries, and (when remoteRepo is set) delete
 * merged remote vanguard/* branches. dryRun swaps in no-op removers, so the reapers still report what
 * they WOULD remove without touching anything. The entry point behind `vanguard gc`.
 */
export async function runGc(opts: GcCliOptions): Promise<GcReport> {
  const containers = await reapContainers(
    dockerContainerLister(),
    opts.dryRun ? noopContainerRemover : dockerContainerRemover(),
    opts.maxAgeMs,
  );
  if (!opts.dryRun) await pruneWorktrees(opts.repoPath);

  let branches: string[] = [];
  if (opts.remoteRepo !== undefined) {
    branches = await reapRemoteBranches(
      gitRemoteBranchLister(opts.repoPath),
      ghMergedPrChecker(opts.repoPath, opts.remoteRepo),
      opts.dryRun ? noopBranchRemover : gitRemoteBranchRemover(opts.repoPath),
      opts.maxAgeMs,
    );
  }
  return { containers, branches };
}
