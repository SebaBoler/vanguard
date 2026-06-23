import { describe, expect, it } from 'vitest';
import { publishReviewVerdict } from './review-publish.js';
import type { StageOutcome } from './pipeline.js';
import type { GhRunner } from '../tasks/github.js';

function reviewerOutcome(finalText: string): StageOutcome {
  return {
    name: 'reviewer',
    result: {
      taskId: 'task',
      finalText,
      turns: 1,
      completed: true,
      exitReason: 'completed',
      worktreePath: '/tmp/worktree',
      worktreePreserved: false,
    },
  };
}

describe('publishReviewVerdict', () => {
  it('posts request-changes when review gating sees a high structured finding', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return '';
    };

    await publishReviewVerdict({
      repoSlug: 'o/r',
      prUrl: 'https://github.com/o/r/pull/12',
      headSha: 'abcdef123456',
      attribution: 'codex/gpt-5',
      gate: true,
      gh,
      reviewerOutcome: reviewerOutcome(
        [
          '<findings>',
          '{"findings":[{"severity":"high","kind":"correctness","title":"Bug","evidence":"diff"}]}',
          '</findings>',
          '<promise>COMPLETE</promise>',
        ].join('\n'),
      ),
    });

    expect(calls[0]?.slice(0, 6)).toEqual(['pr', 'review', '12', '--repo', 'o/r', '--request-changes']);
    expect(calls[0]?.at(-1)).toContain('Reviewed by codex/gpt-5 @ abcdef1');
  });

  it('throws when the reviewer stage outcome is missing', async () => {
    await expect(
      publishReviewVerdict({
        repoSlug: 'o/r',
        prUrl: 'https://github.com/o/r/pull/12',
        headSha: 'abcdef123456',
        attribution: 'codex/gpt-5',
        reviewerOutcome: undefined,
      }),
    ).rejects.toThrow('reviewer stage outcome is missing');
  });
});
