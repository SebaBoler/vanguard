import { describe, expect, it } from 'vitest';
import { boardCountLabels, boardCounts } from './counts';
import type { BoardTask } from '../../wire';

function task(column: BoardTask['column'], waiting?: boolean): BoardTask {
  return { id: 'x', title: 't', column, state: '', ...(waiting ? { waiting: true } : {}) };
}

describe('boardCounts', () => {
  it('counts claimed + running as running, and waiting-flagged tasks independently', () => {
    const tasks: BoardTask[] = [
      task('claimed'),
      task('running'),
      task('queued', true),
      task('queued', true),
      task('verify-failed'),
      task('review'),
      task('done'),
    ];
    expect(boardCounts(tasks)).toEqual({ running: 2, waiting: 2 });
    expect(boardCounts([task('running', true)])).toEqual({ running: 1, waiting: 1 });
  });

  it('empty/undefined input yields zero counts', () => {
    expect(boardCounts(undefined)).toEqual({ running: 0, waiting: 0 });
    expect(boardCounts(null)).toEqual({ running: 0, waiting: 0 });
    expect(boardCounts([])).toEqual({ running: 0, waiting: 0 });
  });
});

describe('boardCountLabels', () => {
  const tasks: BoardTask[] = [task('running'), task('queued', true), task('queued', true)];

  it('an uncapped list is exact; a capped one is a lower bound', () => {
    expect(boardCountLabels({ tasks, capped: false })).toEqual({ running: '1', waiting: '2' });
    expect(boardCountLabels({ tasks, capped: true })).toEqual({ running: '1+', waiting: '2+' });
    expect(boardCountLabels({ tasks: [], capped: false })).toEqual({ running: '0', waiting: '0' });
  });

  it('an unknown list has no labels at all — never `0`', () => {
    expect(boardCountLabels(null)).toBeNull();
    expect(boardCountLabels(undefined)).toBeNull();
  });
});
