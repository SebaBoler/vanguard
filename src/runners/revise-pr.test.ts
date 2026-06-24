import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from '../worktree/manager.js';
import { runRevisePullRequest } from './revise-pr.js';
import type { GhRunner } from '../tasks/github.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-revise-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# project');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
  // Create a branch representing the PR head
  await execa('git', ['checkout', '-b', 'feature-branch'], { cwd: repo });
  await execa('git', ['checkout', 'main'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeSandbox(): IsolatedSandboxProvider {
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    execStream: () => ({
      stdout: (async function* (): AsyncIterable<string> {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace') {
        await mkdir(hostPath, { recursive: true });
        // Agent writes a file in the sandbox → synced to worktree
        await writeFile(join(hostPath, 'fix.txt'), 'fix applied');
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function agentThatCompletes(received: AgentRunInput[]): AgentProvider {
  return {
    name: 'claude-code',
    async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      received.push(input);
      yield { text: 'applying fix' };
      return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: 'sess-1' };
    },
  };
}

function makePrViewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    title: 'Fix auth',
    body: 'Adds guard.',
    url: 'https://github.com/o/r/pull/7',
    author: { login: 'SebaBoler' },
    headRefName: 'feature-branch',
    headRefOid: 'deadbeef',
    baseRefName: 'main',
    ...overrides,
  });
}

function makeFeedbackJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          isDraft: true,
          headRefOid: 'deadbeef',
          commits: { nodes: [{ commit: { committedDate: '2024-01-10T08:00:00Z' } }] },
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      author: { login: 'alice' },
                      body: 'Please rename this.',
                      createdAt: '2024-01-11T10:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
          reviews: { nodes: [] },
          comments: { nodes: [] },
          ...overrides,
        },
      },
    },
  });
}

function makeRoundCountJson(): string {
  return JSON.stringify({ comments: [], reviews: [] });
}

function makeFeedbackJsonWithNonThreadItems(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          isDraft: true,
          headRefOid: 'deadbeef',
          commits: { nodes: [{ commit: { committedDate: '2024-01-10T08:00:00Z' } }] },
          reviewThreads: { nodes: [] },
          reviews: {
            nodes: [
              {
                author: { login: 'alice' },
                body: 'Overall LGTM but please address the naming.',
                state: 'COMMENTED',
                submittedAt: '2024-01-11T10:00:00Z',
              },
            ],
          },
          comments: {
            nodes: [
              {
                author: { login: 'bob' },
                body: 'Can you add a test?',
                createdAt: '2024-01-11T10:01:00Z',
              },
            ],
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runRevisePullRequest happy path', () => {
  it('applies fixes, pushes, replies+resolves threads, undrafts, and flips labels', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const agentInputs: AgentRunInput[] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      // pr view for fetchPullRequestForReview
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson();
      }
      // pr diff
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      // round count view (different json fields)
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.includes('comments,reviews')) {
        return makeRoundCountJson();
      }
      // graphql (feedback query or mutations)
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        // reply mutation
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        // resolve mutation
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      // pr comment (final summary)
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      // pr ready (undraft)
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      // pr edit (label flip)
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const pushRunner = async (file: string, args: string[], cwd: string): Promise<string> => {
      pushCalls.push({ file, args, cwd });
      return '';
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: pushRunner,
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.pr.repoSlug).toBe('o/r');
    expect(result.pr.number).toBe(7);
    expect(agentInputs).toHaveLength(3);
    expect(agentInputs[0]?.prompt).toContain('Please rename this.');

    // Push was called
    const pushCall = pushCalls.find((c) => c.file === 'git' && c.args[0] === 'push');
    expect(pushCall).toBeDefined();
    expect(pushCall?.args).toContain('HEAD:feature-branch');

    // gh pr ready was called
    const readyCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'ready');
    expect(readyCall).toBeDefined();
    expect(readyCall).toContain('7');

    // label flip
    const editCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('vanguard:needs-human-review'));
    expect(editCall).toBeDefined();
    expect(editCall).toContain('--remove-label');
    expect(editCall).toContain('needs revision');
  });
});

