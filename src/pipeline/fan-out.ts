export type FanOutOutcome<I, T> =
  | { item: I; status: 'fulfilled'; value: T }
  | { item: I; status: 'rejected'; reason: unknown };

export interface FanOutOptions {
  /** Maximum items run at once. Default 2 (each run is heavy — its own sandbox). */
  concurrency?: number;
}

/**
 * Run an independent task for each item with bounded concurrency, isolating failures: one item
 * throwing does not abort the others. Returns a settled outcome per item, in input order. Useful for
 * fanning a parent issue's sub-tasks out into one run (and PR) each.
 *
 * Uses a worker pool (not fixed batches): each of `concurrency` workers pulls the next item as soon
 * as it finishes, so a slow item never idles the other slots — runs here are heavy and uneven.
 */
export async function fanOut<I, T>(
  items: I[],
  runOne: (item: I) => Promise<T>,
  opts: FanOutOptions = {},
): Promise<FanOutOutcome<I, T>[]> {
  const concurrency = Number.isFinite(opts.concurrency) ? Math.max(1, Math.floor(opts.concurrency as number)) : 2;
  const outcomes: FanOutOutcome<I, T>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as I;
      try {
        outcomes[index] = { item, status: 'fulfilled', value: await runOne(item) };
      } catch (reason) {
        outcomes[index] = { item, status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return outcomes;
}
