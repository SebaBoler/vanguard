import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunDetail } from './RunDetail';
import type { RunDetail as RunDetailT, StageDetail } from '../../vanguard-output';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => vi.unstubAllGlobals());

function stage(diffOmitted?: StageDetail['record']['diffOmitted'], diff?: string): StageDetail {
  return {
    record: {
      taskId: 'task-1', completed: true, exitReason: 'completed', turns: 1,
      worktreePath: '/tmp/wt', worktreePreserved: false, finalText: 'done',
      timestamp: '2026-07-06T19:12:02.000Z', diffOmitted,
    },
    diff,
  };
}

function showDiff(stages: StageDetail[]) {
  const detail: RunDetailT = { taskId: 'task-1', timestamp: stages[0].record.timestamp, stages };
  render(<RunDetail detail={detail} project="/repo" />);
  fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
}

test.each(['secret-blocked', 'secret-scan'] as const)('explains a diff withheld for %s', (reason) => {
  showDiff([stage(reason)]);
  expect(screen.getByText(`diff withheld: ${reason}`)).toBeInTheDocument();
  expect(screen.queryByText('No diff captured.')).not.toBeInTheDocument();
});

test('withheld stages hide stale diffs while normal stages still show their diff', () => {
  showDiff([stage('secret-blocked', '+sensitive stale diff'), stage(undefined, '+safe diff')]);
  expect(screen.queryByText('+sensitive stale diff')).not.toBeInTheDocument();
  expect(screen.getByText('+safe diff')).toBeInTheDocument();
});

test('shows the empty state when there is no diff or omission reason', () => {
  showDiff([stage()]);
  expect(screen.getByText('No diff captured.')).toBeInTheDocument();
});
