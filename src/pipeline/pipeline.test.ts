import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import {
  runStages,
  runBudgetedStages,
  commitStage,
  generateEvaluateRepairStages,
  implementReviewSimplifyStages,
  fastStages,
  defaultSystemPrompt,
  publishForReview,
  pushToExistingBranch,
  pushAuthConfigArgs,
  planImplementReviewStages,
  planImplementAdversaryStages,
  adversarySystemPrompt,
  sandboxComplete,
  withStageModel,
  withStageModelExcept,
  withStageFallback,
  techSpecStage,
  retrospectiveMemoryBlock,
  assembleReviewPipeline,
  resolveRouting,
  STAGE,
} from './pipeline.js';
import type { PipelineStage, StageName, StageRouting } from './pipeline.js';
import type { Complete } from '../evals/judges.js';
import { AgentError } from '../core/errors.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-pipe-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
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
        await writeFile(join(hostPath, 'feature.txt'), 'work');
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function recordingAgent(received: AgentRunInput[]): AgentProvider {
  return {
    name: 'rec',
    async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      received.push(input);
      yield { text: 'working' };
      return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: 'sess' };
    },
  };
}

describe('runStages', () => {
  it('runs stages, chains the session, and feeds the previous diff forward', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'p1', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const outcomes = await runStages(
      ctx,
      [
        { name: 'implementer', promptTemplate: 'do {{TITLE}}' },
        { name: 'reviewer', promptTemplate: 'review:\n{{PREVIOUS_DIFF}}' },
      ],
      { agent: recordingAgent(received), variables: { TITLE: 'X' } },
    );

    expect(outcomes.map((o) => o.name)).toEqual(['implementer', 'reviewer']);
    expect(outcomes.every((o) => o.result.completed)).toBe(true);
    expect(received[0]?.resumeSessionId).toBeUndefined();
    expect(received[1]?.resumeSessionId).toBe('sess');
    expect(received[1]?.prompt).toContain('feature.txt');
    await disposeContext(ctx);
  });

  it('runs a stage on its own provider when stage.provider is set (cross-provider review)', async () => {
    const wm = new WorktreeManager(repo);
    const def: AgentRunInput[] = [];
    const review: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'xp', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runStages(
      ctx,
      [
        { name: 'implementer', promptTemplate: 'do' },
        { name: 'reviewer', promptTemplate: 'review', provider: recordingAgent(review) },
      ],
      { agent: recordingAgent(def), variables: {} },
    );
    expect(def).toHaveLength(1); // implementer on the default provider only
    expect(review).toHaveLength(1); // reviewer routed to its own provider
    await disposeContext(ctx);
  });
});

describe('sandboxComplete', () => {
  it('runs the agent one-shot in /tmp and returns its finalText', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'sc', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    let seen: AgentRunInput | undefined;
    const agent: AgentProvider = {
      name: 'scorer',
      async *run(inp: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        seen = inp;
        return { finalText: '<verdict>{"passed":true,"score":0.9,"reason":"ok"}</verdict>', turns: 1 };
      },
    };
    const complete = sandboxComplete(ctx, agent);
    const text = await complete('rate this diff');
    expect(text).toContain('"score":0.9');
    expect(seen?.workdir).toBe('/tmp'); // scored off-worktree so a stray write can't touch the code
    expect(seen?.maxTurns).toBe(1);
    await disposeContext(ctx);
  });
});

describe('runBudgetedStages', () => {
  function costingAgent(costUsd: number): AgentProvider {
    return {
      name: 'cost',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'x', turns: 1, costUsd };
      },
    };
  }
  const threeStages: PipelineStage[] = [
    { name: 'a', promptTemplate: 'a' },
    { name: 'b', promptTemplate: 'b' },
    { name: 'c', promptTemplate: 'c' },
  ];

  it('freezes to budget_exceeded before the stage that would exceed the limit', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'bud', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const result = await runBudgetedStages(ctx, threeStages, { agent: costingAgent(0.03), maxCostUsd: 0.05 });
    expect(result.status).toBe('frozen');
    if (result.status === 'frozen') {
      expect(result.reason).toBe('budget_exceeded');
      expect(result.outcomes).toHaveLength(2);
      expect(result.spentUsd).toBeCloseTo(0.06);
      expect(result.shellCommand).toContain('docker exec -it');
    }
    await disposeContext(ctx, { keep: true });
  });

  it('completes when under budget', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'bud2', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const result = await runBudgetedStages(ctx, threeStages, { agent: costingAgent(0.01), maxCostUsd: 1 });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.outcomes).toHaveLength(3);
    await disposeContext(ctx);
  });

  it('retries an AgentError stage on its fallback provider and records the provider actually used', async () => {
    const wm = new WorktreeManager(repo);
    const primaryInputs: AgentRunInput[] = [];
    const fallbackInputs: AgentRunInput[] = [];
    const primary: AgentProvider = {
      name: 'codex',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        primaryInputs.push(input);
        throw new AgentError('provider unavailable');
      },
    };
    const fallback = recordingAgent(fallbackInputs);
    const ctx = await prepareContext({ taskId: 'fallback', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages = withStageFallback(
      [{ name: 'reviewer', promptTemplate: 'review', provider: primary, model: 'gpt-5' }],
      { provider: fallback, model: 'sonnet' },
    );

    const result = await runBudgetedStages(ctx, stages, { agent: recordingAgent([]), maxCostUsd: 1 });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.outcomes[0]?.providerName).toBe('rec');
      expect(result.outcomes[0]?.model).toBe('sonnet');
    }
    expect(primaryInputs).toHaveLength(1);
    expect(primaryInputs[0]?.model).toBe('gpt-5');
    expect(fallbackInputs).toHaveLength(1);
    expect(fallbackInputs[0]?.model).toBe('sonnet');
    await disposeContext(ctx);
  });
});

