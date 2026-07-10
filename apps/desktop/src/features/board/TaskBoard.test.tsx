import { describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TaskBoard } from './TaskBoard';
import type { Task } from '../../vanguard-output';

vi.mock('../../ipc', () => ({ listTasks: vi.fn() }));
import { listTasks } from '../../ipc';
const mockListTasks = vi.mocked(listTasks);

// A lane is the column container carrying `rounded-xl`; scope queries to it so a task asserted
// "in Running" really renders under Running, not just somewhere on the board.
function lane(label: string): HTMLElement {
  const el = screen.getByText(label).closest('[class*="rounded-xl"]');
  if (!el) throw new Error(`lane "${label}" not found`);
  return el as HTMLElement;
}

const TASKS: Task[] = [
  { id: 't-q1', title: 'Queued one', column: 'queued', state: 'Todo' },
  { id: 't-q2', title: 'Queued two', column: 'queued', state: 'Todo' },
  { id: 't-r1', title: 'Running one', column: 'running', state: 'In Progress' },
  { id: 't-v1', title: 'Verify one', column: 'verify-failed', state: 'changes-requested' },
  { id: 't-d1', title: 'Done one', column: 'done', state: 'done' },
];

describe('TaskBoard', () => {
  test('renders all six workflow columns', async () => {
    mockListTasks.mockResolvedValue([]);
    render(<TaskBoard project="/repo" onOpenTask={() => {}} />);
    for (const label of ['Queued', 'Claimed', 'Running', 'Verify failed', 'Review', 'Done']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  test('routes each task to its column lane (guards a col.key typo silently emptying a lane)', async () => {
    mockListTasks.mockResolvedValue(TASKS);
    render(<TaskBoard project="/repo" onOpenTask={() => {}} />);
    await screen.findByText('Queued one'); // wait for load

    expect(within(lane('Queued')).getByText('Queued one')).toBeInTheDocument();
    expect(within(lane('Queued')).getByText('Queued two')).toBeInTheDocument();
    expect(within(lane('Running')).getByText('Running one')).toBeInTheDocument();
    expect(within(lane('Verify failed')).getByText('Verify one')).toBeInTheDocument();
    expect(within(lane('Done')).getByText('Done one')).toBeInTheDocument();
  });

  test('shows per-column counts and a placeholder for empty lanes', async () => {
    mockListTasks.mockResolvedValue(TASKS);
    render(<TaskBoard project="/repo" onOpenTask={() => {}} />);
    await screen.findByText('Queued one');

    expect(within(lane('Queued')).getByText('2')).toBeInTheDocument();
    expect(within(lane('Claimed')).getByText('0')).toBeInTheDocument();
    expect(within(lane('Claimed')).getByText('No tasks')).toBeInTheDocument();
  });

  test('shows the raw backend state only when it differs from the lane key', async () => {
    mockListTasks.mockResolvedValue(TASKS);
    render(<TaskBoard project="/repo" onOpenTask={() => {}} />);
    await screen.findByText('Running one');

    // running task: state "In Progress" !== column "running" → shown
    expect(within(lane('Running')).getByText('In Progress')).toBeInTheDocument();
    // done task: state "done" === column "done" → the redundant state line is suppressed
    expect(within(lane('Done')).queryByText('done')).not.toBeInTheDocument();
  });

  test('renders the error branch when listTasks rejects', async () => {
    mockListTasks.mockRejectedValue('boom');
    render(<TaskBoard project="/repo" onOpenTask={() => {}} />);
    expect(await screen.findByText(/No task board/)).toBeInTheDocument();
  });
});
