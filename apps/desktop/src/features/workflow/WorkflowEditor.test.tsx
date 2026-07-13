import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor.js';
import * as ipc from '../../ipc.js';
import type { FlowDoc } from '../../ipc.js';

const DOC: FlowDoc = {
  name: 'my-flow',
  label: 'Mine',
  stages: [
    { name: 'planner', overrides: { model: 'opus' } },
    { name: 'ghost', overrides: {} }, // not in the palette and no ref — the fixable-warning case
  ],
  loops: [{ stages: ['planner', 'reviewer'], until: 'reviewer_pass', max: 3 }],
  meta: { owner: 'pawel' },
};

vi.mock('../../ipc.js', () => ({
  apiCapabilitiesCached: vi.fn(async () => ({
    providers: ['claude', 'codex'],
    flows: [{ name: 'plan', label: 'Plan' }],
    stages: ['planner', 'implementer', 'reviewer'],
    transports: ['github'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  })),
  apiListFlows: vi.fn(async () => ({
    flows: [
      { file: 'my-flow.hcl', name: 'my-flow', label: 'Mine' },
      { file: 'odd.hcl', name: 'odd', label: 'Odd', error: 'unknown stage "nope"' },
      { file: 'broken.hcl', error: 'expected exactly one flow block' },
    ],
  })),
  apiReadFlow: vi.fn(async () => ({ doc: DOC, source: 'RAW SOURCE' })),
  apiWriteFlow: vi.fn(async () => ({ source: 'CANONICAL' })),
}));

beforeEach(() => vi.clearAllMocks());

async function openMyFlow(): Promise<void> {
  render(<WorkflowEditor project="/repo" />);
  fireEvent.click(await screen.findByText('my-flow'));
  await screen.findByTestId('stage-block-0');
}

test('rail: openable entries are buttons, unparseable ones are disabled, invalid ones keep their badge', async () => {
  render(<WorkflowEditor project="/repo" />);
  expect((await screen.findByText('my-flow')).closest('button')).not.toBeDisabled();
  const odd = screen.getByText('odd').closest('button');
  expect(odd).not.toBeDisabled(); // parsed-but-invalid: openable, fixing it is the point
  expect(odd).toHaveAttribute('title', 'unknown stage "nope"');
  expect(screen.getByText('broken.hcl').closest('button')).toBeDisabled();
});

test('selecting a flow loads it: stages on the canvas, loop chip read-only, unknown stage warned', async () => {
  await openMyFlow();
  expect(vi.mocked(ipc.apiReadFlow)).toHaveBeenCalledWith('/repo', 'my-flow.hcl');
  expect(screen.getByText('ghost')).toBeInTheDocument();
  expect(screen.getByText(/not in library — pick a name or add a ref/)).toBeInTheDocument();
  expect(screen.getByText(/until reviewer_pass/)).toBeInTheDocument();
});

test('save sends the edited doc (meta + loops verbatim) and swaps the source tab to canonical HCL', async () => {
  await openMyFlow();
  // edit: select the planner, change its model
  fireEvent.click(screen.getByTestId('stage-block-0'));
  const model = screen.getByLabelText(/model/);
  fireEvent.change(model, { target: { value: 'sonnet' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() =>
    expect(vi.mocked(ipc.apiWriteFlow)).toHaveBeenCalledWith('/repo', 'my-flow.hcl', {
      ...DOC,
      stages: [{ name: 'planner', overrides: { model: 'sonnet' } }, DOC.stages[1]],
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: /source/i }));
  expect(await screen.findByText('CANONICAL')).toBeInTheDocument();
});

test('a rejected save keeps the edits + dirty flag and shows the message inline', async () => {
  vi.mocked(ipc.apiWriteFlow).mockRejectedValueOnce('flow "my-flow" is already declared in other.hcl');
  await openMyFlow();
  fireEvent.click(screen.getByTestId('stage-block-0'));
  fireEvent.change(screen.getByLabelText(/model/), { target: { value: 'sonnet' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  expect(await screen.findByText(/already declared in other\.hcl/)).toBeInTheDocument();
  expect(screen.getByText('unsaved')).toBeInTheDocument(); // dirty survived
  // the edit survived too: the canvas still shows the override
  expect(screen.getByText(/model=sonnet/)).toBeInTheDocument();
});

test('create flow: grammar + collision checks run in the form, including against BUILT-IN names', async () => {
  render(<WorkflowEditor project="/repo" />);
  await screen.findByText('my-flow');
  const input = screen.getByPlaceholderText('new-flow-name');
  const create = screen.getByRole('button', { name: /create flow/i });

  fireEvent.change(input, { target: { value: 'My Flow' } });
  expect(create).toBeDisabled();
  expect(screen.getByText(/lowercase/)).toBeInTheDocument();

  fireEvent.change(input, { target: { value: 'plan' } }); // built-in, absent from listFlows
  expect(create).toBeDisabled();
  expect(screen.getByText(/"plan" is taken/)).toBeInTheDocument();

  fireEvent.change(input, { target: { value: 'fresh' } });
  expect(create).not.toBeDisabled();
  fireEvent.click(create);
  expect(screen.getByText(/No stages yet/)).toBeInTheDocument();
  // zero stages ⇒ Save disabled (server rule mirrored in the UI)
  expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
});

test('adding a palette stage makes a new flow saveable', async () => {
  render(<WorkflowEditor project="/repo" />);
  await screen.findByText('my-flow');
  fireEvent.change(screen.getByPlaceholderText('new-flow-name'), { target: { value: 'fresh' } });
  fireEvent.click(screen.getByRole('button', { name: /create flow/i }));
  fireEvent.click(screen.getByRole('button', { name: /^implementer$/ }));
  expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() =>
    expect(vi.mocked(ipc.apiWriteFlow)).toHaveBeenCalledWith('/repo', 'fresh.hcl', {
      name: 'fresh',
      label: 'fresh',
      stages: [{ name: 'implementer', overrides: {} }],
      loops: [],
    }),
  );
});

test('listFlows failure shows the message but the screen stays usable', async () => {
  vi.mocked(ipc.apiListFlows).mockRejectedValueOnce('sidecar dead');
  render(<WorkflowEditor project="/repo" />);
  expect(await screen.findByText(/sidecar dead/)).toBeInTheDocument();
  expect(screen.getByPlaceholderText('new-flow-name')).toBeInTheDocument();
});
