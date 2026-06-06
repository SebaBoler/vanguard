import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistRunRecord } from './run-record.js';
import type { RunResult } from './types.js';

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
    const file = await persistRunRecord(repo, result, { timestamp: '2026-06-06T10:00:00.000Z', prUrl: 'https://pr/1' });
    expect(file).toBe(join(repo, '.vanguard', 'runs', 'TES-1', '2026-06-06T10-00-00-000Z.json'));

    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.taskId).toBe('TES-1');
    expect(record.costUsd).toBe(0.05);
    expect(record.prUrl).toBe('https://pr/1');
    expect(record.diff).toBeUndefined(); // diff omitted

    const metrics = await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({ evt: 'run_complete', taskId: 'TES-1', exitReason: 'completed', costUsd: 0.05, inputTokens: 100 });
  });

  it('writes a sibling transcript.log and keeps the transcript out of the JSON', async () => {
    const file = await persistRunRecord(
      repo,
      { ...result, transcript: '{"type":"result"}\n' },
      { timestamp: '2026-06-06T10:00:00.000Z' },
    );
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.transcript).toBeUndefined();
    const log = await readFile(file.replace(/\.json$/, '.transcript.log'), 'utf8');
    expect(log).toBe('{"type":"result"}\n');
  });

  it('labels a stage in the filename and appends one metric line per call', async () => {
    await persistRunRecord(repo, result, { timestamp: '2026-06-06T10:00:00.000Z', label: 'implementer' });
    const file = await persistRunRecord(repo, result, { timestamp: '2026-06-06T10:01:00.000Z', label: 'reviewer' });
    expect(file.endsWith('2026-06-06T10-01-00-000Z-reviewer.json')).toBe(true);

    const metrics = (await readFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(metrics).toHaveLength(2);
    expect(JSON.parse(metrics[0]!).stage).toBe('implementer');
    expect(JSON.parse(metrics[1]!).stage).toBe('reviewer');
  });
});