describe('commitStage', () => {
  it('commits dirty worktree work onto the branch', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'p2', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await writeFile(join(ctx.worktreePath, 'x.txt'), 'data');
    const out = await commitStage(ctx, { message: 'feat: agent work' });
    expect(out.committed).toBe(true);
    expect(out.branch).toBe('chore/vanguard-p2-r1');
    expect(out.sha).toBeTruthy();
    expect(await wm.isDirty(ctx.worktreePath)).toBe(false);
    await disposeContext(ctx);
  });

  it('reports nothing to commit on a clean worktree', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'p3', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const out = await commitStage(ctx, { message: 'noop' });
    expect(out.committed).toBe(false);
    await disposeContext(ctx);
  });

  it('commits despite a failing pre-commit hook (--no-verify skips the target repo hooks)', async () => {
    // A worktree shares the main repo's hooks; a target project's husky hook (eslint/nx) fails in the
    // isolated worktree because node_modules is absent. Simulate with a hook that always exits non-zero.
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    try {
      const wm = new WorktreeManager(repo, undefined, () => 'r4');
      const ctx = await prepareContext({ taskId: 'p4', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
      await writeFile(join(ctx.worktreePath, 'y.txt'), 'data');
      const out = await commitStage(ctx, { message: 'feat: work' });
      expect(out.committed).toBe(true);
      expect(out.sha).toBeTruthy();
      await disposeContext(ctx);
    } finally {
      await rm(hook, { force: true });
    }
  });
});

describe('generateEvaluateRepairStages', () => {
  it('defines generator -> evaluator -> repairer with separated contexts', () => {
    const stages = generateEvaluateRepairStages();
    expect(stages.map((s) => s.name)).toEqual(['generator', 'evaluator', 'repairer']);
    expect(stages[1]?.resumePrevious).toBe(false);
    expect(stages[2]?.resumePrevious).toBe(false);
  });

  it('forwards the previous stage final text as {{PREVIOUS_FINAL}}', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const agent: AgentProvider = {
      name: 'rec',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        received.push(input);
        return { finalText: 'RAPORT-' + received.length, turns: 1 };
      },
    };
    const ctx = await prepareContext({ taskId: 'ger', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runStages(
      ctx,
      [
        { name: 'a', promptTemplate: 'a' },
        { name: 'b', promptTemplate: 'I see: {{PREVIOUS_FINAL}}' },
      ],
      { agent },
    );
    expect(received[1]?.prompt).toContain('RAPORT-1');
    await disposeContext(ctx);
  });
});

describe('implementReviewSimplifyStages', () => {
  it('runs reviewer and simplifier in a fresh context (independent review)', () => {
    const byName = Object.fromEntries(implementReviewSimplifyStages().map((s) => [s.name, s]));
    expect(byName.implementer?.resumePrevious).toBeUndefined(); // implementer keeps the default
    expect(byName.reviewer?.resumePrevious).toBe(false);
    expect(byName.simplifier?.resumePrevious).toBe(false);
  });

  it('keeps conformance out of the default stage list', () => {
    const stages = implementReviewSimplifyStages();
    expect(stages.map((s) => s.name)).toEqual(['implementer', 'reviewer', 'simplifier']);
  });
});

describe('fastStages', () => {
  it('is a single low-effort implementer on a fast model', () => {
    const stages = fastStages();
    expect(stages).toHaveLength(1);
    expect(stages[0]?.effort).toBe('low');
    expect(stages[0]?.model).toBe('haiku');
    expect(stages[0]?.systemPrompt).toContain('<tradeoffs>');
  });
});

describe('publishForReview', () => {
  it('pushes the branch and opens a PR via the injected runner', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'pub', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return file === 'gh' ? 'https://github.com/o/r/pull/42' : '';
    };
    const out = await publishForReview(ctx, { title: 'PR', body: 'b', runner });
    expect(out.prUrl).toBe('https://github.com/o/r/pull/42');
    expect(out.branch).toBe('chore/vanguard-pub-r1');
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toContain('push');
    expect(calls[1]?.file).toBe('gh');
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(['pr', 'create', '--head', 'chore/vanguard-pub-r1', '--base', 'main', '--title', 'PR']),
    );
    await disposeContext(ctx);
  });

  it('publishForReview with glab calls glab mr create with gitlab flags', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'gl-test', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
      calls.push({ file, args, cwd });
      if (file === 'glab' && args[0] === 'mr') return 'https://gitlab.com/owner/repo/-/merge_requests/1\n';
      return '';
    };
    const out = await publishForReview(ctx, {
      title: 'My MR',
      body: 'desc',
      draft: true,
      cli: 'glab',
      runner,
    });
    const mrCall = calls.find(({ file }) => file === 'glab');
    expect(mrCall).toBeDefined();
    expect(mrCall?.args).toContain('mr');
    expect(mrCall?.args).toContain('create');
    expect(mrCall?.args).toContain('--source-branch');
    expect(mrCall?.args).toContain('--target-branch');
    expect(mrCall?.args).toContain('--description');
    expect(mrCall?.args).toContain('--draft');
    expect(out.prUrl).toBe('https://gitlab.com/owner/repo/-/merge_requests/1');
    await disposeContext(ctx);
  });
});

