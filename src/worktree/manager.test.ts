import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from './manager.js';

let repo: string;
let wm: WorktreeManager;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-repo-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
  wm = new WorktreeManager(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('creates a worktree on a new branch', async () => {
    const wt = await wm.create('task-1', 'main');
    expect(wt.branch).toBe('vanguard/task-1');
    expect(await wm.isDirty(wt.path)).toBe(false);
  });

  it('detects uncommitted changes', async () => {
    const wt = await wm.create('task-2', 'main');
    await writeFile(join(wt.path, 'new.txt'), 'x');
    expect(await wm.isDirty(wt.path)).toBe(true);
  });

  it('includes new untracked files in the diff', async () => {
    const wt = await wm.create('task-3', 'main');
    await writeFile(join(wt.path, 'added.txt'), 'hello');
    const diff = await wm.diff(wt.path);
    expect(diff).toContain('added.txt');
  });

  it('removes a clean worktree', async () => {
    const wt = await wm.create('task-4', 'main');
    await wm.remove(wt.path);
    expect(await wm.isDirty(wt.path).catch(() => 'gone')).toBe('gone');
  });
});
