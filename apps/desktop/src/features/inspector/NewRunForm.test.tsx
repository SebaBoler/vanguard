import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewRunForm } from './NewRunForm';
import type { Capabilities } from '../../ipc';

const caps: Capabilities = {
  providers: ['claude', 'codex'],
  flows: [
    { name: 'default', label: 'Default' },
    { name: 'plan', label: 'Plan' },
  ],
  transports: ['github', 'gitlab', 'linear'],
  defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
};

test('Run is disabled until issueRef is non-blank', () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  expect(run).not.toBeDisabled();
});

test('Run is disabled when maxTurns is not a positive integer', () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).not.toBeDisabled();
  fireEvent.click(screen.getByText('Advanced')); // maxTurns lives in the collapsed Advanced panel
  fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '0' } });
  expect(run).toBeDisabled();
});

test('Run calls onRun with repoPath=project and defaulted fields', () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
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
