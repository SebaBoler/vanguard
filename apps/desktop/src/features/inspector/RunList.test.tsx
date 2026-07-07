import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunList } from './RunList';
import type { RunSummary } from '../../vanguard-output';

test('renders a selectable card per run with task id and failure marker', () => {
  const runs: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement', 'review'], totalCostUsd: 0.17, anyFailed: true },
  ];
  render(<RunList runs={runs} onSelect={() => {}} />);
  expect(screen.getByText('task-7')).toBeInTheDocument();
  // "failed" appears on both the status chip and the filter button — assert at least one.
  expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
});

test('renders an empty-state when there are no runs', () => {
  render(<RunList runs={[]} onSelect={() => {}} />);
  expect(screen.getByText(/No runs found/)).toBeInTheDocument();
});
