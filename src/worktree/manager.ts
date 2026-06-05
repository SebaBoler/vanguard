import { execa } from 'execa';
import { join } from 'node:path';
import { WorktreeError } from '../core/errors.js';

export interface Worktree {
  path: string;
  branch: string;
}

export class WorktreeManager {
  constructor(
    private readonly repoPath: string,
    private readonly baseDir: string = join(repoPath, '.vanguard', 'worktrees'),
  ) {}

  async create(taskId: string, baseBranch: string = 'main'): Promise<Worktree> {
    const branch = `vanguard/${taskId}`;
    const path = join(this.baseDir, taskId);
    try {
      await execa('git', ['worktree', 'add', '-b', branch, path, baseBranch], { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Nie udało się utworzyć worktree dla ${taskId}`, { cause });
    }
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
      return stdout.trim() !== '';
    } catch (cause) {
      throw new WorktreeError(`Nie udało się sprawdzić stanu worktree ${worktreePath}`, { cause });
    }
  }

  async diff(worktreePath: string): Promise<string> {
    try {
      // -N (intent-to-add) so brand-new untracked files appear in `git diff HEAD`.
      await execa('git', ['add', '-A', '-N'], { cwd: worktreePath });
      const { stdout } = await execa('git', ['diff', 'HEAD'], { cwd: worktreePath });
      return stdout;
    } catch (cause) {
      throw new WorktreeError(`Nie udało się pobrać diff worktree ${worktreePath}`, { cause });
    }
  }

  async remove(worktreePath: string, force: boolean = false): Promise<void> {
    try {
      await execa('git', ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], { cwd: this.repoPath });
    } catch (cause) {
      throw new WorktreeError(`Nie udało się usunąć worktree ${worktreePath}`, { cause });
    }
  }
}
