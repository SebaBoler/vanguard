import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { pushMetrics, readBranchMetrics, appendBranchLines, readBranchFile, METRICS_BRANCH_DEFAULT } from './metrics-branch.js';

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

describe('appendBranchLines', () => {
  it('preserves sibling tree entries when appending a different file', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    await pushMetrics(repo);

    const decision = (pr: number, sha: string): string => JSON.stringify({ prNumber: pr, headSha: sha, verdict: 'APPROVE' });
    await appendBranchLines(repo, [decision(1, 'sha1')], {
      file: 'decisions.jsonl',
      key: (r) => `${r.prNumber}:${r.headSha}`,
    });

    const tree = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree.trim().split('\n').sort()).toEqual(['decisions.jsonl', 'metrics.jsonl']);
    expect(await readBranchMetrics(repo)).toContain('"taskId":"a"');
    expect(await readBranchFile(repo, { file: 'decisions.jsonl' })).toContain('"prNumber":1');

    // metrics push afterwards must not drop decisions.jsonl.
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z'), line('b', '2026-10-08T10:01:00.000Z')]);
    await pushMetrics(repo);
    const tree2 = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree2.trim().split('\n').sort()).toEqual(['decisions.jsonl', 'metrics.jsonl']);
    expect(await readBranchFile(repo, { file: 'decisions.jsonl' })).toContain('"prNumber":1');
  });

  it('dedupes by key, skipping a record with the same key but a different timestamp', async () => {
    const decision = (pr: number, sha: string, ts: string): string =>
      JSON.stringify({ prNumber: pr, headSha: sha, timestamp: ts });
    const opts = { file: 'decisions.jsonl', key: (r: Record<string, unknown>) => `${r.prNumber}:${r.headSha}` };
    await appendBranchLines(repo, [decision(1, 'sha1', 't0')], opts);
    const again = await appendBranchLines(repo, [decision(1, 'sha1', 't1')], opts);
    expect(again).toMatchObject({ pushed: 0, total: 1 });
    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('"timestamp":"t0"');
  });

  it('dedupes by exact line when no key is given, same as the original metrics semantics', async () => {
    const opts = { file: 'other.jsonl' };
    await appendBranchLines(repo, [line('a', '2026-10-08T10:00:00.000Z')], opts);
    const again = await appendBranchLines(repo, [line('a', '2026-10-08T10:00:00.000Z')], opts);
    expect(again).toMatchObject({ pushed: 0, total: 1 });
    const fresh = await appendBranchLines(repo, [line('b', '2026-10-08T10:01:00.000Z')], opts);
    expect(fresh).toMatchObject({ pushed: 1, total: 2 });
  });
});

it('ignores non-object JSON input before invoking a record key', async () => {
  const result = await appendBranchLines(repo, ['null', '[]', '1', '"text"', '{"id":1}'], {
    file: 'decisions.jsonl',
    key: (record) => String(record.id),
  });
  expect(result).toMatchObject({ pushed: 1, total: 1 });
  expect((await readBranchFile(repo, { file: 'decisions.jsonl' })).trim()).toBe('{"id":1}');
});
