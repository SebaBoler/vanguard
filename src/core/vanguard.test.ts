import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, prepareContext, runAgent, disposeContext } from './vanguard.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { RunOptions } from './types.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

interface LogEntry {
  obj: Record<string, unknown>;
  msg: string;
}

interface CaptureLogger {
  logger: VanguardLogger;
  entries: LogEntry[];
}

/** A Pino-shaped logger that records every call so tests can assert on emitted lifecycle logs. */
function captureLogger(): CaptureLogger {
  const entries: LogEntry[] = [];
  const record = (obj: Record<string, unknown>, msg: string): void => {
    entries.push({ obj, msg });
  };
  const logger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
  } as unknown as VanguardLogger;
  return { logger, entries };
}

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
      [{ text: 'step 1' }, { text: 'done <promise>COMPLETE</promise>' }],
      { finalText: 'done <promise>COMPLETE</promise>', sessionId: 's1', turns: 2 },
    );
    const opts: RunOptions = {
      taskId: 't1',
      localRepoPath: repo,
      promptTemplate: 'do {{X}}',
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
    const agent = fakeAgent([{ text: 'nothing' }], { finalText: 'nothing', turns: 1 });
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

  it('passes PrepareOptions.reuse to WorktreeManager.create', async () => {
    const wm = new WorktreeManager(repo);
    const spy = vi.spyOn(wm, 'create');
    const { sandbox } = makeSandbox();
    const ctx = await prepareContext({ taskId: 'reuse-test', localRepoPath: repo, sandbox, reuse: true }, { worktrees: wm });
    await disposeContext(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[2]).toEqual({ reuse: true });
  });

  it('keeps the sandbox alive when disposeContext is told to keep it', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const ctx = await prepareContext({ taskId: 'keep', localRepoPath: repo, sandbox }, { worktrees: wm });
    await disposeContext(ctx, { keep: true });
    expect(wasDestroyed()).toBe(false);
  });

  it('reports cacheEfficiency from agent usage', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const agent = fakeAgent([{ text: 'x' }], {
      finalText: 'x',
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 300 },
    });
    const res = await run({ taskId: 'ce', localRepoPath: repo, promptTemplate: 'p', sandbox, agent }, { worktrees: wm });
    expect(res.cacheEfficiency).toBeCloseTo(0.75);
  });

  it('skips copyFileOut and produces no diff when copyBack is false', async () => {
    const wm = new WorktreeManager(repo);
    let copyFileOutCalled = false;
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
      copyFileOut: async (): Promise<void> => {
        copyFileOutCalled = true;
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;

    const agent = fakeAgent([{ text: 'noop' }], { finalText: 'noop', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-false', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, copyBack: false });
    await disposeContext(ctx);

    expect(copyFileOutCalled).toBe(false);
    expect(result.diff).toBeUndefined();
    // Worktree left untouched (clean)
    expect(result.worktreePreserved).toBe(false);
  });

  it('calls copyFileOut and captures a diff when copyBack is undefined (default)', async () => {
    const wm = new WorktreeManager(repo);
    let copyFileOutCalled = false;
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
        copyFileOutCalled = true;
        if (sandboxPath === '/workspace') {
          await mkdir(hostPath, { recursive: true });
          await writeFile(join(hostPath, 'output.txt'), 'created');
        }
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;

    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-default', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(copyFileOutCalled).toBe(true);
    expect(result.diff).toContain('output.txt');
  });

  it('treats copyBack: true the same as the default (copies out, captures a diff)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(hostPath, { recursive: true });
      await writeFile(join(hostPath, 'output.txt'), 'created');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-true', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, copyBack: true });
    await disposeContext(ctx);

    expect(result.diff).toContain('output.txt');
  });

  function sessionTrackingSandbox(sessionCopyOut: () => void): IsolatedSandboxProvider {
    return {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> =>
        command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
      execStream: () => ({ stdout: (async function* () {})(), result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
        if (sandboxPath === '/workspace') {
          await mkdir(hostPath, { recursive: true });
          return;
        }
        sessionCopyOut(); // a session-jsonl copy was attempted
        throw new Error('no such file');
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;
  }

  it('does not attempt session capture for a non-Claude provider (codex reports a sessionId but writes no jsonl)', async () => {
    const wm = new WorktreeManager(repo);
    let captureAttempted = false;
    const sandbox = sessionTrackingSandbox(() => { captureAttempted = true; });
    const agent: AgentProvider = {
      name: 'codex',
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'reviewed', turns: 1, sessionId: 'codex-thread-1' };
      },
    };
    const ctx = await prepareContext({ taskId: 'cap-skip', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.finalText).toBe('reviewed');
    expect(captureAttempted).toBe(false); // skipped by provider, not attempted-and-swallowed
  });

  it('does not fail a claude-family stage when session capture fails (non-fatal, attempted)', async () => {
    const wm = new WorktreeManager(repo);
    let captureAttempted = false;
    const sandbox = sessionTrackingSandbox(() => { captureAttempted = true; });
    const agent: AgentProvider = {
      name: 'claude-code',
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'done', turns: 1, sessionId: 's1' };
      },
    };
    const ctx = await prepareContext({ taskId: 'cap-warn', localRepoPath: repo, sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.finalText).toBe('done');
    expect(captureAttempted).toBe(true); // claude-family: capture is attempted, failure caught and warned
  });

  it('emits a stage complete info log carrying metric fields and no secret content', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const { logger, entries } = captureLogger();
    const agent = fakeAgent([{ text: 'secret model output' }], {
      finalText: 'secret model output',
      turns: 1,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 },
      costUsd: 0.01,
    });
    const ctx = await prepareContext(
      { taskId: 'log-1', localRepoPath: repo, sandbox, logger },
      { worktrees: wm },
    );
    await runAgent(ctx, { promptTemplate: 'p', agent, stageName: 'implementer' });
    await disposeContext(ctx);

    expect(entries.some((e) => e.msg === 'run start')).toBe(true);
    const start = entries.find((e) => e.msg === 'stage start');
    expect(start?.obj.stage).toBe('implementer');

    const complete = entries.find((e) => e.msg === 'stage complete');
    expect(complete).toBeDefined();
    expect(complete?.obj).toHaveProperty('durationMs');
    expect(complete?.obj).toHaveProperty('costUsd');
    expect(complete?.obj.stage).toBe('implementer');
    // SECRET SAFETY: stage-complete must never carry model output / prompt content.
    expect(complete?.obj).not.toHaveProperty('finalText');
    expect(complete?.obj).not.toHaveProperty('diff');
    expect(complete?.obj).not.toHaveProperty('transcript');
    expect(JSON.stringify(complete?.obj)).not.toContain('secret model output');
  });
});
