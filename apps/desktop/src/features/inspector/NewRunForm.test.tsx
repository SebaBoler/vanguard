import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { flowOptionsFrom, NewRunForm } from './NewRunForm';
import * as ipc from '../../ipc';
import type { Capabilities } from '../../ipc';

vi.mock('../../ipc.js', () => ({
  apiListFlows: vi.fn(async () => ({ flows: [] })),
}));

const caps: Capabilities = {
  providers: ['claude', 'codex'],
  flows: [
    { name: 'default', label: 'Default' },
    { name: 'plan', label: 'Plan' },
  ],
  stages: ['planner', 'implementer'],
  transports: ['github', 'gitlab', 'linear'],
  defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
};

test('Run is disabled until issueRef is non-blank', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  expect(run).not.toBeDisabled();
});

test('Run is disabled when maxTurns is not a positive integer', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).not.toBeDisabled();
  fireEvent.click(screen.getByText('Advanced')); // maxTurns lives in the collapsed Advanced panel
  fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '0' } });
  expect(run).toBeDisabled();
});

test('Run calls onRun with repoPath=project and defaulted fields', async () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  expect(onRun).toHaveBeenCalledWith(
    expect.objectContaining({
      issueRef: '322',
      repoPath: '/repo',
      provider: 'claude',
      transport: 'github',
      flow: 'default',
      maxTurns: 30,
      baseBranch: 'main',
    }),
  );
});

test('flowOptionsFrom merges built-ins with healthy repo flows and never offers errored entries (S5)', () => {
  const merged = flowOptionsFrom(caps, [
    { file: 'my-flow.hcl', name: 'my-flow', label: 'Mine' },
    { file: 'odd.hcl', name: 'odd', label: 'Odd', error: 'unknown stage' }, // invalid: excluded
    { file: 'broken.hcl', error: 'parse error' }, // unparseable: excluded
  ]);
  expect(merged).toEqual([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
    { value: 'my-flow', label: 'Mine' },
  ]);
  // degraded ('error') and not-yet-loaded (null) both fall back to built-ins only
  expect(flowOptionsFrom(caps, 'error').map((o) => o.value)).toEqual(['default', 'plan']);
  expect(flowOptionsFrom(caps, null).map((o) => o.value)).toEqual(['default', 'plan']);
});

test('the form fetches repo flows fresh for its project on open (S5)', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalledWith('/repo'));
});

test('listFlows failure degrades to built-ins with a notice — the form never disappears', async () => {
  vi.mocked(ipc.apiListFlows).mockRejectedValueOnce('sidecar dead');
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  expect(await screen.findByText(/repo flows unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
});

test('flowOptionsFrom drops a built-in-colliding repo entry even if it slipped past the error flag', () => {
  const merged = flowOptionsFrom(caps, [{ file: 'plan.hcl', name: 'plan', label: 'Shadow' }]);
  expect(merged.filter((o) => o.value === 'plan')).toEqual([{ value: 'plan', label: 'Plan' }]); // built-in wins, once
});
