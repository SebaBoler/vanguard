import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  apiListFlows: vi.fn(async () => ({ flows: [{ file: 'my-flow.hcl', name: 'my-flow', label: 'Mine' }] })),
  apiReadFlow: vi.fn(async () => ({
    doc: { name: 'my-flow', label: 'Mine', stages: [{ name: 'planner', overrides: {} }], loops: [] },
    source: 'flow "my-flow" {}',
  })),
  apiWriteFlow: vi.fn(async () => ({ source: 'flow "renamed" {}' })),
  apiDeleteFlow: vi.fn(async () => {}),
  apiCapabilitiesCached: vi.fn(async () => ({
    providers: ['claude'],
    flows: [{ name: 'plan', label: 'Plan' }],
    stages: ['planner', 'implementer'],
    transports: ['github'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('delete confirms, calls apiDeleteFlow, and resets an editor that had the flow open', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'open my-flow' }));
  await waitFor(() => expect(ipc.apiReadFlow).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('button', { name: 'delete my-flow' }));
  await waitFor(() => expect(ipc.apiDeleteFlow).toHaveBeenCalledWith('/repo', 'my-flow.hcl'));
  // editor reset: the open-file chip is gone
  await waitFor(() => expect(screen.queryByText('.vanguard/flows/my-flow.hcl')).not.toBeInTheDocument());
  confirmSpy.mockRestore();
});

test('delete cancelled at the confirm never calls the API', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<WorkflowEditor project="/repo" />);
  await screen.findByRole('button', { name: 'delete my-flow' });
  fireEvent.click(screen.getByRole('button', { name: 'delete my-flow' }));
  expect(ipc.apiDeleteFlow).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test('rename composes write-BEFORE-delete with the on-disk doc and the new name', async () => {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));

  await waitFor(() =>
    expect(ipc.apiWriteFlow).toHaveBeenCalledWith('/repo', 'renamed.hcl', {
      name: 'renamed',
      label: 'Mine',
      stages: [{ name: 'planner', overrides: {} }],
      loops: [],
    }),
  );
  await waitFor(() => expect(ipc.apiDeleteFlow).toHaveBeenCalledWith('/repo', 'my-flow.hcl'));
  // order pinned: the write happened before the delete
  const writeOrder = vi.mocked(ipc.apiWriteFlow).mock.invocationCallOrder[0]!;
  const deleteOrder = vi.mocked(ipc.apiDeleteFlow).mock.invocationCallOrder[0]!;
  expect(writeOrder).toBeLessThan(deleteOrder);
});

test('a failed WRITE leaves the old flow untouched (no delete, error surfaced)', async () => {
  vi.mocked(ipc.apiWriteFlow).mockRejectedValueOnce(new Error('flow "renamed" is already declared in other.hcl'));
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(screen.getByText(/already declared/)).toBeInTheDocument());
  expect(ipc.apiDeleteFlow).not.toHaveBeenCalled();
});

test('a failed DELETE after a successful write says both files exist (never lossy)', async () => {
  vi.mocked(ipc.apiDeleteFlow).mockRejectedValueOnce(new Error('EACCES'));
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(screen.getByText(/both files exist/)).toBeInTheDocument());
  expect(ipc.apiWriteFlow).toHaveBeenCalled();
});

test('renaming the OPEN dirty flow is refused — save or discard first', async () => {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'open my-flow' }));
  await waitFor(() => expect(ipc.apiReadFlow).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /^implementer$/ })); // dirty it
  fireEvent.click(screen.getByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(screen.getByText(/save or discard/)).toBeInTheDocument());
  expect(ipc.apiWriteFlow).not.toHaveBeenCalled();
});

test('rename target validates against taken names, excluding the renamed file itself', async () => {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  const input = screen.getByLabelText('rename my-flow');
  fireEvent.change(input, { target: { value: 'plan' } }); // built-in
  expect(screen.getByText(/"plan" is taken/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'confirm rename' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'my-flow' } }); // itself — excluded from the set, but a no-op rename
  expect(screen.getByRole('button', { name: 'confirm rename' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'fresh' } });
  expect(screen.getByRole('button', { name: 'confirm rename' })).not.toBeDisabled();
});

// #345 r2 BLOCKING: a file whose basename differs from its declared name (hand-authored y.hcl
// containing name = "x") renamed TO its own basename wrote y.hcl then deleted y.hcl — flow gone.
// Same-path rename is legitimate (aligning name with basename): write, and skip the delete.
test('renaming a flow to its own file basename never deletes the file it just wrote', async () => {
  // Once-scoped: mockResolvedValue would outlive clearAllMocks (which clears calls, not impls)
  // and bleed x/y.hcl into later tests.
  vi.mocked(ipc.apiListFlows).mockResolvedValueOnce({ flows: [{ file: 'y.hcl', name: 'x', label: 'X' }] });
  vi.mocked(ipc.apiReadFlow).mockResolvedValueOnce({
    doc: { name: 'x', label: 'X', stages: [{ name: 'planner', overrides: {} }], loops: [] },
    source: 'flow "x" {}',
  });
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename x' }));
  fireEvent.change(screen.getByLabelText('rename x'), { target: { value: 'y' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(ipc.apiWriteFlow).toHaveBeenCalledWith('/repo', 'y.hcl', expect.objectContaining({ name: 'y' })));
  expect(ipc.apiDeleteFlow).not.toHaveBeenCalled();
});

test('a double-click on confirm rename fires ONE write→delete sequence (in-flight guard)', async () => {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  const confirm = screen.getByRole('button', { name: 'confirm rename' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(ipc.apiDeleteFlow).toHaveBeenCalled());
  expect(vi.mocked(ipc.apiWriteFlow)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(ipc.apiDeleteFlow)).toHaveBeenCalledTimes(1);
});

// #345 r3 BLOCKING: renameFlow set opBusy and never cleared it — the FIRST rename (success or
// failure) latched the lock forever; every later rename/delete silently no-op'd until remount.
test('a second, independent rename after the first resolves still works (opBusy released)', async () => {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(ipc.apiDeleteFlow).toHaveBeenCalledTimes(1));

  // the list still shows my-flow (mock is static) — rename again
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'again' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(vi.mocked(ipc.apiWriteFlow)).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(vi.mocked(ipc.apiDeleteFlow)).toHaveBeenCalledTimes(2));
});

test('a FAILED rename releases the lock — delete afterwards still works', async () => {
  vi.mocked(ipc.apiWriteFlow).mockRejectedValueOnce(new Error('flow "renamed" is already declared in other.hcl'));
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'rename my-flow' }));
  fireEvent.change(screen.getByLabelText('rename my-flow'), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'confirm rename' }));
  await waitFor(() => expect(screen.getByText(/already declared/)).toBeInTheDocument());

  // the rename input stays open for retry — cancel it, then the delete affordance is back
  fireEvent.click(screen.getByRole('button', { name: 'cancel rename' }));
  fireEvent.click(screen.getByRole('button', { name: 'delete my-flow' }));
  await waitFor(() => expect(ipc.apiDeleteFlow).toHaveBeenCalledWith('/repo', 'my-flow.hcl'));
  confirmSpy.mockRestore();
});
