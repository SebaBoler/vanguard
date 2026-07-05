import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WorktreeError } from '../core/errors.js';

export interface Worktree {
  path: string;
  branch: string;
}

export interface CreateOptions {
  /** Reuse an existing vanguard/<taskId>-* branch instead of minting a new run id. */
  reuse?: boolean;
}

/** Short, unique-per-run id so re-running the same task never collides on an existing branch/path. */
const defaultRunId = (): string => randomUUID().slice(0, 8);

function parseWorktreeList(output: string): Array<{ path: string; branch: string }> {
  const result: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    } else if (line === '' && cur.path && cur.branch) {
      result.push({ path: cur.path, branch: cur.branch });
      cur = {};
    }
  }
  if (cur.path && cur.branch) result.push({ path: cur.path, branch: cur.branch });
  return result;
}

export class WorktreeManager {
  constructor(
    private readonly repoPath: string,
    private readonly baseDir: string = join(repoPath, '.vanguard', 'worktrees'),
    private readonly newRunId: () => string = defaultRunId,
  ) {}

  async create(taskId: string, baseBranch: string = 'main', opts: CreateOptions = {}): Promise<Worktree> {
    if (opts.reuse) {
      const existing = await this.findExistingBranch(taskId);
      if (existing) return existing;
    }
    // Append a unique run id: disposeContext removes the worktree but not the branch, and a prior
    // run also leaves a remote branch, so reusing `vanguard/<taskId>` collides on re-run.
    const name = `${taskId}-${this.newRunId()}`;
    const branch = `vanguard/${name}`;
    const path = join(this.baseDir, name);
    try {
      await execa('git', ['worktree', 'add', '-b', branch, path, baseBranch], { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to create worktree for ${taskId}`, { cause });
    }
  }

  private async findExistingBranch(taskId: string): Promise<Worktree | null> {
    let branchOut: string;
    let wtOut: string;
    try {
      [{ stdout: branchOut }, { stdout: wtOut }] = await Promise.all([
        execa('git', ['branch', '--list', `vanguard/${taskId}-*`], { cwd: this.repoPath }),
        execa('git', ['worktree', 'list', '--porcelain'], { cwd: this.repoPath }),
      ]);
    } catch (cause) {
      throw new WorktreeError(`Failed to query git state for ${taskId}`, { cause });
    }
    const branch = branchOut
      .split('\n')
      .map(b => b.trim().replace(/^[*+] /, ''))
      .find(Boolean);
    if (!branch) return null;

    // Use create()'s own path form: git reports a symlink-resolved path (e.g. /private/var on macOS),
    // which would not string-equal the join(baseDir, name) that create() returns.
    const name = branch.slice('vanguard/'.length);
    const path = join(this.baseDir, name);

    // If a live worktree already uses this branch, reuse it.
    const live = parseWorktreeList(wtOut).find((w) => w.branch === `refs/heads/${branch}`);
    if (live) return { path, branch };

    // Branch exists but its worktree was removed — recreate the worktree on the existing branch.
    try {
      await execa('git', ['worktree', 'add', path, branch], { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to reuse worktree for ${taskId}`, { cause });
    }
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
      return stdout.trim() !== '';
    } catch (cause) {
      throw new WorktreeError(`Failed to check worktree status ${worktreePath}`, { cause });
    }
  }

  async diff(worktreePath: string): Promise<string> {
    try {
      // -N (intent-to-add) so brand-new untracked files appear in `git diff HEAD`.
      await execa('git', ['add', '-A', '-N'], { cwd: worktreePath });
      const { stdout } = await execa('git', ['diff', 'HEAD'], { cwd: worktreePath });
      return stdout;
    } catch (cause) {
      throw new WorktreeError(`Failed to get worktree diff ${worktreePath}`, { cause });
    }
  }

  /**
   * Commit messages in `<baseRef>..HEAD`, for the commit-message closing-keyword scan (a rebase
   * merge closes an issue per commit message, regardless of the PR body). Best-effort: returns []
   * (never throws) when `baseRef` can't be resolved locally.
   */
  async commitMessages(worktreePath: string, baseRef: string): Promise<string[]> {
    try {
      const { stdout } = await execa('git', ['log', `${baseRef}..HEAD`, '--format=%B%x00'], { cwd: worktreePath });
      return stdout
        .split('\0')
        .map((m) => m.trim())
        .filter((m) => m !== '');
    } catch {
      return [];
    }
  }

  async remove(worktreePath: string, force: boolean = false): Promise<void> {
    try {
      await execa('git', ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], { cwd: this.repoPath });
    } catch (cause) {
      throw new WorktreeError(`Failed to remove worktree ${worktreePath}`, { cause });
    }
  }
}
