import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, prepareContext, runAgent, disposeContext } from './vanguard.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { RunOptions } from './types.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-orch-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

interface FakeSandbox {
  sandbox: IsolatedSandboxProvider;
  wasDestroyed: () => boolean;
}

function makeSandbox(onWorkdirCopyOut?: (hostPath: string) => Promise<void>): FakeSandbox {
  let destroyed = false;
  const sandbox = {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> => {
      if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    execStream: () => ({
      stdout: (async function* () {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace' && onWorkdirCopyOut) await onWorkdirCopyOut(hostPath);
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {
      destroyed = true;
    },
  } as unknown as IsolatedSandboxProvider;
  return { sandbox, wasDestroyed: () => destroyed };
}

function fakeAgent(turns: AgentTurn[], output: AgentRunOutput): AgentProvider {
  return {
    name: 'fake',
    async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      for (const turn of turns) yield turn;
      return output;
    },
  };
}

describe('vanguard.run', () => {
  it('completes on the termination signal and preserves a dirty worktree', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox(async (hostPath) => {
      await mkdir(hostPath, { recursive: true });
      await writeFile(join(hostPath, 'result.txt'), 'done');
    });
    const agent = fakeAgent(
      [{ text: 'krok 1' }, { text: 'zrobione <promise>COMPLETE</promise>' }],
      { finalText: 'zrobione <promise>COMPLETE</promise>', sessionId: 's1', turns: 2 },
    );
    const opts: RunOptions = {
      taskId: 't1',
      localRepoPath: repo,
      promptTemplate: 'zrób {{X}}',
      variables: { X: 'to' },
      sandbox,
      agent,
    };
    const res = await run(opts, { worktrees: wm });
    expect(res.completed).toBe(true);
    expect(res.exitReason).toBe('completed');
    expect(res.turns).toBe(2);
    expect(res.sessionId).toBe('s1');
    expect(res.worktreePreserved).toBe(true);
    expect(res.diff).toContain('result.txt');
    expect(wasDestroyed()).toBe(true);
  });

  it('removes a clean worktree and reports not-completed', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const agent = fakeAgent([{ text: 'nic' }], { finalText: 'nic', turns: 1 });
    const res = await run(
      { taskId: 't2', localRepoPath: repo, promptTemplate: 'x', sandbox, agent },
      { worktrees: wm },
    );
    expect(res.completed).toBe(false);
    expect(res.exitReason).toBe('incomplete');
    expect(res.worktreePreserved).toBe(false);
    expect(wasDestroyed()).toBe(true);
  });

  it('reuses one context across multiple agent stages (R11)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const ctx = await prepareContext({ taskId: 't3', localRepoPath: repo, sandbox }, { worktrees: wm });
    const a1 = await runAgent(ctx, {
      promptTemplate: 'a',
      agent: fakeAgent([{ text: 'one' }], { finalText: 'one', turns: 1, sessionId: 's' }),
    });
    const a2 = await runAgent(ctx, {
      promptTemplate: 'b',
      agent: fakeAgent([{ text: 'two' }], { finalText: 'two', turns: 1, sessionId: 's' }),
      resumeSessionId: 's',
    });
    expect(a1.turns).toBe(1);
    expect(a2.turns).toBe(1);
    expect(wasDestroyed()).toBe(false);
    await disposeContext(ctx);
    expect(wasDestroyed()).toBe(true);
  });
});