describe('pushAuthConfigArgs', () => {
  it('builds the extraheader override with the base64-encoded token, defaulting to github.com', () => {
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(pushAuthConfigArgs('TOK')).toEqual(['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`]);
  });

  it('honors a custom host', () => {
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(pushAuthConfigArgs('TOK', 'github.example.com')).toEqual([
      '-c',
      `http.https://github.example.com/.extraheader=AUTHORIZATION: basic ${b64}`,
    ]);
  });
});

describe('pushToExistingBranch', () => {
  it('with pushToken set, prepends the extraheader override before push', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-token', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return '';
    };
    await pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', pushToken: 'TOK', runner });
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual([
      '-c',
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`,
      'push',
      '--no-verify',
      'origin',
      'HEAD:feature-branch',
    ]);
    await disposeContext(ctx);
  });

  it('with pushToken absent, argv is exactly the baseline (no -c prefix)', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-notoken', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return '';
    };
    await pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', runner });
    expect(calls[0]?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:feature-branch']);
    await disposeContext(ctx);
  });

  it('redacts the base64 credential from a push failure when a token is in use', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-fail', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    const runner = async (): Promise<string> => {
      throw new Error(`git push failed: -c http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`);
    };
    await expect(pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', pushToken: 'TOK', runner })).rejects.toThrow(
      expect.not.stringContaining(b64),
    );
    await disposeContext(ctx);
  });
});

describe('planImplementReviewStages', () => {
  it('plans on opus and implements/reviews on sonnet', () => {
    const stages = planImplementReviewStages();
    expect(stages.map((s) => s.name)).toEqual(['planner', 'implementer', 'reviewer']);
    expect(stages[0]?.model).toBe('opus');
    expect(stages[1]?.model).toBe('sonnet');
    expect(stages[2]?.model).toBe('sonnet');
    expect(stages.every((s) => (s.systemPrompt ?? '').includes('<tradeoffs>'))).toBe(true);
  });
});

describe('planImplementAdversaryStages', () => {
  it('runs plan/implement/adversary/repair with a red-team adversary on a different model', () => {
    const stages = planImplementAdversaryStages();
    expect(stages.map((s) => s.name)).toEqual(['planner', 'implementer', 'adversary', 'repairer']);
    const adversary = stages[2];
    expect(adversary?.model).toBe('opus');
    expect(stages[1]?.model).toBe('sonnet');
    expect(adversary?.systemPrompt).toContain('Adversarial');
    expect(adversary?.systemPrompt).not.toContain('senior software engineer');
    expect(adversary?.systemPrompt).toBe(adversarySystemPrompt());
  });
});

describe('withStageModel', () => {
  const stages: import('./pipeline.js').PipelineStage[] = [
    { name: 'implementer', promptTemplate: 'impl' },
    { name: 'reviewer', promptTemplate: 'review' },
    { name: 'simplifier', promptTemplate: 'simplify' },
  ];

  it('sets model on every stage when stageName is omitted', () => {
    const result = withStageModel(stages, 'opus');
    expect(result.every((s) => s.model === 'opus')).toBe(true);
  });

  it('sets model only on the named stage and leaves others untouched', () => {
    const result = withStageModel(stages, 'haiku', 'reviewer');
    expect(result.find((s) => s.name === 'reviewer')?.model).toBe('haiku');
    expect(result.find((s) => s.name === 'implementer')?.model).toBeUndefined();
    expect(result.find((s) => s.name === 'simplifier')?.model).toBeUndefined();
  });

  it('does not mutate the original stages array', () => {
    withStageModel(stages, 'sonnet');
    expect(stages[0]?.model).toBeUndefined();
  });
});

describe('withStageModelExcept', () => {
  const stages: import('./pipeline.js').PipelineStage[] = [
    { name: 'implementer', promptTemplate: 'impl' },
    { name: 'reviewer', promptTemplate: 'review' },
    { name: 'simplifier', promptTemplate: 'simplify' },
  ];

  it('sets the model on every stage except the excepted one', () => {
    const result = withStageModelExcept(stages, 'sonnet', 'reviewer');
    expect(result.find((s) => s.name === 'implementer')?.model).toBe('sonnet');
    expect(result.find((s) => s.name === 'simplifier')?.model).toBe('sonnet');
    // the cross-provider reviewer keeps its own default (no leaked Anthropic model)
    expect(result.find((s) => s.name === 'reviewer')?.model).toBeUndefined();
  });

  it('does not mutate the original stages array', () => {
    withStageModelExcept(stages, 'opus', 'reviewer');
    expect(stages.every((s) => s.model === undefined)).toBe(true);
  });
});

describe('defaultSystemPrompt', () => {
  it('states role, policy, guidelines and explicit trade-offs', () => {
    const sp = defaultSystemPrompt();
    expect(sp).toContain('<role>');
    expect(sp).toContain('<policy>');
    expect(sp).toContain('<guidelines>');
    expect(sp).toContain('<tradeoffs>');
    expect(sp).toMatch(/cost/i);
  });

  it('is attached to every canonical stage', () => {
    for (const stage of [...implementReviewSimplifyStages(), ...generateEvaluateRepairStages()]) {
      expect(stage.systemPrompt).toContain('<tradeoffs>');
    }
  });

  it('runStages forwards a stage system prompt to the agent', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const agent: AgentProvider = {
      name: 'rec',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        received.push(input);
        return { finalText: 'x', turns: 1 };
      },
    };
    const ctx = await prepareContext({ taskId: 'sp', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runStages(ctx, [{ name: 's', promptTemplate: 'p', systemPrompt: 'SYS-XYZ' }], { agent });
    expect(received[0]?.systemPrompt).toBe('SYS-XYZ');
    await disposeContext(ctx);
  });
});

describe('runBudgetedStages copyBack', () => {
  it('skips copyFileOut for /workspace and produces no diff when stage.copyBack is false', async () => {
    const wm = new WorktreeManager(repo);
    let workdirCopyOutCalled = false;
    const sandbox: IsolatedSandboxProvider = {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> =>
        command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
      execStream: () => ({
        stdout: (async function* (): AsyncIterable<string> {})(),
        result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (sandboxPath: string): Promise<void> => {
        if (sandboxPath === '/workspace') workdirCopyOutCalled = true;
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
      shellCommand: (): string => 'docker exec -it vg-fake bash',
    } as unknown as IsolatedSandboxProvider;

    const ctx = await prepareContext({ taskId: 'cb-pipe', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runBudgetedStages(
      ctx,
      [{ name: 'spec', promptTemplate: 'describe', copyBack: false }],
      { agent: recordingAgent([]) },
    );
    await disposeContext(ctx);

    expect(workdirCopyOutCalled).toBe(false);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.outcomes[0]?.result.diff).toBeUndefined();
    }
  });
});

describe('techSpecStage', () => {
  it('returns a single-element array with copyBack false and no model set (caller owns the default)', () => {
    const stages = techSpecStage();
    expect(stages).toHaveLength(1);
    const stage = stages[0];
    expect(stage?.copyBack).toBe(false);
    expect(stage?.model).toBeUndefined();
    expect(stage?.name).toBe('tech-spec');
  });

  it('overrides the model when opts.model is supplied', () => {
    const stages = techSpecStage({ model: 'sonnet' });
    expect(stages[0]?.model).toBe('sonnet');
  });

  it('promptTemplate references tech_spec tag and COMPLETE signal', () => {
    const { promptTemplate } = techSpecStage()[0]!;
    expect(promptTemplate).toContain('tech_spec');
    expect(promptTemplate).toContain('<promise>COMPLETE</promise>');
  });

  it('promptTemplate references {{TITLE}} and {{DESCRIPTION}}', () => {
    const { promptTemplate } = techSpecStage()[0]!;
    expect(promptTemplate).toContain('{{TITLE}}');
    expect(promptTemplate).toContain('{{DESCRIPTION}}');
  });

  it('systemPrompt is read-only: does not mention editing files', () => {
    const { systemPrompt } = techSpecStage()[0]!;
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt).toContain('do not edit');
    expect(systemPrompt).not.toMatch(/make.*change/i);
  });

  it('runs read-only: does not call copyFileOut for /workspace', async () => {
    const wm = new WorktreeManager(repo);
    let workdirCopyOutCalled = false;
    const sandbox: IsolatedSandboxProvider = {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> =>
        command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
      execStream: () => ({
        stdout: (async function* (): AsyncIterable<string> {})(),
        result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (sandboxPath: string): Promise<void> => {
        if (sandboxPath === '/workspace') workdirCopyOutCalled = true;
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
      shellCommand: (): string => 'docker exec -it vg-fake bash',
    } as unknown as IsolatedSandboxProvider;

    const ctx = await prepareContext({ taskId: 'ts-ro', localRepoPath: repo, sandbox }, { worktrees: wm });
    await runBudgetedStages(ctx, techSpecStage(), { agent: recordingAgent([]), variables: { TITLE: 'T', DESCRIPTION: 'D' } });
    await disposeContext(ctx);

    expect(workdirCopyOutCalled).toBe(false);
  });
});

describe('retrospectiveMemoryBlock', () => {
  it('returns a string containing the advisory sentence and the placeholder', () => {
    const block = retrospectiveMemoryBlock();
    expect(block).toContain('Retrospective memory from prior Vanguard runs');
    expect(block).toContain('{{RETROSPECTIVE_MEMORY}}');
    expect(block).toContain('<retrospective_memory>');
    expect(block).toContain('</retrospective_memory>');
  });
});

describe('retrospective memory placeholders', () => {
  it('implementReviewSimplifyStages implementer prompt contains {{RETROSPECTIVE_MEMORY}} and advisory sentence', () => {
    const stages = implementReviewSimplifyStages();
    const implementer = stages.find((s) => s.name === 'implementer');
    expect(implementer?.promptTemplate).toContain('{{RETROSPECTIVE_MEMORY}}');
    expect(implementer?.promptTemplate).toContain('Retrospective memory from prior Vanguard runs');
  });

  it('reviewer stage does NOT contain {{RETROSPECTIVE_MEMORY}}', () => {
    const stages = implementReviewSimplifyStages();
    const reviewer = stages.find((s) => s.name === 'reviewer');
    expect(reviewer?.promptTemplate).not.toContain('{{RETROSPECTIVE_MEMORY}}');
  });

  it('simplifier stage does NOT contain {{RETROSPECTIVE_MEMORY}}', () => {
    const stages = implementReviewSimplifyStages();
    const simplifier = stages.find((s) => s.name === 'simplifier');
    expect(simplifier?.promptTemplate).not.toContain('{{RETROSPECTIVE_MEMORY}}');
  });

  it('techSpecStage promptTemplate contains {{RETROSPECTIVE_MEMORY}}', () => {
    const stages = techSpecStage();
    expect(stages[0]?.promptTemplate).toContain('{{RETROSPECTIVE_MEMORY}}');
    expect(stages[0]?.promptTemplate).toContain('Retrospective memory from prior Vanguard runs');
  });
});

describe('runBudgetedStages fork option', () => {
  it('forks the implementer and the winning diff reaches the reviewer', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];

    // Variant 0 scores 0.9, variant 1 scores 0.3 — variant 0 wins.
    let scoreCall = 0;
    const complete: Complete = async () => {
      const score = scoreCall++ === 0 ? 0.9 : 0.3;
      return `<verdict>{"passed":true,"score":${score},"reason":"ok"}</verdict>`;
    };

    const ctx = await prepareContext(
      { taskId: 'fork-impl', localRepoPath: repo, sandbox: makeSandbox() },
      { worktrees: wm },
    );
    const result = await runBudgetedStages(
      ctx,
      [
        { name: 'implementer', promptTemplate: 'implement {{TITLE}}' },
        { name: 'reviewer', resumePrevious: false, promptTemplate: 'review:\n{{PREVIOUS_DIFF}}' },
      ],
      { agent: recordingAgent(received), variables: { TITLE: 'X' }, fork: { n: 2, complete } },
    );

    expect(result.status).toBe('completed');
    // 2 fork variants + 1 reviewer = 3 agent calls
    expect(received).toHaveLength(3);
    // reviewer (3rd call) received the winning variant's diff in its prompt
    expect(received[2]?.prompt).toContain('feature.txt');
    await disposeContext(ctx);
  });
});

describe('assembleReviewPipeline', () => {
  const base: PipelineStage[] = [
    { name: 'implementer', promptTemplate: 'impl' },
    { name: 'reviewer', promptTemplate: 'review' },
    { name: 'simplifier', promptTemplate: 'simplify' },
  ];

  function stubAgent(name: string): AgentProvider {
    return {
      name,
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: '', turns: 0 };
      },
    };
  }

  const agent = stubAgent('claude');
  const reviewAgent = stubAgent('codex');

  it('returns base untouched when no reviewAgent and no models are set', () => {
    const result = assembleReviewPipeline(base, { agent }, {});
    expect(result).toEqual(base);
    expect(result.every((s) => s.provider === undefined)).toBe(true);
    expect(result.every((s) => s.model === undefined)).toBe(true);
    expect(result.every((s) => s.fallback === undefined)).toBe(true);
  });

  it('assigns provider and fallback to reviewer when reviewAgent is set', () => {
    const result = assembleReviewPipeline(base, { agent, reviewAgent }, {});
    expect(result.find((s) => s.name === 'reviewer')?.provider).toBe(reviewAgent);
    expect(result.find((s) => s.name === 'implementer')?.provider).toBeUndefined();
    expect(result.find((s) => s.name === 'reviewer')?.fallback?.provider).toBe(agent);
    expect(result.find((s) => s.name === 'reviewer')?.fallback?.model).toBeUndefined();
  });

  it('sets model on every stage (incl. reviewer) for same-provider review', () => {
    const result = assembleReviewPipeline(base, { agent, reviewAgent: stubAgent('claude') }, {
      provider: 'claude',
      reviewProvider: 'claude',
      providerModel: 'sonnet',
    });
    expect(result.every((s) => s.model === 'sonnet')).toBe(true);
  });

  it('sets model on every stage except reviewer for cross-provider review', () => {
    const result = assembleReviewPipeline(base, { agent, reviewAgent }, {
      provider: 'claude',
      reviewProvider: 'codex',
      providerModel: 'sonnet',
    });
    expect(result.find((s) => s.name === 'implementer')?.model).toBe('sonnet');
    expect(result.find((s) => s.name === 'simplifier')?.model).toBe('sonnet');
    expect(result.find((s) => s.name === 'reviewer')?.model).toBeUndefined();
    expect(result.find((s) => s.name === 'reviewer')?.fallback?.model).toBe('sonnet');
  });

  it('treats undefined provider as claude for cross-provider detection', () => {
    // provider undefined defaults to 'claude'; reviewProvider 'codex' => cross-provider
    const result = assembleReviewPipeline(base, { agent, reviewAgent }, {
      reviewProvider: 'codex',
      providerModel: 'sonnet',
    });
    expect(result.find((s) => s.name === 'reviewer')?.model).toBeUndefined();
    expect(result.find((s) => s.name === 'implementer')?.model).toBe('sonnet');
  });

  it('reviewModel overrides model on reviewer only', () => {
    const result = assembleReviewPipeline(base, { agent }, {
      providerModel: 'sonnet',
      reviewModel: 'opus',
    });
    expect(result.find((s) => s.name === 'implementer')?.model).toBe('sonnet');
    expect(result.find((s) => s.name === 'simplifier')?.model).toBe('sonnet');
    expect(result.find((s) => s.name === 'reviewer')?.model).toBe('opus');
  });

  it('noSimplify:true removes the simplifier stage', () => {
    const result = assembleReviewPipeline(base, { agent }, { noSimplify: true });
    expect(result.map((s) => s.name)).not.toContain('simplifier');
    expect(result.map((s) => s.name)).toEqual(['implementer', 'reviewer']);
  });

  it('noSimplify:false (or absent) retains the simplifier stage', () => {
    const withFalse = assembleReviewPipeline(base, { agent }, { noSimplify: false });
    const withAbsent = assembleReviewPipeline(base, { agent }, {});
    expect(withFalse.map((s) => s.name)).toContain('simplifier');
    expect(withAbsent.map((s) => s.name)).toContain('simplifier');
  });

  it('does not mutate the original base array', () => {
    assembleReviewPipeline(base, { agent, reviewAgent }, {
      provider: 'claude',
      reviewProvider: 'codex',
      providerModel: 'sonnet',
      reviewModel: 'opus',
      noSimplify: true,
    });
    expect(base).toHaveLength(3);
    expect(base.every((s) => s.model === undefined)).toBe(true);
    expect(base.every((s) => s.provider === undefined)).toBe(true);
  });

  it('appends conformance after simplifier only when enabled', () => {
    expect(assembleReviewPipeline(base, { agent }, {}).map((s) => s.name)).toEqual([
      'implementer',
      'reviewer',
      'simplifier',
    ]);
    const result = assembleReviewPipeline(base, { agent }, { conformance: true });
    expect(result.map((s) => s.name)).toEqual([
      'implementer',
      'reviewer',
      'simplifier',
      'conformance',
    ]);
    expect(result.find((s) => s.name === 'conformance')?.copyBack).toBe(false);
  });

  it('keeps conformance after reviewer when simplifier is disabled and applies its model override', () => {
    const result = assembleReviewPipeline(base, { agent }, {
      conformance: true,
      noSimplify: true,
      providerModel: 'sonnet',
      conformanceModel: 'opus',
    });
    expect(result.map((s) => s.name)).toEqual(['implementer', 'reviewer', 'conformance']);
    expect(result.find((s) => s.name === 'conformance')?.model).toBe('opus');
  });
});

describe('resolveRouting', () => {
  const stages: PipelineStage[] = [
    { name: STAGE.IMPLEMENTER, promptTemplate: 'impl' },
    { name: STAGE.REVIEWER, promptTemplate: 'review' },
    { name: STAGE.CONFORMANCE, promptTemplate: 'conf' },
  ];

  it('is order-independent: same config, different key insertion order yields identical stages', () => {
    const a: Partial<Record<StageName, StageRouting>> = {};
    a[STAGE.IMPLEMENTER] = { model: 'sonnet' };
    a[STAGE.REVIEWER] = { model: 'opus' };
    const b: Partial<Record<StageName, StageRouting>> = {};
    b[STAGE.REVIEWER] = { model: 'opus' };
    b[STAGE.IMPLEMENTER] = { model: 'sonnet' };
    expect(resolveRouting(stages, a)).toEqual(resolveRouting(stages, b));
  });

  it('applies fallback only to the intended stage', () => {
    const result = resolveRouting(stages, { [STAGE.REVIEWER]: { fallback: { provider: stubAgent('claude') } } });
    expect(result.find((s) => s.name === STAGE.REVIEWER)?.fallback?.provider.name).toBe('claude');
    expect(result.find((s) => s.name === STAGE.IMPLEMENTER)?.fallback).toBeUndefined();
    expect(result.find((s) => s.name === STAGE.CONFORMANCE)?.fallback).toBeUndefined();
  });

  it('leaves stages without a config entry untouched and does not mutate inputs', () => {
    const result = resolveRouting(stages, { [STAGE.REVIEWER]: { model: 'opus' } });
    expect(result.find((s) => s.name === STAGE.IMPLEMENTER)).toBe(stages[0]);
    expect(stages.every((s) => s.model === undefined)).toBe(true);
  });

  function stubAgent(name: string): AgentProvider {
    return {
      name,
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: '', turns: 0 };
      },
    };
  }
});

describe('per-stage budget cap', () => {
  /** Agent that records every AgentRunInput it receives and returns a fixed cost. */
  function recordingCostAgent(received: AgentRunInput[], costUsd: number): AgentProvider {
    return {
      name: 'rec-cost',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        received.push(input);
        return { finalText: 'x', turns: 1, costUsd };
      },
    };
  }

  /** Agent that returns a fixed cost; includes a sessionId so resumeUntilComplete can run. */
  function resumableAgent(costUsd: number): AgentProvider {
    return {
      name: 'resumable',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'x', turns: 1, costUsd, sessionId: 'sess' };
      },
    };
  }

  it('effectiveCap uses fraction when set (no floor): fraction * maxCostUsd', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-frac', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runBudgetedStages(
      ctx,
      [{ name: 'a', promptTemplate: 'a', stageCostFraction: 0.4 }],
      { agent: recordingCostAgent(received, 0), maxCostUsd: 1.0 },
    );
    await disposeContext(ctx);
    // effectiveCap = min(max(1.0 * 0.4, 0), 1.0) = 0.4
    expect(received[0]?.maxBudgetUsd).toBeCloseTo(0.4);
  });

  it('effectiveCap applies floor when floor exceeds fraction result', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-floor', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runBudgetedStages(
      ctx,
      [{ name: 'a', promptTemplate: 'a', stageCostFraction: 0.1, stageCostFloorUsd: 0.5 }],
      { agent: recordingCostAgent(received, 0), maxCostUsd: 1.0 },
    );
    await disposeContext(ctx);
    // effectiveCap = min(max(0.1, 0.5), 1.0) = 0.5
    expect(received[0]?.maxBudgetUsd).toBeCloseTo(0.5);
  });

  it('global always wins: floor is capped by remainingGlobal when global is tiny', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-tiny-global', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runBudgetedStages(
      ctx,
      [{ name: 'a', promptTemplate: 'a', stageCostFraction: 0.5, stageCostFloorUsd: 10.0 }],
      { agent: recordingCostAgent(received, 0), maxCostUsd: 0.5 },
    );
    await disposeContext(ctx);
    // remainingGlobal = 0.5; floor (10) exceeds it; effectiveCap = min(10, 0.5) = 0.5
    expect(received[0]?.maxBudgetUsd).toBeCloseTo(0.5);
  });

  it('stages without new fields get effectiveCap = remaining global (back-compat)', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-compat', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await runBudgetedStages(
      ctx,
      [{ name: 'a', promptTemplate: 'a' }],
      { agent: recordingCostAgent(received, 0), maxCostUsd: 2.0 },
    );
    await disposeContext(ctx);
    // No stageCostFraction → effectiveCap = remainingGlobal = 2.0
    expect(received[0]?.maxBudgetUsd).toBeCloseTo(2.0);
  });

  it('continue policy: implementer at cap, reviewer still runs, result completed', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-continue', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages: PipelineStage[] = [
      { name: 'implementer', promptTemplate: 'impl', stageCostFraction: 0.5, onStageBudgetExceeded: 'continue' },
      { name: 'reviewer', promptTemplate: 'review' },
    ];
    // maxCostUsd = $2; implementer effectiveCap = $1; costs $1.5 (overshoot). Policy: continue.
    // spentUsd = $1.5 < $2 (global). Reviewer runs.
    const result = await runBudgetedStages(ctx, stages, { agent: recordingCostAgent(received, 1.5), maxCostUsd: 2.0 });
    await disposeContext(ctx);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]?.name).toBe('implementer');
      expect(result.outcomes[1]?.name).toBe('reviewer');
    }
  });

  it('freeze policy: stage at cap returns frozen with outcomes so far', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'cap-freeze', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages: PipelineStage[] = [
      { name: 'a', promptTemplate: 'a', stageCostFraction: 0.3, onStageBudgetExceeded: 'freeze' },
      { name: 'b', promptTemplate: 'b' },
    ];
    // effectiveCap = $2 * 0.3 = $0.6; costs $1.0 → fires freeze
    const agent: AgentProvider = {
      name: 'cost',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'x', turns: 1, costUsd: 1.0 };
      },
    };
    const result = await runBudgetedStages(ctx, stages, { agent, maxCostUsd: 2.0 });
    await disposeContext(ctx, { keep: true });
    expect(result.status).toBe('frozen');
    if (result.status === 'frozen') {
      expect(result.reason).toBe('budget_exceeded');
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]?.name).toBe('a');
      expect(result.spentUsd).toBeCloseTo(1.0);
    }
  });

  it('global backstop freezes regardless of per-stage continue policy', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'cap-global-wins', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages: PipelineStage[] = [
      { name: 'a', promptTemplate: 'a', stageCostFraction: 0.5, onStageBudgetExceeded: 'continue' },
      { name: 'b', promptTemplate: 'b', stageCostFraction: 0.5, onStageBudgetExceeded: 'continue' },
      { name: 'c', promptTemplate: 'c' },
    ];
    // maxCostUsd = $0.5. Each stage costs $0.4.
    // Stage a: effectiveCap = $0.25, costs $0.4 → 'continue'. spentUsd = $0.4.
    // Stage b: remainingGlobal = $0.1. effectiveCap = $0.1. Costs $0.4 → 'continue'. spentUsd = $0.8.
    // Before stage c: spentUsd ($0.8) >= maxCostUsd ($0.5) → global freeze.
    const agent: AgentProvider = {
      name: 'cost',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'x', turns: 1, costUsd: 0.4 };
      },
    };
    const result = await runBudgetedStages(ctx, stages, { agent, maxCostUsd: 0.5 });
    await disposeContext(ctx, { keep: true });
    expect(result.status).toBe('frozen');
    if (result.status === 'frozen') {
      expect(result.reason).toBe('budget_exceeded');
      expect(result.outcomes).toHaveLength(2);
    }
  });

  it('skip policy: stage at cap proceeds like continue (next stage runs)', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-skip', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages: PipelineStage[] = [
      { name: 'simplifier', promptTemplate: 'simplify', stageCostFraction: 0.1, onStageBudgetExceeded: 'skip' },
      { name: 'reviewer', promptTemplate: 'review' },
    ];
    // effectiveCap = $1 * 0.1 = $0.1; costs $0.5 → skip. Next stage runs.
    const result = await runBudgetedStages(ctx, stages, { agent: recordingCostAgent(received, 0.5), maxCostUsd: 2.0 });
    await disposeContext(ctx);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.outcomes).toHaveLength(2);
  });

  it('provider-ignored cap: orchestrator post-stage check still applies continue policy', async () => {
    // Simulates Codex/Cursor ignoring maxBudgetUsd: the agent returns costUsd above the cap.
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'cap-advisory', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const stages: PipelineStage[] = [
      { name: 'a', promptTemplate: 'a', stageCostFraction: 0.2, onStageBudgetExceeded: 'continue' },
      { name: 'b', promptTemplate: 'b' },
    ];
    // effectiveCap = $1; agent returns $2 (ignoring cap). Policy: continue → both stages complete.
    const agent: AgentProvider = {
      name: 'codex',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'x', turns: 1, costUsd: 2.0 };
      },
    };
    const result = await runBudgetedStages(ctx, stages, { agent, maxCostUsd: 5.0 });
    await disposeContext(ctx);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.outcomes).toHaveLength(2);
  });

  it('resumeUntilComplete: per-stage cap stops resumes when aggregate cost exceeds cap', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'cap-resume', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    // effectiveCap = $1.0 * 0.3 = $0.3. Each call costs $0.15.
    // Primary: stageCost = $0.15. Resume 1: stageCost = $0.30.
    // Resume 2 condition: stageCost ($0.30) < effectiveCap ($0.30)? No → loop stops.
    // Next stage 'b' runs.
    const stages: PipelineStage[] = [
      { name: 'a', promptTemplate: 'a', stageCostFraction: 0.3, resumeUntilComplete: 5 },
      { name: 'b', promptTemplate: 'b' },
    ];
    const result = await runBudgetedStages(ctx, stages, { agent: resumableAgent(0.15), maxCostUsd: 1.0 });
    await disposeContext(ctx);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.outcomes).toHaveLength(2);
      // stageCost for 'a' = 2 calls × $0.15 = $0.30; total spentUsd ≈ $0.60 (2 stages × $0.30)
      expect(result.outcomes[0]?.name).toBe('a');
      expect(result.outcomes[1]?.name).toBe('b');
    }
  });

  it('PREVIOUS_STAGE_TRUNCATED is true when prior stage exited non-completed', async () => {
    const wm = new WorktreeManager(repo);
    const received: AgentRunInput[] = [];
    const ctx = await prepareContext({ taskId: 'cap-trunc', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    // Stage 'a': maxTurns:1, agent returns turns=1 → exitReason='maxTurns' (not 'completed').
    // Stage 'b': should see PREVIOUS_STAGE_TRUNCATED='true'.
    const agent: AgentProvider = {
      name: 'rec',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        received.push(input);
        return { finalText: 'x', turns: 1 };
      },
    };
    await runBudgetedStages(
      ctx,
      [
        { name: 'a', promptTemplate: 'a', maxTurns: 1 },
        { name: 'b', promptTemplate: '{{PREVIOUS_STAGE_TRUNCATED}}' },
      ],
      { agent },
    );
    await disposeContext(ctx);
    // b's prompt is '{{PREVIOUS_STAGE_TRUNCATED}}' which should render to 'true'
    expect(received[1]?.prompt).toBe('true');
  });
});

describe('implementReviewSimplifyStages defaults', () => {
  it('sets per-stage fraction, floor, timeout, and policy defaults', () => {
    const stages = implementReviewSimplifyStages();
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));

    expect(byName.implementer?.stageCostFraction).toBeCloseTo(0.6);
    expect(byName.implementer?.stageCostFloorUsd).toBeCloseTo(0.25);
    expect(byName.implementer?.timeoutMs).toBe(25 * 60 * 1000);
    expect(byName.implementer?.onStageBudgetExceeded).toBe('continue');

    expect(byName.reviewer?.stageCostFraction).toBeCloseTo(0.25);
    expect(byName.reviewer?.stageCostFloorUsd).toBeCloseTo(0.5);
    expect(byName.reviewer?.timeoutMs).toBe(15 * 60 * 1000);
    expect(byName.reviewer?.onStageBudgetExceeded).toBe('continue');

    expect(byName.simplifier?.stageCostFraction).toBeCloseTo(0.15);
    expect(byName.simplifier?.stageCostFloorUsd).toBeCloseTo(0.25);
    expect(byName.simplifier?.timeoutMs).toBe(15 * 60 * 1000);
    expect(byName.simplifier?.onStageBudgetExceeded).toBe('skip');
  });
});
