import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunList } from './RunList';
import type { ActiveRun, RunSummary } from '../../vanguard-output';

const noop = (): void => {};

test('renders a selectable row per run with task id and failure marker', () => {
  const runs: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement', 'review'], totalCostUsd: 0.17, anyFailed: true },
  ];
  render(<RunList runs={runs} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('task-7')).toBeInTheDocument();
  // "failed" appears on both the status chip and the filter button — assert at least one.
  expect(screen.getAllByText('failed').length).toBeGreaterThan(0);
});

test('renders in-flight runs as a running row', () => {
  const active: ActiveRun[] = [{ taskId: 'task-live', sessionFile: '/x.jsonl', lastActivityMs: Date.now() }];
  render(<RunList runs={[]} active={active} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText('task-live')).toBeInTheDocument();
  expect(screen.getByText('running')).toBeInTheDocument();
});

test('renders an empty-state only when there are no runs and nothing in-flight', () => {
  render(<RunList runs={[]} active={[]} onSelect={noop} onOpenActive={noop} />);
  expect(screen.getByText(/No runs found/)).toBeInTheDocument();
});
