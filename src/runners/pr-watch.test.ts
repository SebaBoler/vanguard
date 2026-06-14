import { describe, it, expect, vi } from 'vitest';
import { githubPullRequestWatchPrimitives, watchPullRequestsOnce } from './pr-watch.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchItem, PullRequestWatchPrimitives } from './pr-watch.js';

function pr(number: number): PullRequestWatchItem {
  return {
    repoSlug: 'o/r',
    number,
    title: `PR ${number}`,
    isDraft: false,
    author: 'alice',
    headRefOid: `sha-${number}`,
    labels: ['ready for vanguard review'],
  };
}

describe('watchPullRequestsOnce', () => {
  it('claims, reviews, and marks each ready PR in order', async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => [pr(12)],
      claim: vi.fn(async (item) => {
        order.push(`claim:${item.number}`);
      }),
      review: vi.fn(async (item) => {
        order.push(`review:${item.number}`);
      }),
      markReviewed: vi.fn(async (item) => {
        order.push(`mark:${item.number}`);
      }),
      onFailure: vi.fn(),
    };

    const tick = await watchPullRequestsOnce(primitives, { log: (line) => logs.push(line) });

    expect(tick).toEqual({ reviewed: ['o/r#12'], failed: [], skipped: [] });
    expect(order).toEqual(['claim:12', 'review:12', 'mark:12']);
    expect(logs).toEqual([
      'watch-prs: poll -> 1 ready',
      'watch-prs o/r#12: claim -> reviewing',
      'watch-prs o/r#12: reviewed -> marked',
    ]);
  });

  it('skips already-claimed PRs and restores the trigger label on review failure', async () => {
    const logs: string[] = [];
    const restored: number[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => [pr(12), pr(13)],
      claim: vi.fn(async (item) => {
        if (item.number === 12) throw new Error('already claimed');
      }),
      review: vi.fn(async () => {
        throw new Error('review failed');
      }),
      markReviewed: vi.fn(),
      onFailure: vi.fn(async (item) => {
        restored.push(item.number);
      }),
    };

    const tick = await watchPullRequestsOnce(primitives, { log: (line) => logs.push(line), concurrency: 1 });

    expect(tick).toEqual({ reviewed: [], failed: ['o/r#13'], skipped: ['o/r#12'] });
    expect(restored).toEqual([13]);
    expect(logs).toContain('watch-prs o/r#12: skipped -> already claimed');
    expect(logs).toContain('watch-prs o/r#13: failed -> retry later');
  });
});

describe('githubPullRequestWatchPrimitives', () => {
  it('lists only non-draft, human-authored PRs that still carry the trigger label', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'aaa',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 13,
            title: 'Draft',
            isDraft: true,
            author: { login: 'bob' },
            headRefOid: 'bbb',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 14,
            title: 'Bot',
            isDraft: false,
            author: { login: 'github-actions[bot]' },
            headRefOid: 'ccc',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 15,
            title: 'Already claimed',
            isDraft: false,
            author: { login: 'carol' },
            headRefOid: 'ddd',
            labels: [{ name: 'vanguard:reviewing' }],
          },
        ]);
      }
      return '';
    };

    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'o/r',
      '--state',
      'open',
      '--label',
      'ready for vanguard review',
      '--limit',
      '100',
      '--json',
      'number,title,isDraft,author,headRefOid,labels',
    ]);
  });

  it('claims, marks reviewed, and restores labels through gh pr edit', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return args[1] === 'list' ? '[]' : '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = pr(12);

    await primitives.claim(item);
    await primitives.markReviewed(item);
    await primitives.onFailure(item, new Error('boom'));

    expect(calls).toEqual([
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'ready for vanguard review', '--add-label', 'vanguard:reviewing'],
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'vanguard:reviewing', '--add-label', 'vanguard:reviewed'],
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'vanguard:reviewing', '--add-label', 'ready for vanguard review'],
    ]);
  });
});
