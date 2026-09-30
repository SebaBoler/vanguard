import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(),
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

import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { runAgent } from '../core/vanguard.js';
import { mergeRequestReviewMarker, reviewMergeRequest } from '../runners/mr-review.js';
import { reviewMrCommand } from './review-mr.js';
import type { GlabRunner } from '../tasks/gitlab.js';

describe('reviewMrCommand', () => {
  const prev = { oat: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  // Each test asserts on call counts, so no test may see another's calls.
  beforeEach(() => {
    vi.mocked(startSandboxContext).mockReset();
    vi.mocked(runAgent).mockReset();
  });
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
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
      if (args[0] === 'api') return JSON.stringify([{ system: false, author: { username: 'vanguard-bot' }, body: mergeRequestReviewMarker(sha) }]);
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

  it('starts one sandbox context for both review attempts and destroys it once', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    const destroy = vi.fn(async () => undefined);
    vi.mocked(startSandboxContext).mockResolvedValue({ destroy } as never);
    const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ ...attempt, completed: false, finalText: 'Partial' })
      .mockResolvedValueOnce({ ...attempt, completed: true, finalText: 'No blocking findings.' });
    const sha = 'abc123def4567890';
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha });
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
      if (args[0] === 'api') return '[]';
      return '';
    };

    await reviewMrCommand(
      { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true },
      { reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: () => undefined },
    );

    expect(vi.mocked(runAgent).mock.calls.map(([, input]) => input.maxTurns)).toEqual([16, 24]);
    expect(startSandboxContext).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c[0] === 'mr' && c[1] === 'note')).toHaveLength(1);
  });
});
