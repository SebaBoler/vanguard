import { describe, it, expect, vi } from 'vitest';
import { watchPrsCommand } from './watch-prs.js';
import type { Command } from './args.js';
import type { ReviewPrCommandRunner } from './watch-prs.js';
import type { PullRequestWatchItem, PullRequestWatchPrimitives, WatchPullRequestsLoopOptions } from '../runners/pr-watch.js';

describe('watchPrsCommand', () => {
  it('wires GitHub PR primitives to review-pr with operator logs', async () => {
    const logs: string[] = [];
    let capturedPrimitives: PullRequestWatchPrimitives | undefined;
    let capturedOptions: WatchPullRequestsLoopOptions | undefined;
    const reviewPr: ReviewPrCommandRunner = vi.fn(async () => {});
    const watchPullRequests = vi.fn(async (primitives: PullRequestWatchPrimitives, opts: WatchPullRequestsLoopOptions) => {
      capturedPrimitives = primitives;
      capturedOptions = opts;
      opts.log?.('watch-prs: poll -> 0 ready');
    });
    const cmd: Extract<Command, { kind: 'watch-prs' }> = {
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/repo',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      concurrency: 1,
      intervalMs: 1000,
      once: true,
      egress: true,
      llmProxy: true,
      provider: 'codex',
      reviewModel: 'gpt-5',
    };

    await watchPrsCommand(cmd, {
      reviewPr,
      watchPullRequests,
      log: (line) => logs.push(line),
    });

    expect(watchPullRequests).toHaveBeenCalledOnce();
    expect(capturedOptions).toEqual(
      expect.objectContaining({
        concurrency: 1,
        intervalMs: 1000,
        once: true,
        log: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    const item: PullRequestWatchItem = {
      repoSlug: 'o/r',
      number: 12,
      title: 'Fix auth',
      isDraft: false,
      author: 'alice',
      headRefOid: 'aaa',
      labels: ['ready for vanguard review'],
    };
    await capturedPrimitives?.review(item);

    expect(reviewPr).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'review-pr',
        prRef: '12',
        repoSlug: 'o/r',
        repoPath: '/repo',
        egress: true,
        llmProxy: true,
        provider: 'codex',
        reviewModel: 'gpt-5',
      }),
    );
    expect(logs).toEqual([
      'watch-prs[github]: polling every 1s for PRs labeled "ready for vanguard review". Ctrl-C to stop.',
      'watch-prs: poll -> 0 ready',
    ]);
  });
});
