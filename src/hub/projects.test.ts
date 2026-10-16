import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregate, add, list, loadPaths, remove } from './projects.js';

let cfg: string;
let repoRoot: string;

beforeEach(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'vanguard-hub-projects-cfg-'));
  repoRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-projects-repo-'));
});

async function oneRunRepo(repo: string): Promise<void> {
  const dir = join(repo, '.vanguard', 'runs', 'task-1');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, '2026-07-06T19-12-02-123Z-implement.json'),
    JSON.stringify({
      taskId: 'task-1',
      completed: true,
      exitReason: 'completed',
      turns: 3,
      worktreePath: '/tmp/wt',
      worktreePreserved: false,
      finalText: 'ok',
      costUsd: 0.1,
      timestamp: '2026-07-06T19:12:02.123Z',
      stage: 'implement',
    }),
  );
}

describe('add/list/remove', () => {
  it('T-16 round-trips through the store file, de-duping and emptying out', async () => {
    const repo = join(repoRoot, 'proj-a');
    await oneRunRepo(repo);

    const afterAdd = await add(cfg, repo);
    expect(afterAdd.length).toBe(1);
    expect(afterAdd[0]?.runCount).toBe(1);

    // dedup: adding the same path again keeps a single entry
    const afterAddAgain = await add(cfg, repo);
    expect(afterAddAgain.length).toBe(1);

    const afterRemove = await remove(cfg, repo);
    expect(afterRemove).toEqual([]);
  });

  it('missing store lists empty', async () => {
    expect(await list(cfg)).toEqual([]);
  });
});

describe('corrupt store', () => {
  it('T-17 loadPaths and add throw on corrupt JSON and never wipe the original bytes', async () => {
    const storeFile = join(cfg, 'projects.json');
    await mkdir(cfg, { recursive: true });
    await writeFile(storeFile, '{ not valid json');

    await expect(loadPaths(cfg)).rejects.toThrow();
    await expect(add(cfg, '/some/repo')).rejects.toThrow();

    const raw = await readFile(storeFile, 'utf8');
    expect(raw).toBe('{ not valid json');
  });
});

describe('aggregate', () => {
  it('T-18 computes counts, cost, lastRun and 24h velocity with an injected now', async () => {
    const repo = join(repoRoot, 'proj-a');
    await oneRunRepo(repo);

    // ~48 minutes after the fixture run so the 24h velocity window is deterministic.
    const now = new Date('2026-07-06T20:00:00Z');
    const p = await aggregate(repo, now);

    expect(p.name).toBe('proj-a');
    expect(p.runCount).toBe(1);
    expect(p.taskCount).toBe(1);
    expect(Math.abs(p.totalCostUsd - 0.1)).toBeLessThan(1e-9);
    expect(p.failedCount).toBe(0);
    expect(p.lastRun).toBe('2026-07-06T19:12:02.123Z');
    expect(p.runningCount).toBe(0);
    expect(p.runsLast24h).toBe(1);
  });

  it('T-19 busts the per-repo summary cache on a fingerprint shift and never caches a miss', async () => {
    const repo = join(repoRoot, 'proj-cache');

    // Cache MISS path: no .vanguard/runs directory at all yet — must not get pinned at 0.
    const empty = await aggregate(repo);
    expect(empty.runCount).toBe(0);

    await oneRunRepo(repo);
    const afterFirstRun = await aggregate(repo);
    expect(afterFirstRun.runCount).toBe(1);

    // A second run under a new task dir must shift the fingerprint and bust the cache.
    const dir2 = join(repo, '.vanguard', 'runs', 'task-2');
    await mkdir(dir2, { recursive: true });
    await writeFile(
      join(dir2, '2026-07-06T20-00-00-000Z-implement.json'),
      JSON.stringify({
        taskId: 'task-2',
        completed: true,
        exitReason: 'completed',
        turns: 1,
        worktreePath: '/tmp/wt',
        worktreePreserved: false,
        finalText: 'ok',
        costUsd: 0.2,
        timestamp: '2026-07-06T20:00:00.000Z',
        stage: 'implement',
      }),
    );
    const afterSecondRun = await aggregate(repo);
    expect(afterSecondRun.runCount).toBe(2);
  });
});
