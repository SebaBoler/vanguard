import { describe, it, expect } from 'vitest';
import { watchOnce, githubProjectWatchPrimitives } from './watch.js';
import type { WatchPrimitives } from './watch.js';
import type { GhRunner } from '../tasks/github.js';

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

describe('githubProjectWatchPrimitives', () => {
  const ITEM_LIST = JSON.stringify({
    items: [
      // trigger status + matching label -> ready
      { id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 1, repository: 'owner/repo', labels: ['vanguard'] } },
      // wrong status -> not ready
      { id: 'PVTI_2', status: 'In Progress', content: { type: 'Issue', number: 2, repository: 'owner/repo', labels: ['vanguard'] } },
      // trigger status but missing label -> not ready
      { id: 'PVTI_3', status: 'Todo', content: { type: 'Issue', number: 3, repository: 'owner/repo', labels: [] } },
      // trigger status, no label filter configured -> ready (tested below without label opt)
      { id: 'PVTI_4', status: 'Todo', content: { type: 'Issue', number: 4, repository: 'owner/repo', labels: [] } },
    ],
  });
  const PROJECT_VIEW = JSON.stringify({ id: 'PVT_project1' });
  const FIELD_LIST = JSON.stringify({
    fields: [
      {
        id: 'PVTSSF_status',
        name: 'Status',
        options: [
          { id: 'opt_todo', name: 'Todo' },
          { id: 'opt_inprogress', name: 'In Progress' },
          { id: 'opt_inreview', name: 'In Review' },
        ],
      },
    ],
  });

  function makeFakeGh(ghCalls: string[][]): GhRunner {
    return async (args: string[]): Promise<string> => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return ITEM_LIST;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-edit') return '';
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      return '';
    };
  }

  it('listReady filters by trigger status and label', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready).toEqual([{ id: 'owner/repo#1' }]);
    expect(ghCalls.some((a) => a.includes('item-list'))).toBe(true);
  });

  it('listReady returns all trigger-status items when no label filter', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready.map((r) => r.id)).toEqual(['owner/repo#1', 'owner/repo#3', 'owner/repo#4']);
  });

  it('watchOnce wiring: claims ready items and calls item-edit for claim and review', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    // Stub runOne: only listReady -> claim -> run -> review wiring is tested here.
    const stubbedPrimitives = {
      ...primitives,
      runOne: async (_id: string) => ({ prUrl: 'https://github.com/owner/repo/pull/99' }),
    };

    const tick = await watchOnce(stubbedPrimitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['owner/repo#1']);
    expect(tick.failed).toEqual([]);
    expect(tick.skipped).toEqual([]);

    // claim sets status to "In Progress" (opt_inprogress)
    const claimCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inprogress'));
    expect(claimCall).toBeDefined();
    expect(claimCall).toContain('PVTI_1');

    // review sets status to "In Review" (opt_inreview)
    const reviewCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inreview'));
    expect(reviewCall).toBeDefined();
    expect(reviewCall).toContain('PVTI_1');
  });

  it('onFailure comments on the issue via gh', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    await primitives.onFailure('owner/repo#1', new Error('agent exploded'));

    const commentCall = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(commentCall).toBeDefined();
    expect(commentCall).toContain('1'); // issue number
    const bodyIdx = commentCall?.indexOf('--body') ?? -1;
    expect(commentCall?.[bodyIdx + 1]).toContain('agent exploded');
  });
});
