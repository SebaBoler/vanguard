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
  planImplementReviewStages,
  planImplementAdversaryStages,
  adversarySystemPrompt,
  sandboxComplete,
  withStageModel,
  withStageModelExcept,
  techSpecStage,
  retrospectiveMemoryBlock,
  withStageFallback,
} from './pipeline.js';
import type { PipelineStage } from './pipeline.js';
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

  it('retries a stage on its fallback provider after an AgentError', async () => {
    const wm = new WorktreeManager(repo);
    const fallbackInputs: AgentRunInput[] = [];
    const primary: AgentProvider = {
      name: 'primary',
      async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        throw new AgentError('primary unavailable');
      },
    };
    const fallback = recordingAgent(fallbackInputs);
    const ctx = await prepareContext({ taskId: 'fallback', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });

    const result = await runBudgetedStages(
      ctx,
      [
        {
          name: 'reviewer',
          promptTemplate: 'review',
          provider: primary,
          model: 'foreign-model',
          fallback: { provider: fallback, model: 'fallback-model' },
        },
      ],
      { agent: primary, maxCostUsd: 1 },
    );

    expect(result.status).toBe('completed');
    expect(fallbackInputs).toHaveLength(1);
    expect(fallbackInputs[0]?.model).toBe('fallback-model');
    expect(fallbackInputs[0]?.resumeSessionId).toBeUndefined();
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
    expect(out.branch).toBe('vanguard/p2-r1');
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
    expect(out.branch).toBe('vanguard/pub-r1');
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toContain('push');
    expect(calls[1]?.file).toBe('gh');
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(['pr', 'create', '--head', 'vanguard/pub-r1', '--base', 'main', '--title', 'PR']),
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

describe('withStageFallback', () => {
  const stages: import('./pipeline.js').PipelineStage[] = [
    { name: 'implementer', promptTemplate: 'impl' },
    { name: 'reviewer', promptTemplate: 'review' },
  ];

  it('sets fallback only on the named stage and leaves the original array untouched', () => {
    const provider = recordingAgent([]);
    const result = withStageFallback(stages, { provider, model: 'gpt-5' });

    expect(result.find((s) => s.name === 'implementer')?.fallback).toBeUndefined();
    expect(result.find((s) => s.name === 'reviewer')?.fallback).toEqual({ provider, model: 'gpt-5' });
    expect(stages.every((s) => s.fallback === undefined)).toBe(true);
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
