import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { install } from '../../dev/mockBackend';
import { remoteImport, remoteRuns, runs } from '../../dev/fixtures';
import { RemoteRuns } from './RemoteRuns';

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  delete window.__VANGUARD_HUB__;
});

test('hub mode: Fetch records imports via fetch_remote_run and opens the record with its remoteRunId', async () => {
  window.__VANGUARD_HUB__ = true;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      calls.push(cmd);
      const result = cmd === 'list_remote_runs' ? remoteRuns : cmd === 'fetch_remote_run' ? remoteImport : null;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const onOpenRun = vi.fn();
  render(<RemoteRuns project="/repo" onOpenRun={onOpenRun} />);

  fireEvent.click(await screen.findByRole('button', { name: /fetch records/i }));
  for (const s of runs) expect(await screen.findByText(s.taskId)).toBeInTheDocument();
  expect(calls).toContain('fetch_remote_run');
  expect(calls).not.toContain('download_run_records'); // the Tauri-only command is never sent to the hub

  fireEvent.click(screen.getByText(runs[0].taskId));
  const uncached = remoteRuns.find((r) => !r.cached)!;
  expect(onOpenRun).toHaveBeenCalledWith(
    '/repo',
    expect.objectContaining({ taskId: runs[0].taskId, timestamp: runs[0].timestamp }),
    uncached.id,
  );
});

test('Fetch records pulls the artifact, expands the row, and opens a record in the inspector', async () => {
  install();
  const onOpenRun = vi.fn();
  render(<RemoteRuns project="/repo" onOpenRun={onOpenRun} />);

  // The fixture has one cached run (marker, "Open") and one not yet fetched ("Fetch").
  expect(await screen.findByText('cached')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open records/i })).toBeInTheDocument();
  expect(screen.queryByText(runs[0].taskId)).not.toBeInTheDocument(); // nothing expanded yet

  fireEvent.click(screen.getByRole('button', { name: /fetch records/i }));

  // Downloaded records expand under the run as a mini run list…
  for (const s of runs) expect(await screen.findByText(s.taskId)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /fetch records/i })).not.toBeInTheDocument();
  expect(screen.getAllByText('cached')).toHaveLength(2); // the fetched run is now marked too

  // …and a click routes into RunDetail with the cache dir standing in for the repo root.
  fireEvent.click(screen.getByText(runs[0].taskId));
  const uncached = remoteRuns.find((r) => !r.cached)!;
  expect(onOpenRun).toHaveBeenCalledWith(
    `/mock/config/remote-runs/org-my-app/${uncached.id}`,
    expect.objectContaining({ taskId: runs[0].taskId, timestamp: runs[0].timestamp }),
    undefined,
  );
});
