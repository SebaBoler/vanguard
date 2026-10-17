import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { install } from '../../dev/mockBackend';
import { remoteRuns, runs } from '../../dev/fixtures';
import { RemoteRuns } from './RemoteRuns';

afterEach(() => clearMocks());

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
  );
});
