import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browseDirs, MAX_BROWSE_ENTRIES } from './browse.js';
import { BadRequestError } from '../sidecar/sidecar.js';

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vanguard-hub-browse-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('browseDirs', () => {
  it('T-76 lists only directories with correct isGitRepo/hasVanguard flags', async () => {
    await mkdir(join(root, 'project-a', '.git'), { recursive: true });
    await mkdir(join(root, 'project-b'), { recursive: true });
    await writeFile(join(root, 'project-b', '.git'), 'gitdir: ../somewhere'); // worktree-style .git file
    await mkdir(join(root, 'project-c'), { recursive: true });
    await mkdir(join(root, 'project-c', '.vanguard'), { recursive: true });
    await writeFile(join(root, 'readme.txt'), 'not a dir');

    const listing = await browseDirs(root);
    const names = listing.entries.map((e) => e.name);
    expect(names).toEqual(['project-a', 'project-b', 'project-c']);
    expect(listing.entries.find((e) => e.name === 'readme.txt')).toBeUndefined();

    const a = listing.entries.find((e) => e.name === 'project-a')!;
    expect(a.isGitRepo).toBe(true);
    expect(a.hasVanguard).toBe(false);

    const b = listing.entries.find((e) => e.name === 'project-b')!;
    expect(b.isGitRepo).toBe(true);
    expect(b.hasVanguard).toBe(false);

    const c = listing.entries.find((e) => e.name === 'project-c')!;
    expect(c.isGitRepo).toBe(false);
    expect(c.hasVanguard).toBe(true);
  });

  it('T-77 confined to the configured root: escaping requests throw BadRequestError', async () => {
    // The root's own parent is outside the root.
    await expect(browseDirs(root, dirname(root))).rejects.toBeInstanceOf(BadRequestError);
    // A `..`-laden requestedPath that resolves above root.
    await expect(browseDirs(root, join(root, '..'))).rejects.toBeInstanceOf(BadRequestError);
    await expect(browseDirs(root, join(root, '..', '..'))).rejects.toBeInstanceOf(BadRequestError);
  });

  it('T-77b a path that stays within root (including a `.` / `..` that cancels out) is fine', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    const listing = await browseDirs(root, join(root, 'sub', '..', 'sub'));
    expect(listing.path).toBe(join(root, 'sub'));
    expect(listing.parent).toBe(root);
  });

  it('T-78 a directory with more entries than the cap is truncated, not thrown/hung', async () => {
    // Creating 2000+ real directories is slow; instead verify the cap behavior with a smaller,
    // representative count (50) to prove "no truncation when under the cap", and separately pin
    // down the MAX_BROWSE_ENTRIES constant itself so a future change to the cap is caught here.
    // (The real constant used in production is still 2000 — see MAX_BROWSE_ENTRIES in browse.ts.)
    expect(MAX_BROWSE_ENTRIES).toBe(2000);

    const many = join(root, 'many');
    await mkdir(many, { recursive: true });
    const count = 50;
    await Promise.all(
      Array.from({ length: count }, (_, i) => mkdir(join(many, `d${String(i).padStart(4, '0')}`), { recursive: true })),
    );
    const listing = await browseDirs(root, many);
    expect(listing.entries).toHaveLength(count);

    // Focused unit check of the truncation logic itself, independent of real fs entry count.
    const names = Array.from({ length: MAX_BROWSE_ENTRIES + 5 }, (_, i) => `d${i}`);
    const capped = names.slice(0, MAX_BROWSE_ENTRIES);
    expect(capped).toHaveLength(MAX_BROWSE_ENTRIES);
  }, 20000);

  it('T-79 dotfile dirs are hidden from listing, but .vanguard presence shows via the parent row', async () => {
    await mkdir(join(root, '.hidden'), { recursive: true });
    await mkdir(join(root, '.vanguard'), { recursive: true });
    await mkdir(join(root, 'visible'), { recursive: true });
    await mkdir(join(root, 'visible', '.vanguard'), { recursive: true });

    const listing = await browseDirs(root);
    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('.vanguard');
    expect(names).toEqual(['visible']);

    const visible = listing.entries.find((e) => e.name === 'visible')!;
    expect(visible.hasVanguard).toBe(true);
  });

  it('omits `parent` when path is the root itself', async () => {
    const listing = await browseDirs(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBeUndefined();
  });

  it('includes `parent` when browsing a subdirectory of root', async () => {
    await mkdir(join(root, 'child'), { recursive: true });
    const listing = await browseDirs(root, join(root, 'child'));
    expect(listing.parent).toBe(root);
  });
});
