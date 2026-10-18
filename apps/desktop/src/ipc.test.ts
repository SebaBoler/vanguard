import { test, expect, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { apiCapabilitiesCached, apiListFlows, apiReadFlow, apiWriteFlow, browseDirs, importRemoteRun, listRuns, readRun } from './ipc';
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

test('readRun forwards repoPath and the ref flattened into taskId, timestamp and source', async () => {
  const captured: Record<string, unknown> = {};
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return { taskId: 't', timestamp: 'ts', stages: [] };
  });
  await readRun('/repo', { source: { kind: 'local' }, taskId: 't', timestamp: 'ts' });
  expect(captured.cmd).toBe('read_run');
  expect(captured.args).toMatchObject({ repoPath: '/repo', taskId: 't', timestamp: 'ts', source: { kind: 'local' } });

  await readRun('/repo', { source: { kind: 'ci', runId: 42 }, taskId: 't', timestamp: 'ts' });
  expect(captured.args).toMatchObject({ repoPath: '/repo', source: { kind: 'ci', runId: 42 } });
});

test('flow-file wrappers forward camelCase args to their commands (S5)', async () => {
  const calls: { cmd: unknown; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'api_list_flows') return { flows: [] };
    if (cmd === 'api_read_flow') return { doc: { name: 'f', label: 'L', stages: [], loops: [] }, source: 's' };
    return { source: 's' };
  });
  const doc = { name: 'my-flow', label: 'Mine', stages: [{ name: 'planner', overrides: {} }], loops: [] };
  await apiListFlows('/repo');
  await apiReadFlow('/repo', 'my-flow.hcl');
  await apiWriteFlow('/repo', 'my-flow.hcl', doc);
  expect(calls[0]).toMatchObject({ cmd: 'api_list_flows', args: { repoPath: '/repo' } });
  expect(calls[1]).toMatchObject({ cmd: 'api_read_flow', args: { repoPath: '/repo', file: 'my-flow.hcl' } });
  expect(calls[2]).toMatchObject({ cmd: 'api_write_flow', args: { repoPath: '/repo', file: 'my-flow.hcl', doc } });
});

test('T-95 browseDirs and importRemoteRun call the right command names with camelCase args', async () => {
  const calls: { cmd: unknown; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'browse_dirs') return { path: '/repo', entries: [] };
    return { runId: 42, taskIds: [], runs: [], cachedAt: 'now' };
  });
  await browseDirs('/repo/sub');
  await importRemoteRun('/repo', 42);
  expect(calls[0]).toMatchObject({ cmd: 'browse_dirs', args: { path: '/repo/sub' } });
  expect(calls[1]).toMatchObject({ cmd: 'import_remote_run', args: { repoPath: '/repo', runId: 42 } });
});

test('apiCapabilitiesCached does not pin a rejected promise — a transient failure recovers on the next call', async () => {
  let fail = true;
  mockIPC((cmd) => {
    if (cmd !== 'api_capabilities') return undefined;
    if (fail) throw new Error('sidecar briefly unavailable');
    return { providers: ['claude'], flows: [], stages: [], transports: [], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } };
  });
  await expect(apiCapabilitiesCached()).rejects.toThrow(/briefly unavailable/);
  fail = false;
  await expect(apiCapabilitiesCached()).resolves.toMatchObject({ providers: ['claude'] }); // NOT the pinned rejection
});
