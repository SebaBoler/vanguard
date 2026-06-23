import { describe, expect, it } from 'vitest';
import { hasBlockingFinding, publishReviewVerdict } from './review-publish.js';
import type { StageOutcome } from './pipeline.js';
import type { GhRunner } from '../tasks/github.js';

function reviewerOutcome(finalText: string): StageOutcome {
  return {
    name: 'reviewer',
    result: {
      taskId: 't',
      completed: true,
      exitReason: 'completed',
      turns: 1,
      worktreePath: '/tmp/wt',
      worktreePreserved: true,
      finalText,
    },
  };
}

describe('hasBlockingFinding', () => {
  it('uses structured high and critical findings as blocking', () => {
    expect(
      hasBlockingFinding(
        '<findings>{"findings":[{"severity":"high","kind":"correctness","title":"bad","evidence":"x"}]}</findings>',
      ),
    ).toBe(true);
  });

  it('does not treat an empty structured findings block as blocking', () => {
    expect(hasBlockingFinding('No blocking issues.\n<findings>{"findings":[]}</findings>')).toBe(false);
  });
});

describe('publishReviewVerdict', () => {
  it('posts request-changes for a gated high-severity finding from a full PR URL', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return '';
    };

    await publishReviewVerdict({
      prUrl: 'https://github.com/o/r/pull/42',
      headSha: 'abcdef123456',
      reviewerOutcome: reviewerOutcome(
        '<findings>{"findings":[{"severity":"high","kind":"correctness","title":"bad","evidence":"x"}]}</findings>',
      ),
      attribution: 'codex/gpt-5',
      gate: true,
      gh,
    });

    expect(calls[0]).toEqual([
      'pr',
      'review',
      '42',
      '--repo',
      'o/r',
      '--request-changes',
      '--body',
      expect.stringContaining('Reviewed by codex/gpt-5 @ abcdef1'),
    ]);
  });

  it('throws instead of silently posting ok when the reviewer outcome is missing', async () => {
    await expect(
      publishReviewVerdict({
        prUrl: 'https://github.com/o/r/pull/42',
        headSha: 'abcdef123456',
        attribution: 'codex',
        gh: async () => '',
      }),
    ).rejects.toThrow('no reviewer outcome');
  });
});
