import { describe, it, expect } from 'vitest';
import { fanOut } from './fan-out.js';

describe('fanOut', () => {
  it('runs every item and returns fulfilled values in input order', async () => {
    const out = await fanOut([1, 2, 3], async (n) => n * 2);
    expect(out).toEqual([
      { item: 1, status: 'fulfilled', value: 2 },
      { item: 2, status: 'fulfilled', value: 4 },
      { item: 3, status: 'fulfilled', value: 6 },
    ]);
  });

  it('isolates a failing item without aborting the rest', async () => {
    const out = await fanOut([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out.map((o) => o.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const failed = out[1];
    expect(failed?.status === 'rejected' && (failed.reason as Error).message).toBe('boom');
  });

  it('runs one at a time when concurrency is 1', async () => {
    const log: string[] = [];
    await fanOut(
      [1, 2],
      async (n) => {
        log.push(`start-${n}`);
        await Promise.resolve();
        log.push(`end-${n}`);
        return n;
      },
      { concurrency: 1 },
    );
    expect(log).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('interleaves when concurrency allows', async () => {
    const log: string[] = [];
    await fanOut(
      [1, 2],
      async (n) => {
        log.push(`start-${n}`);
        await Promise.resolve();
        log.push(`end-${n}`);
        return n;
      },
      { concurrency: 2 },
    );
    expect(log).toEqual(['start-1', 'start-2', 'end-1', 'end-2']);
  });

  it('falls back to the default concurrency on a non-finite value (no hang)', async () => {
    const out = await fanOut([1, 2, 3], async (n) => n, { concurrency: Number.NaN });
    expect(out.map((o) => o.status === 'fulfilled' && o.value)).toEqual([1, 2, 3]);
  });
});
