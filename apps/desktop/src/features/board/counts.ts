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

/**
 * The counts as rendered text, or null when the list is unknown (still loading, or the fetch
 * failed — `0` would not be honest there). A capped list is one page of a bigger repo (core stops
 * at `BOARD_FETCH_CAP`), so every count drawn from it is a lower bound: `12+`, not `12`.
 */
export function boardCountLabels(
  list: { tasks: readonly BoardTask[]; capped: boolean } | null | undefined,
): { [K in keyof BoardCounts]: string } | null {
  if (!list) return null;
  const counts = boardCounts(list.tasks);
  const label = (n: number): string => (list.capped ? `${n}+` : `${n}`);
  return { running: label(counts.running), waiting: label(counts.waiting) };
}
