import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { persistRunRecord, persistVerification, persistVisualProof } from './run-record.js';
import type { RunResult } from './types.js';

const TS = '2026-06-06T10:00:00.000Z';

async function withWorktree(fn: (wt: string) => Promise<void>): Promise<void> {
  const wt = await mkdtemp(join(tmpdir(), 'vg-wt-'));
  try {
    await fn(wt);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-runrec-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const result: RunResult = {
  taskId: 'TES-1',
  completed: true,
  exitReason: 'completed',
  turns: 3,
  worktreePath: '/wt',
  worktreePreserved: false,
  diff: 'HUGE DIFF '.repeat(1000),
  finalText: 'done',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
  costUsd: 0.05,
  cacheEfficiency: 0.8,
};

describe('persistRunRecord', () => {
  it('writes a per-run JSON (without the diff) and appends a metric line', async () => {
    const file = await persistRunRecord(repo, result, { timestamp: TS, prUrl: 'https://pr/1' });
    expect(file).toBe(join(repo, '.vanguard', 'runs', 'TES-1', '2026-06-06T10-00-00-000Z.json'));

    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.taskId).toBe('TES-1');
    expect(record.costUsd).toBe(0.05);
    expect(record.prUrl).toBe('https://pr/1');
    expect(record.diff).toBeUndefined(); // diff excluded from JSON

    const diffFile = await readFile(file.replace(/\.json$/, '.diff'), 'utf8');
    expect(diffFile).toBe(result.diff);

    const metrics = await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({ evt: 'run_complete', taskId: 'TES-1', exitReason: 'completed', costUsd: 0.05, inputTokens: 100 });
  });

  it('writes a sibling transcript.log and keeps the transcript out of the JSON', async () => {
    const file = await persistRunRecord(
      repo,
      { ...result, transcript: '{"type":"result"}\n' },
      { timestamp: TS },
    );
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.transcript).toBeUndefined();
    const log = await readFile(file.replace(/\.json$/, '.transcript.log'), 'utf8');
    expect(log).toBe('{"type":"result"}\n');
  });

  it('writes a git bundle when worktreePath has a commit', () =>
    withWorktree(async (wt) => {
      await execa('git', ['init', '-b', 'main'], { cwd: wt });
      await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: wt });
      const file = await persistRunRecord(repo, { ...result, worktreePath: wt }, { timestamp: TS });
      await expect(access(file.replace(/\.json$/, '.bundle'))).resolves.toBeUndefined();
    }),
  );

  it('does not write a bundle and does not throw when worktreePath has no commits', () =>
    withWorktree(async (wt) => {
      await execa('git', ['init', '-b', 'main'], { cwd: wt });
      const file = await persistRunRecord(repo, { ...result, worktreePath: wt }, { timestamp: TS });
      await expect(access(file.replace(/\.json$/, '.bundle'))).rejects.toThrow();
    }),
  );

  it('persistVerification writes proof.json and metric line', async () => {
    const verResult = {
      command: 'pnpm test',
      exitCode: 0,
      passed: true,
      sha256: 'deadbeef'.repeat(8),
      outputTail: 'all good',
    };
    const file = await persistVerification(repo, 'TES-1', verResult, { timestamp: TS });
    expect(file).toBe(join(repo, '.vanguard', 'runs', 'TES-1', '2026-06-06T10-00-00-000Z.proof.json'));

    const proof = JSON.parse(await readFile(file, 'utf8'));
    expect(proof.command).toBe('pnpm test');
    expect(proof.passed).toBe(true);
    expect(proof.sha256).toBe(verResult.sha256);

    const metrics = await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({
      evt: 'verify',
      ts: TS,
      taskId: 'TES-1',
      passed: true,
      exitCode: 0,
      sha256: verResult.sha256,
    });
  });

  it('persistVisualProof writes visual-proof.json with artifacts and a metric line', async () => {
    const vpResult = {
      command: 'pnpm visual-proof',
      exitCode: 0,
      passed: true,
      sha256: 'cafebabe'.repeat(8),
      outputTail: 'screenshots captured',
      artifacts: [
        { path: '/workspace/.vanguard/visual-proof/home.png', sha256: 'aa'.repeat(32), bytes: 1024 },
        { path: '/workspace/.vanguard/visual-proof/about.png', sha256: 'bb'.repeat(32), bytes: 2048 },
      ],
    };
    const file = await persistVisualProof(repo, 'TES-1', vpResult, { timestamp: TS });
    expect(file).toBe(join(repo, '.vanguard', 'runs', 'TES-1', '2026-06-06T10-00-00-000Z.visual-proof.json'));

    const proof = JSON.parse(await readFile(file, 'utf8'));
    expect(proof.command).toBe('pnpm visual-proof');
    expect(proof.passed).toBe(true);
    expect(proof.sha256).toBe(vpResult.sha256);
    expect(proof.artifacts).toHaveLength(2);
    expect(proof.artifacts[0]).toEqual(vpResult.artifacts[0]);
    expect(proof.artifacts[1]).toEqual(vpResult.artifacts[1]);

    const metrics = await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({
      evt: 'visual_proof',
      ts: TS,
      taskId: 'TES-1',
      passed: true,
      exitCode: 0,
      sha256: vpResult.sha256,
      artifacts: 2,
    });
  });

  it('persistVisualProof records an artifacts count of 0 when there are no artifacts', async () => {
    const vpResult = {
      command: 'pnpm visual-proof',
      exitCode: 1,
      passed: false,
      sha256: 'deadbeef'.repeat(8),
      outputTail: 'no screenshots',
      artifacts: [],
    };
    await persistVisualProof(repo, 'TES-2', vpResult, { timestamp: TS });
    const metrics = await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({ evt: 'visual_proof', taskId: 'TES-2', passed: false, exitCode: 1, artifacts: 0 });
  });

  it('labels a stage in the filename and appends one metric line per call', async () => {
    await persistRunRecord(repo, result, { timestamp: TS, label: 'implementer' });
    const file = await persistRunRecord(repo, result, { timestamp: '2026-06-06T10:01:00.000Z', label: 'reviewer' });
    expect(file.endsWith('2026-06-06T10-01-00-000Z-reviewer.json')).toBe(true);

    const metrics = (await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(metrics).toHaveLength(2);
    expect(JSON.parse(metrics[0]!).stage).toBe('implementer');
    expect(JSON.parse(metrics[1]!).stage).toBe('reviewer');
  });
});
