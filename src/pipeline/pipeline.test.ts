import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import {
  runStages,
  commitStage,
  generateEvaluateRepairStages,
  implementReviewSimplifyStages,
  fastStages,
  defaultSystemPrompt,
  publishForReview,
  planImplementReviewStages,
} from './pipeline.js';
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
});

describe('commitStage', () => {
  it('commits dirty worktree work onto the branch', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'p2', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    await writeFile(join(ctx.worktreePath, 'x.txt'), 'data');
    const out = await commitStage(ctx, { message: 'feat: agent work' });
    expect(out.committed).toBe(true);
    expect(out.branch).toBe('vanguard/p2');
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
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'pub', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return file === 'gh' ? 'https://github.com/o/r/pull/42' : '';
    };
    const out = await publishForReview(ctx, { title: 'PR', body: 'b', runner });
    expect(out.prUrl).toBe('https://github.com/o/r/pull/42');
    expect(out.branch).toBe('vanguard/pub');
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toContain('push');
    expect(calls[1]?.file).toBe('gh');
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(['pr', 'create', '--head', 'vanguard/pub', '--base', 'main', '--title', 'PR']),
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
