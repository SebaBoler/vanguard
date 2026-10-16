import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRunSummaries, readRunDetail, readTextNoSymlink, runsFingerprint, sanitizeTimestamp } from './runs.js';

// runs.ts throws the shared BadRequestError from sidecar.js (not re-exported); import it directly for assertions.
import { BadRequestError } from '../sidecar/sidecar.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vanguard-hub-runs-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

async function fixture(repo: string): Promise<string> {
  const dir = join(repo, '.vanguard', 'runs', 'task-7');
  await mkdir(dir, { recursive: true });
  await write(
    join(dir, '2026-07-06T19-12-02-123Z-implement.json'),
    JSON.stringify({
      taskId: 'task-7',
      completed: true,
      exitReason: 'completed',
      turns: 12,
      worktreePath: '/tmp/wt',
      worktreePreserved: false,
      finalText: 'did it',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 800 },
      costUsd: 0.12,
      cacheEfficiency: 0.44,
      durationMs: 8123,
      model: 'claude-opus-4',
      timestamp: '2026-07-06T19:12:02.123Z',
      stage: 'implement',
      prUrl: 'http://pr/1',
    }),
  );
  await write(
    join(dir, '2026-07-06T19-12-02-123Z-review.json'),
    JSON.stringify({
      taskId: 'task-7',
      completed: true,
      exitReason: 'completed',
      turns: 4,
      worktreePath: '/tmp/wt',
      worktreePreserved: false,
      finalText: 'looks ok',
      costUsd: 0.05,
      timestamp: '2026-07-06T19:12:02.123Z',
      stage: 'review',
    }),
  );
  await write(join(dir, '2026-07-06T19-12-02-123Z-implement.diff'), 'diff --git a b\n+x');
  await write(join(dir, '2026-07-06T19-12-02-123Z-implement.transcript.log'), 'line1\nline2');
  await write(
    join(dir, '2026-07-06T19-12-02-123Z.proof.json'),
    JSON.stringify({ command: 'pnpm test', exitCode: 1, passed: false, sha256: 'deadbeef', outputTail: '1 test failed' }),
  );
  return join(repo, '.vanguard', 'runs');
}

describe('sanitizeTimestamp', () => {
  it('T-10 matches vanguard timestamp sanitization', () => {
    expect(sanitizeTimestamp('2026-07-06T19:12:02.123Z')).toBe('2026-07-06T19-12-02-123Z');
  });
});

describe('listRunSummaries', () => {
  it('T-01 groups two stage records sharing one timestamp into one summary', async () => {
    const runsRoot = await fixture(tmp);
    const out = await listRunSummaries(runsRoot);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.taskId).toBe('task-7');
    expect(s.stages).toEqual(['implement', 'review']);
    expect(s.totalCostUsd).toBeCloseTo(0.17, 9);
    expect(s.anyFailed).toBe(false);
    expect(s.prUrl).toBe('http://pr/1');
  });

  it('T-04 returns [] for a missing runsRoot, not an error', async () => {
    const out = await listRunSummaries(join(tmp, 'does-not-exist'));
    expect(out).toEqual([]);
  });

  it('T-07 never treats .proof.json or .visual-proof.json as run records', async () => {
    const runsRoot = await fixture(tmp);
    const dir = join(runsRoot, 'task-7');
    await write(join(dir, '2026-07-06T19-12-02-123Z.visual-proof.json'), JSON.stringify({ passed: true }));
    const out = await listRunSummaries(runsRoot);
    expect(out).toHaveLength(1);
    expect(out[0]!.stages).toEqual(['implement', 'review']);
  });

  it('T-08 skips a record file containing invalid JSON silently', async () => {
    const runsRoot = await fixture(tmp);
    const dir = join(runsRoot, 'task-7');
    await write(join(dir, '2026-07-06T19-12-02-123Z-broken.json'), '{ not valid json');
    const out = await listRunSummaries(runsRoot);
    expect(out).toHaveLength(1);
    expect(out[0]!.stages).toEqual(['implement', 'review']);
  });

  it('T-09 sorts summaries across multiple task dirs/timestamps by timestamp descending', async () => {
    const runsRoot = await fixture(tmp);
    const dir2 = join(runsRoot, 'task-8');
    await mkdir(dir2, { recursive: true });
    await write(
      join(dir2, '2026-08-01T00-00-00-000Z-implement.json'),
      JSON.stringify({
        taskId: 'task-8',
        completed: true,
        exitReason: 'completed',
        turns: 1,
        worktreePath: '/tmp/wt2',
        worktreePreserved: false,
        finalText: 'x',
        timestamp: '2026-08-01T00:00:00.000Z',
        stage: 'implement',
      }),
    );
    const out = await listRunSummaries(runsRoot);
    expect(out).toHaveLength(2);
    expect(out[0]!.timestamp).toBe('2026-08-01T00:00:00.000Z');
    expect(out[1]!.timestamp).toBe('2026-07-06T19:12:02.123Z');
  });
});

describe('readRunDetail', () => {
  it('T-02 returns 2 stages with diff + transcript attached, and proof details', async () => {
    const runsRoot = await fixture(tmp);
    const detail = await readRunDetail(runsRoot, 'task-7', '2026-07-06T19:12:02.123Z');
    expect(detail.stages).toHaveLength(2);
    const implement = detail.stages.find((s) => s.record.stage === 'implement');
    expect(implement?.diff).toBe('diff --git a b\n+x');
    expect(implement?.transcript).toBe('line1\nline2');
    expect(detail.proof?.passed).toBe(false);
    expect(detail.proof?.exitCode).toBe(1);
  });

  it('T-03 rejects ../task-7, a/b, and empty string as taskId before touching the filesystem', async () => {
    const runsRoot = await fixture(tmp);
    await expect(readRunDetail(runsRoot, '../task-7', 'x')).rejects.toBeInstanceOf(BadRequestError);
    await expect(readRunDetail(runsRoot, 'a/b', 'x')).rejects.toBeInstanceOf(BadRequestError);
    await expect(readRunDetail(runsRoot, '', 'x')).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('runsFingerprint', () => {
  it('T-05 is stable across calls, non-zero, and changes when a record is added', async () => {
    const runsRoot = await fixture(tmp);
    const a = await runsFingerprint(runsRoot);
    expect(a).not.toBe(0);
    const b = await runsFingerprint(runsRoot);
    expect(b).toBe(a);
    await write(
      join(runsRoot, 'task-7', '2026-07-06T20-00-00-000Z-implement.json'),
      JSON.stringify({
        taskId: 'task-7',
        completed: true,
        exitReason: 'completed',
        turns: 1,
        worktreePath: '/tmp/wt',
        worktreePreserved: false,
        finalText: 'x',
        timestamp: '2026-07-06T20:00:00.000Z',
        stage: 'implement',
      }),
    );
    const c = await runsFingerprint(runsRoot);
    expect(c).not.toBe(a);
  });
});

describe('readTextNoSymlink', () => {
  it('T-06 refuses to read a symlinked leaf', async () => {
    const real = join(tmp, 'real.diff');
    await writeFile(real, 'diff body');
    expect(await readTextNoSymlink(real)).toBe('diff body');

    const link = join(tmp, 'link.diff');
    await symlink(real, link);
    await expect(readTextNoSymlink(link)).rejects.toThrow();
  });
});
