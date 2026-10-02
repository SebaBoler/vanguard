import { describe, it, expect, vi } from 'vitest';

vi.mock('./preflight.js', () => ({
  runPreflight: vi.fn(async () => ({ ok: true, checks: [] })),
  formatPreflightReport: vi.fn(() => []),
}));

import { watchMrsCommand } from './watch-mrs.js';
import type { Command } from './args.js';
import type { ReviewMrCommandRunner } from './watch-mrs.js';
import type { MergeRequestWatchPrimitives } from '../runners/mr-watch.js';

describe('watchMrsCommand', () => {
  it('passes the review flags, including --max-turns, to each review-mr run', async () => {
    let capturedPrimitives: MergeRequestWatchPrimitives | undefined;
    const reviewMr: ReviewMrCommandRunner = vi.fn(async () => {});
    const watchMergeRequests = vi.fn(async (primitives: MergeRequestWatchPrimitives) => {
      capturedPrimitives = primitives;
    });
    // watchMrsCommand registers SIGINT/SIGTERM handlers; keep them off the test worker.
    const once = vi.spyOn(process, 'once').mockImplementation(() => process);
    const cmd: Extract<Command, { kind: 'watch-mrs' }> = {
      kind: 'watch-mrs',
      project: 'g/p',
      repoPath: '/repo',
      label: 'ready for review',
      reviewingLabel: 'vanguard::reviewing',
      reviewedLabel: 'vanguard::reviewed',
      concurrency: 1,
      intervalMs: 1000,
      once: true,
      egress: true,
      llmProxy: true,
      reviewModel: 'claude-opus-5-5',
      maxTurns: 48,
    };

    try {
      await watchMrsCommand(cmd, { reviewMr, watchMergeRequests, log: () => undefined });
      await capturedPrimitives?.review({ project: 'g/p', iid: 7, title: 't', draft: false, author: 'a', sha: 'abc', labels: [] });
    } finally {
      once.mockRestore();
    }

    expect(reviewMr).toHaveBeenCalledWith({
      kind: 'review-mr',
      iid: 7,
      project: 'g/p',
      repoPath: '/repo',
      egress: true,
      llmProxy: true,
      reviewModel: 'claude-opus-5-5',
      maxTurns: 48,
    });
  });
});
