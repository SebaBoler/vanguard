import type { BoardTask } from '../../wire';

/** The two factory numbers both the board header and Fleet render — ONE rule, not two. */
export interface BoardCounts {
  /** Taken by the factory: the Claimed + Running lanes. */
  running: number;
  /** Waiting for it: tasks core flagged `waiting` (trigger-labelled and still queued). */
  waiting: number;
}

export function boardCounts(tasks: readonly BoardTask[] | null | undefined): BoardCounts {
  let running = 0;
  let waiting = 0;
  for (const t of tasks ?? []) {
    if (t.column === 'claimed' || t.column === 'running') running += 1;
    if (t.waiting === true) waiting += 1;
  }
  return { running, waiting };
}
