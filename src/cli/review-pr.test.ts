import { describe, it, expect, vi } from 'vitest';
import { reviewPrCommand } from './review-pr.js';
import type { Command } from './args.js';
import type { ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';

describe('reviewPrCommand', () => {
  it('delegates to the PR review runner and preserves operator logs', async () => {
    const logs: string[] = [];
    const reviewer = vi.fn().mockResolvedValue('No blocking findings.');
    const reviewPullRequest = vi.fn(
      async (_ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> => {
        deps.log?.('review-pr o/r#12: fetch -> diff');
        deps.log?.('review-pr o/r#12: posted -> pr review');
        return {
          pr: {
            repoSlug: 'o/r',
            number: 12,
            title: 'Fix auth',
            body: '',
            url: 'https://github.com/o/r/pull/12',
            author: 'alice',
            headRefName: 'h',
            baseRefName: 'main',
            diff: 'diff',
          },
          commentBody: '## Vanguard Review\n\nNo blocking findings.',
        };
      },
    );
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      provider: 'codex',
      reviewModel: 'gpt-5',
    };

    await reviewPrCommand(cmd, {
      reviewer,
      reviewPullRequest,
      log: (line) => logs.push(line),
    });

    expect(reviewPullRequest).toHaveBeenCalledWith(
      '12',
      expect.objectContaining({
        repoSlug: 'o/r',
        reviewer,
        log: expect.any(Function),
      }),
    );
    expect(logs).toEqual([
      'review-pr o/r#12: fetch -> diff',
      'review-pr o/r#12: posted -> pr review',
      'review-pr o/r#12: done',
    ]);
  });
});
