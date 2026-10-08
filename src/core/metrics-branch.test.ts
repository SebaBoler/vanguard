import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { pushMetrics, readBranchMetrics, METRICS_BRANCH_DEFAULT } from './metrics-branch.js';

let root: string;
let origin: string;
let repo: string;

async function clone(name: string): Promise<string> {
  const path = join(root, name);
  await execa('git', ['clone', '--quiet', origin, path]);
  await execa('git', ['-C', path, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', path, 'config', 'user.name', 't']);
  return path;
}

async function writeMetrics(path: string, lines: string[]): Promise<void> {
  await mkdir(join(path, '.vanguard', 'runs'), { recursive: true });
  await writeFile(join(path, '.vanguard', 'runs', 'metrics.jsonl'), `${lines.join('\n')}\n`);
}

const line = (taskId: string, ts: string): string => JSON.stringify({ evt: 'run_complete', ts, taskId, stage: 'implementer', costUsd: 0.1 });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-metrics-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  // A seeded main so the clone has a HEAD; the metrics branch must stay independent of it.
  const seed = join(root, 'seed');
  await execa('git', ['init', '--quiet', '-b', 'main', seed]);
  await execa('git', ['-C', seed, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', seed, 'config', 'user.name', 't']);
  await writeFile(join(seed, 'README.md'), 'x\n');
  await execa('git', ['-C', seed, 'add', '.']);
  await execa('git', ['-C', seed, 'commit', '--quiet', '-m', 'seed']);
  await execa('git', ['-C', seed, 'push', '--quiet', origin, 'main']);
  repo = await clone('repo');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('pushMetrics / readBranchMetrics', () => {
  it('creates the orphan branch on first push, reads it back, and skips already-present lines on a re-run', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z'), 'not json', line('b', '2026-10-08T10:01:00.000Z')]);
    const first = await pushMetrics(repo);
    expect(first).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 2, total: 2 });

    const text = await readBranchMetrics(repo);
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).toContain('"taskId":"a"');

    // The metrics branch is an orphan: no README, only metrics.jsonl.
    const tree = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree.trim()).toBe('metrics.jsonl');

    const again = await pushMetrics(repo);
    expect(again).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 0, total: 2 });
  });

  it('appends new lines from a second checkout on top of the existing tip', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    await pushMetrics(repo);
    const other = await clone('other');
    await writeMetrics(other, [line('a', '2026-10-08T10:00:00.000Z'), line('c', '2026-10-08T11:00:00.000Z')]);
    expect(await pushMetrics(other)).toMatchObject({ pushed: 1, total: 2 });
    const text = await readBranchMetrics(repo);
    expect(text.trim().split('\n').map((l) => (JSON.parse(l) as { taskId: string }).taskId)).toEqual(['a', 'c']);
    const commits = (await execa('git', ['-C', repo, 'rev-list', '--count', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(commits.trim()).toBe('2');
  });

  it('is a no-op without local metrics and reads an empty string when the branch does not exist', async () => {
    expect(await pushMetrics(repo)).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 0, total: 0 });
    expect(await readBranchMetrics(repo)).toBe('');
    expect(await readBranchMetrics(repo, { branch: 'other-metrics' })).toBe('');
  });

  it('honours a custom branch name', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    expect(await pushMetrics(repo, { branch: 'team-metrics' })).toMatchObject({ branch: 'team-metrics', pushed: 1 });
    expect(await readBranchMetrics(repo, { branch: 'team-metrics' })).toContain('"taskId":"a"');
    expect(await readBranchMetrics(repo)).toBe('');
  });
});
