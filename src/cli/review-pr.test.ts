import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../sandbox/llm-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/llm-proxy.js')>()),
  startProviderProxies: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../core/vanguard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/vanguard.js')>()),
  prepareContext: vi.fn(async () => ({})),
  runAgent: vi.fn(),
  disposeContext: vi.fn(async () => undefined),
}));

import { runAgent } from '../core/vanguard.js';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewPrCommand } from './review-pr.js';
import { PullRequestReviewIncompleteError, reviewPullRequest } from '../runners/pr-review.js';
import type { GhRunner } from '../tasks/github.js';
import type { Command } from './args.js';
import type { ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';

function fakeResult(): ReviewPullRequestResult {
  return {
    pr: {
      repoSlug: 'o/r',
      number: 12,
      title: 'Fix auth',
      body: '',
      url: 'https://github.com/o/r/pull/12',
      author: 'alice',
      headRefName: 'h',
      headRefOid: 'abc123',
      baseRefName: 'main',
      diff: 'diff',
    },
    commentBody: '## Vanguard Review\n\nNo blocking findings.',
  };
}

describe('reviewPrCommand', () => {
  // The cap tests assert on runAgent's calls, so no test may see another's.
  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
  });

  it('delegates to the PR review runner and preserves operator logs', async () => {
    const logs: string[] = [];
    const reviewer = vi.fn().mockResolvedValue({ text: 'No blocking findings.', completed: true });
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
            headRefOid: 'abc123',
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

  it('--out writes the review to a file and tells the runner not to publish (no PR comment)', async () => {
    const outPath = join(tmpdir(), `vanguard-review-out-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    let seenPublish: boolean | undefined;
    const reviewPullRequest = vi.fn(async (_ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> => {
      seenPublish = deps.publish;
      return fakeResult();
    });
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      out: outPath,
    };
    try {
      await reviewPrCommand(cmd, { reviewer: vi.fn(), reviewPullRequest, log: () => {} });
      expect(seenPublish).toBe(false);
      expect(await readFile(outPath, 'utf8')).toBe('## Vanguard Review\n\nNo blocking findings.');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it('--out writes the incomplete notice and rethrows so the exit code stays truthful', async () => {
    const outPath = join(tmpdir(), `vanguard-review-out-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    const incomplete = new PullRequestReviewIncompleteError(fakeResult().pr, '## Vanguard Review\n\nnotice');
    const reviewPullRequest = vi.fn(async (): Promise<ReviewPullRequestResult> => {
      throw incomplete;
    });
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      out: outPath,
    };
    try {
      await expect(reviewPrCommand(cmd, { reviewer: vi.fn(), reviewPullRequest, log: () => {} })).rejects.toBe(incomplete);
      expect(await readFile(outPath, 'utf8')).toBe('## Vanguard Review\n\nnotice');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it.each([
    { maxTurns: undefined, caps: [16, 24] },
    { maxTurns: 41, caps: [41, 62] },
  ])('--max-turns $maxTurns gives caps $caps for the first attempt and the retry', async ({ maxTurns, caps }) => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
    try {
      const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
      vi.mocked(runAgent)
        .mockResolvedValueOnce({ ...attempt, completed: false, finalText: 'Partial' })
        .mockResolvedValueOnce({ ...attempt, completed: true, finalText: 'No blocking findings.' });
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 12, headRefOid: 'abc123' });
        return '';
      };

      await reviewPrCommand(
        { kind: 'review-pr', prRef: 'o/r#12', repoPath: '/repo', egress: true, ...(maxTurns !== undefined ? { maxTurns } : {}) },
        { reviewPullRequest: (ref, deps) => reviewPullRequest(ref, { ...deps, gh }), log: () => undefined },
      );

      expect(vi.mocked(runAgent).mock.calls.map(([, input]) => input.maxTurns)).toEqual(caps);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
