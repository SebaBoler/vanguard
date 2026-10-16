import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAssets, del, list, read, write, writeAsset } from './drafts.js';

describe('drafts', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'vanguard-drafts-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  function draftsDir(): string {
    return join(repoPath, '.vanguard', 'drafts');
  }

  it('T-24 write then read round-trips; write is atomic (no leftover .tmp); .gitignore seeded', async () => {
    await write(repoPath, 'draft-abc-1234', '{"body":"x"}');
    expect(await read(repoPath, 'draft-abc-1234')).toBe('{"body":"x"}');

    const names = await readdir(draftsDir());
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);

    const ignore = await readFile(join(draftsDir(), '.gitignore'), 'utf8');
    expect(ignore).toBe('*\n');
  });

  it('T-25 writableId strictness vs safeName leniency', async () => {
    await expect(write(repoPath, 'My Draft', '{}')).rejects.toThrow(/invalid draft id/);

    // Hand-place a file with a lenient-only name.
    await mkdir(draftsDir(), { recursive: true });
    await writeFile(join(draftsDir(), 'My Draft.json'), '{not json');

    expect(await list(repoPath)).toEqual(['My Draft']);
    await expect(del(repoPath, 'My Draft')).resolves.toBeUndefined();
    expect(await list(repoPath)).toEqual([]);
  });

  it('T-26 traversal rejected on write, read, delete', async () => {
    await expect(write(repoPath, '../evil', '{}')).rejects.toThrow(/invalid draft id/);
    await expect(read(repoPath, '../../etc/passwd')).rejects.toThrow(/invalid draft id/);
    await expect(del(repoPath, '..')).rejects.toThrow(/invalid draft id/);
    await expect(del(repoPath, 'a/b')).rejects.toThrow(/invalid draft id/);
  });

  it('T-27 refuses symlinked .vanguard, symlinked drafts dir, symlinked leaf file, dangling symlinked .gitignore', async () => {
    // Symlinked .vanguard itself (parent-level attack).
    {
      const repo = await mkdtemp(join(tmpdir(), 'vanguard-drafts-parent-'));
      const target = await mkdtemp(join(tmpdir(), 'vanguard-drafts-target-'));
      try {
        await mkdir(join(target, 'drafts'), { recursive: true });
        await symlink(target, join(repo, '.vanguard'));
        await expect(write(repo, 'draft-a', '{}')).rejects.toThrow(/symlink/);
        await expect(read(repo, 'draft-a')).rejects.toThrow(/symlink/);
        await expect(del(repo, 'draft-a')).rejects.toThrow(/symlink/);
        expect(await list(repo)).toEqual([]);
        expect(await readdir(join(target, 'drafts'))).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
      }
    }

    // Symlinked drafts dir.
    {
      const repo = await mkdtemp(join(tmpdir(), 'vanguard-drafts-dirlink-'));
      const target = await mkdtemp(join(tmpdir(), 'vanguard-drafts-target2-'));
      try {
        await mkdir(join(repo, '.vanguard'), { recursive: true });
        await symlink(target, join(repo, '.vanguard', 'drafts'));
        await expect(write(repo, 'draft-a', '{}')).rejects.toThrow(/symlink/);
        await expect(read(repo, 'draft-a')).rejects.toThrow(/symlink/);
        await expect(del(repo, 'draft-a')).rejects.toThrow(/symlink/);
        expect(await list(repo)).toEqual([]);
        expect(await readdir(target)).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
      }
    }

    // Symlinked draft leaf file: read must not follow it out of the tree.
    {
      const outside = await mkdtemp(join(tmpdir(), 'vanguard-drafts-outside-'));
      try {
        await mkdir(draftsDir(), { recursive: true });
        await writeFile(join(outside, 'loot.json'), '{"body":"secret"}');
        await symlink(join(outside, 'loot.json'), join(draftsDir(), 'draft-evil.json'));
        await expect(read(repoPath, 'draft-evil')).rejects.toThrow(/symlink/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }

    // Dangling symlinked .gitignore: must not be written through.
    {
      const outside = await mkdtemp(join(tmpdir(), 'vanguard-drafts-outside2-'));
      try {
        await symlink(join(outside, 'planted'), join(draftsDir(), '.gitignore'));
        await expect(write(repoPath, 'draft-b', '{}')).rejects.toThrow(/symlink/);
        await expect(lstat(join(outside, 'planted'))).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }
  });

  it('T-28 del is idempotent and still removes JSON when assets dir is a symlink pointing outside the repo', async () => {
    await expect(del(repoPath, 'draft-never-existed')).resolves.toBeUndefined();

    await write(repoPath, 'draft-x', '{}');
    const outside = await mkdtemp(join(tmpdir(), 'vanguard-drafts-outside3-'));
    try {
      await symlink(outside, join(draftsDir(), 'draft-x-assets'));

      await expect(del(repoPath, 'draft-x')).resolves.toBeUndefined();
      await expect(read(repoPath, 'draft-x')).rejects.toThrow(); // JSON is gone

      // Symlink target untouched/not followed.
      const outsideStat = await lstat(outside);
      expect(outsideStat.isDirectory()).toBe(true);

      // Deleting again is still a no-op.
      await expect(del(repoPath, 'draft-x')).resolves.toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('T-29 clearAssets removes the assets dir but draft JSON still reads fine; idempotent', async () => {
    await write(repoPath, 'draft-x', '{}');
    const asset = await writeAsset(repoPath, 'draft-x', 'pic.png', new Uint8Array([1, 2, 3]));
    expect(await readFile(asset)).toBeInstanceOf(Buffer);

    await clearAssets(repoPath, 'draft-x');
    await expect(readdir(join(draftsDir(), 'draft-x-assets'))).rejects.toThrow();
    expect(await read(repoPath, 'draft-x')).toBe('{}');

    // Idempotent.
    await expect(clearAssets(repoPath, 'draft-x')).resolves.toBeUndefined();
  });
});
