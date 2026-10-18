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

test('Fetch records imports the artifact, expands the row, and opens a record by its CI source', async () => {
  install();
  const onOpenRun = vi.fn();
  render(<RemoteRuns project="/repo" onOpenRun={onOpenRun} />);

  // The fixture has one cached run (marker, "Open") and one not yet fetched ("Fetch").
  expect(await screen.findByText('cached')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open records/i })).toBeInTheDocument();
  expect(screen.queryByText(runs[0].taskId)).not.toBeInTheDocument(); // nothing expanded yet

  fireEvent.click(screen.getByRole('button', { name: /fetch records/i }));

  // Imported records expand under the run as a mini run list…
  for (const s of runs) expect(await screen.findByText(s.taskId)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /fetch records/i })).not.toBeInTheDocument();
  expect(screen.getAllByText('cached')).toHaveLength(2); // the imported run is now marked too

  // …and a click routes into RunDetail naming the CI run, never a root.
  fireEvent.click(screen.getByText(runs[0].taskId));
  const uncached = remoteRuns.find((r) => !r.cached)!;
  expect(onOpenRun).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: runs[0].taskId, timestamp: runs[0].timestamp }),
    { kind: 'ci', runId: uncached.id },
  );
});

test('hub mode: the same screen imports via import_remote_run and opens the record by its CI source', async () => {
  window.__VANGUARD_HUB__ = true;
  const uncached = remoteRuns.find((r) => !r.cached)!;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      calls.push(cmd);
      const result =
        cmd === 'list_remote_runs'
          ? remoteRuns
          : cmd === 'import_remote_run'
            ? { ...remoteImport, runId: uncached.id }
            : null;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const onOpenRun = vi.fn();
  render(<RemoteRuns project="/repo" onOpenRun={onOpenRun} />);

  expect(await screen.findByText('cached')).toBeInTheDocument(); // the fixture's already-cached run
  fireEvent.click(await screen.findByRole('button', { name: /fetch records/i }));
  for (const s of runs) expect(await screen.findByText(s.taskId)).toBeInTheDocument();
  expect(calls).toContain('import_remote_run'); // one command name on both backends
  expect(screen.getAllByText('cached')).toHaveLength(2);

  fireEvent.click(screen.getByText(runs[0].taskId));
  expect(onOpenRun).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: runs[0].taskId, timestamp: runs[0].timestamp }),
    { kind: 'ci', runId: uncached.id },
  );
});