// ---------------------------------------------------------------------------
// No actionable feedback
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — no actionable feedback', () => {
  it('returns early without committing, pushing, or undrafting', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments,reviews')) return makeRoundCountJson();
      if (args[0] === 'api' && args[1] === 'graphql') {
        // Empty feedback
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                isDraft: true,
                headRefOid: 'deadbeef',
                commits: { nodes: [] },
                reviewThreads: { nodes: [] },
                reviews: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        });
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    // No push happened
    expect(pushCalls.filter((a) => a[0] === 'push')).toHaveLength(0);
    // No undraft
    expect(ghCalls.find((a) => a[1] === 'ready')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round cap
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — round cap', () => {
  it('posts a cap notice and flips labels without running the agent when cap is reached', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments,reviews')) {
        // Simulate 2 prior revision rounds
        return JSON.stringify({
          comments: [
            { body: '<!-- vanguard-revision: deadbeef -->' },
            { body: '<!-- vanguard-revision: abc1234 -->' },
          ],
          reviews: [],
        });
      }
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
      // cap comment post
      if (args[0] === 'pr' && args[1] === 'review') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      maxRounds: 2,
      provider: 'claude',
    });

    // No push or undraft
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    expect(pushCalls.filter((a) => a[0] === 'push')).toHaveLength(0);

    // Cap notice was posted
    const reviewPost = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'review' && a.includes('--comment'));
    expect(reviewPost).toBeDefined();

    // Labels were still flipped
    const editCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('vanguard:needs-human-review'));
    expect(editCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Per-item replies for non-thread feedback
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — per-item replies for non-thread feedback', () => {
  it('posts a per-item reply for each review/comment item plus a final summary, without a lumped review', async () => {
    const ghCalls: string[][] = [];
    const prCommentBodies: string[] = [];
    const pushCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const agentInputs: AgentRunInput[] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson();
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments,reviews')) {
        return makeRoundCountJson();
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJsonWithNonThreadItems();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        const bodyIdx = args.indexOf('--body');
        if (bodyIdx !== -1) prCommentBodies.push(args[bodyIdx + 1] ?? '');
        return '';
      }
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a, c) => { pushCalls.push({ file: f, args: a, cwd: c }); return ''; },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    // Two per-item replies + one final summary = 3 pr comment calls
    expect(prCommentBodies).toHaveLength(3);

    // Per-item bodies reference their respective feedback authors
    const aliceBody = prCommentBodies.find((b) => b.includes('@alice'));
    const bobBody = prCommentBodies.find((b) => b.includes('@bob'));
    expect(aliceBody).toBeDefined();
    expect(bobBody).toBeDefined();

    // Each per-item body contains "Addressed in commit" and the revision marker
    expect(aliceBody).toContain('Addressed in commit');
    expect(aliceBody).toContain('<!-- vanguard-revision:');
    expect(bobBody).toContain('Addressed in commit');
    expect(bobBody).toContain('<!-- vanguard-revision:');

    // Final summary exists and has required sections
    const summaryBody = prCommentBodies.find((b) => b.includes('## Revision Summary'));
    expect(summaryBody).toBeDefined();
    expect(summaryBody).toContain('Deferred / not addressed');
    expect(summaryBody).toContain('Verification');
    expect(summaryBody).toContain('<!-- vanguard-revision:');

    // No lumped "Addressed N review comment(s)" review was posted
    const hasLumpedReview = ghCalls.some(
      (a) =>
        a[0] === 'pr' &&
        a[1] === 'review' &&
        a.some((s) => s.includes('review comment')),
    );
    expect(hasLumpedReview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushToExistingBranch (pipeline function)
// ---------------------------------------------------------------------------

describe('pushToExistingBranch', () => {
  it('calls git push origin HEAD:<prHeadRef> in the worktree path', async () => {
    const { pushToExistingBranch } = await import('../pipeline/pipeline.js');
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
      calls.push({ file, args, cwd });
      return '';
    };
    const fakeCtx = {
      worktreePath: '/fake/worktree',
      branch: 'vanguard/test',
      taskId: 'test',
      sandbox: {} as IsolatedSandboxProvider,
      home: '/root',
      localRepoPath: '/repo',
      wm: {} as WorktreeManager,
      log: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) },
    } as unknown as import('../core/vanguard.js').RunContext;

    await pushToExistingBranch(fakeCtx, { prHeadRef: 'fix-auth', runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual(['push', 'origin', 'HEAD:fix-auth']);
    expect(calls[0]?.cwd).toBe('/fake/worktree');
  });

  it('respects a custom remote', async () => {
    const { pushToExistingBranch } = await import('../pipeline/pipeline.js');
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return '';
    };
    const fakeCtx = {
      worktreePath: '/fake/wt',
      branch: 'vanguard/t',
      taskId: 't',
      sandbox: {} as IsolatedSandboxProvider,
      home: '/root',
      localRepoPath: '/r',
      wm: {} as WorktreeManager,
      log: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) },
    } as unknown as import('../core/vanguard.js').RunContext;

    await pushToExistingBranch(fakeCtx, { prHeadRef: 'my-branch', remote: 'upstream', runner });
    expect(calls[0]?.args).toEqual(['push', 'upstream', 'HEAD:my-branch']);
  });
});
