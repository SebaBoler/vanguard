import { describe, it, expect, vi } from 'vitest';
import { eventPullRequestHint, watchPrsCommand } from './watch-prs.js';
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
      return { reviewed: [], failed: [], skipped: [] };
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

  it('pins --pr, logs it, and fails the process when a --once review failed', async () => {
    const previousExitCode = process.exitCode;
    const logs: string[] = [];
    const watchPullRequests = vi.fn(async () => ({ reviewed: [], failed: ['o/r#316'], skipped: [] }));
    const cmd: Extract<Command, { kind: 'watch-prs' }> = {
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/repo',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      pr: 316,
      concurrency: 1,
      intervalMs: 1000,
      once: true,
      egress: true,
    };

    try {
      await watchPrsCommand(cmd, { reviewPr: vi.fn(async () => {}), watchPullRequests, log: (line) => logs.push(line) });
      expect(logs).toContain('watch-prs[github]: o/r#316 pinned from --pr — reviewed even if the label scan misses it.');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe('eventPullRequestHint', () => {
  it('returns the PR number when the event label matches the trigger label', () => {
    const read = (): string => JSON.stringify({ label: { name: 'ready for vanguard review' }, pull_request: { number: 316 } });
    expect(eventPullRequestHint('ready for vanguard review', '/event.json', read)).toBe(316);
  });

  it('ignores other labels, missing paths, junk payloads, and non-PR events', () => {
    expect(
      eventPullRequestHint('ready for vanguard review', '/event.json', () =>
        JSON.stringify({ label: { name: 'bug' }, pull_request: { number: 316 } }),
      ),
    ).toBeUndefined();
    expect(eventPullRequestHint('ready for vanguard review', undefined)).toBeUndefined();
    expect(eventPullRequestHint('ready for vanguard review', '')).toBeUndefined();
    expect(eventPullRequestHint('ready for vanguard review', '/event.json', () => 'not json')).toBeUndefined();
    expect(
      eventPullRequestHint('ready for vanguard review', '/event.json', () =>
        JSON.stringify({ label: { name: 'ready for vanguard review' } }),
      ),
    ).toBeUndefined();
    expect(
      eventPullRequestHint('ready for vanguard review', '/event.json', () => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });
});
