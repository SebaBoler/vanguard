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
  await Promise.all(stale.map((container) => remover(container.id)));
  return stale.map((container) => container.id);
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
