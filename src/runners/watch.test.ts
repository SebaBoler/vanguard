import { describe, it, expect } from 'vitest';
import { watchOnce } from './watch.js';
import type { WatchPrimitives } from './watch.js';

describe('watchOnce', () => {
  it('claims, runs, reviews each ready issue and categorizes the outcomes', async () => {
    const calls: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        calls.push(`claim:${id}`);
        if (id === 'D') throw new Error('already taken');
      },
      runOne: async (id) => {
        calls.push(`run:${id}`);
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? {} : { prUrl: `pr/${id}` };
      },
      review: async (id) => {
        calls.push(`review:${id}`);
      },
      onFailure: async (id) => {
        calls.push(`fail:${id}`);
      },
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['A']);
    expect(tick.noChange).toEqual(['B']);
    expect(tick.failed).toEqual(['C']);
    expect(tick.skipped).toEqual(['D']); // claim threw -> never run
    expect(calls).not.toContain('run:D');
    expect(calls.indexOf('claim:A')).toBeLessThan(calls.indexOf('run:A')); // claim precedes run
    expect(calls).toContain('review:A');
    expect(calls).not.toContain('review:B'); // no PR -> no review
    expect(calls).toContain('fail:C');
  });
});
