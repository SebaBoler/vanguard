import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor';
import { NavGuardContext, createNavGuardRegistry } from '../../navGuard';
import * as ipc from '../../ipc';

vi.mock('../../ipc.js', () => ({
  apiListFlows: vi.fn(async () => ({ flows: [{ file: 'a.hcl', name: 'a', label: 'A' }] })),
  apiReadFlow: vi.fn(async () => ({
    doc: { name: 'a', label: 'A', stages: [{ name: 'planner', overrides: {} }], loops: [] },
    source: 'flow "a" {}',
  })),
  apiWriteFlow: vi.fn(async () => ({ source: 'flow "a" {}' })),
  apiCapabilitiesCached: vi.fn(async () => ({
    providers: ['claude'],
    flows: [],
    stages: ['planner', 'implementer'],
    transports: ['github'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  })),
}));

// S8 / #339: while the editor is dirty, the App-level registry must be guarded — shell navigations
// (project switch, Rail click, window close) unmount this component, so the guard is the only
// protection. Clean editor ⇒ unguarded.
test('registers a nav guard while dirty and unregisters when clean', async () => {
  const registry = createNavGuardRegistry();
  render(
    <NavGuardContext.Provider value={registry}>
      <WorkflowEditor project="/repo" />
    </NavGuardContext.Provider>,
  );
  await screen.findByText('a'); // rail lists flow "a"
  expect(registry.guarded()).toBe(false);

  // create a fresh flow (dirty from birth), then add a palette stage so Save is enabled
  fireEvent.change(screen.getByPlaceholderText('new-flow-name'), { target: { value: 'fresh' } });
  fireEvent.click(screen.getByRole('button', { name: /create flow/i }));
  await waitFor(() => expect(registry.guarded()).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /^implementer$/ }));

  // guard proxies confirmDiscard: cancel blocks, accept passes
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(registry.confirm()).toBe(false);
  confirmSpy.mockReturnValue(true);
  expect(registry.confirm()).toBe(true);
  confirmSpy.mockRestore();

  // saving cleans the state → guard released
  vi.mocked(ipc.apiWriteFlow).mockResolvedValueOnce({ source: 'flow "fresh" {}' });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(registry.guarded()).toBe(false));
});
