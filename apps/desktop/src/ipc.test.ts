import { test, expect, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { listRuns, readRun } from './ipc';
import type { RunSummary } from './vanguard-output';

afterEach(() => clearMocks());

test('listRuns forwards camelCase repoPath and returns typed summaries', async () => {
  const captured: Record<string, unknown> = {};
  const sample: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.12, anyFailed: false },
  ];
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return sample;
  });
  const out = await listRuns('/repo');
  expect(captured.cmd).toBe('list_runs');
  expect((captured.args as { repoPath: string }).repoPath).toBe('/repo');
  expect(out[0].taskId).toBe('task-7');
});

test('readRun forwards repoPath, taskId and timestamp', async () => {
  const captured: Record<string, unknown> = {};
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return { taskId: 't', timestamp: 'ts', stages: [] };
  });
  await readRun('/repo', 't', 'ts');
  expect(captured.cmd).toBe('read_run');
  expect(captured.args).toMatchObject({ repoPath: '/repo', taskId: 't', timestamp: 'ts' });
});
