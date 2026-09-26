import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(),
}));

import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { mergeRequestReviewMarker, reviewMergeRequest } from '../runners/mr-review.js';
import { reviewMrCommand } from './review-mr.js';
import type { GlabRunner } from '../tasks/gitlab.js';

describe('reviewMrCommand', () => {
  const prev = { oat: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  afterEach(() => {
    if (prev.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.oat;
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
  });

  it('exits without starting a sandbox when the head is already reviewed', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    const sha = 'abc123def4567890';
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha });
      if (args[0] === 'api') return JSON.stringify([{ system: false, body: mergeRequestReviewMarker(sha) }]);
      return '';
    };
    const lines: string[] = [];

    await reviewMrCommand(
      { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true },
      { reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: (l) => lines.push(l) },
    );

    expect(startSandboxContext).not.toHaveBeenCalled();
    expect(calls.some((c) => c[0] === 'mr' && c[1] === 'note')).toBe(false);
    expect(lines).toContain(`review-mr g/p!5: head ${sha} already reviewed -> skip`);
    expect(lines).not.toContain('review-mr g/p!5: done');
  });
});
