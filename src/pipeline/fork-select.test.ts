import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import type { RunContext } from '../core/vanguard.js';
import { forkAndSelect } from './fork-select.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { PipelineStage } from './pipeline.js';
import type { EvalVerdict } from '../evals/types.js';
import type { RunResult } from '../core/types.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-fork-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const fakeExec = async (command: string): Promise<ExecResult> =>
  command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 };

const fakeExecStream = () => ({
  stdout: (async function* (): AsyncIterable<string> {})(),
  result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
});

/** Sandbox that writes variant-<n>.txt on the n-th /workspace copyFileOut call. */
function makeSandbox(): IsolatedSandboxProvider {
  let wsCallCount = 0;
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: fakeExec,
    execStream: fakeExecStream,
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace') {
        const idx = wsCallCount++;
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, `variant-${idx}.txt`), `content-${idx}`);
      }
    },
    exists: async (): Promise<boolean> => false,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function makeNoopSandbox(): IsolatedSandboxProvider {
  return {
    id: 'fake-noop',
    start: async (): Promise<void> => {},
    exec: fakeExec,
    execStream: fakeExecStream,
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (): Promise<void> => {},
    exists: async (): Promise<boolean> => false,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function makeAgent(): AgentProvider {
  return {
    name: 'fake',
    async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: 'sess' };
    },
  };
}

const stage: PipelineStage = { name: 'implementer', promptTemplate: 'Task: {{TITLE}}' };
const FORK_SELECT_TEST_TIMEOUT_MS = 15_000;

/** Returns a score function that assigns scores in order of calls. */
function makeScorer(scores: number[]): (diff: string, result: RunResult) => Promise<EvalVerdict> {
  let call = 0;
  return async (): Promise<EvalVerdict> => {
    const s = scores[call++] ?? 0;
    return { passed: s >= 0.5, score: s, reason: `score ${s}` };
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withCtx(
  taskId: string,
  sandbox: IsolatedSandboxProvider,
  fn: (ctx: RunContext) => Promise<void>,
): Promise<void> {
  const wm = new WorktreeManager(repo);
  const ctx = await prepareContext({ taskId, localRepoPath: repo, sandbox }, { worktrees: wm });
  try {
    await fn(ctx);
  } finally {
    await disposeContext(ctx);
  }
}

describe('forkAndSelect', () => {
  it('returns a single variant when n=1', async () => {
    await withCtx('fs-n1', makeSandbox(), async (ctx) => {
      const result = await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 1, score: makeScorer([0.7]) });
      expect(result.variants).toHaveLength(1);
      expect(result.winnerIndex).toBe(0);
      expect(result.winner.completed).toBe(true);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('picks the highest-scoring variant (winner is not the last run)', async () => {
    await withCtx('fs-best', makeSandbox(), async (ctx) => {
      // scores: [0.3, 0.9, 0.5] → winner is index 1
      const result = await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 3, score: makeScorer([0.3, 0.9, 0.5]) });
      expect(result.variants).toHaveLength(3);
      expect(result.winnerIndex).toBe(1);
      expect(result.variants[1]!.verdict.score).toBe(0.9);
      expect(result.winner).toBe(result.variants[1]!.result);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('applies the winner diff to the worktree when winner is not the last variant', async () => {
    await withCtx('fs-apply', makeSandbox(), async (ctx) => {
      // winner is index 1 (middle), so its diff must be re-applied after the last variant ran
      await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 3, score: makeScorer([0.3, 0.9, 0.5]) });
      // variant-1.txt should be present (winner's change applied)
      expect(await exists(join(ctx.worktreePath, 'variant-1.txt'))).toBe(true);
      // variant-2.txt should NOT be present (last variant's changes were reset)
      expect(await exists(join(ctx.worktreePath, 'variant-2.txt'))).toBe(false);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('does not re-apply when the last variant is the winner', async () => {
    await withCtx('fs-last', makeSandbox(), async (ctx) => {
      // scores: [0.2, 0.8] → winner is index 1 (last)
      const result = await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 2, score: makeScorer([0.2, 0.8]) });
      expect(result.winnerIndex).toBe(1);
      // variant-1.txt (last variant's output) should be present
      expect(await exists(join(ctx.worktreePath, 'variant-1.txt'))).toBe(true);
      // variant-0.txt was reset before the last variant ran
      expect(await exists(join(ctx.worktreePath, 'variant-0.txt'))).toBe(false);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('breaks ties in favor of the earliest variant', async () => {
    await withCtx('fs-tie', makeSandbox(), async (ctx) => {
      const result = await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 3, score: makeScorer([0.7, 0.7, 0.7]) });
      expect(result.winnerIndex).toBe(0);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('handles winner with no diff without calling git apply', async () => {
    await withCtx('fs-nodiff', makeNoopSandbox(), async (ctx) => {
      // scores: [0.8, 0.2] → winner is index 0 (not the last), but it has no diff
      const result = await forkAndSelect(ctx, stage, { agent: makeAgent(), n: 2, score: makeScorer([0.8, 0.2]) });
      expect(result.winnerIndex).toBe(0);
      expect(result.winner.diff).toBeUndefined();
      // Worktree should still be at HEAD (no changes applied)
      expect(await exists(join(ctx.worktreePath, 'variant-0.txt'))).toBe(false);
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);

  it('passes forkFromSessionId as resumeSessionId with forkSession: true', async () => {
    const received: AgentRunInput[] = [];
    const recordingAgent: AgentProvider = {
      name: 'rec',
      async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        received.push(input);
        return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: 'fork-sess' };
      },
    };
    await withCtx('fs-fork', makeSandbox(), async (ctx) => {
      await forkAndSelect(ctx, stage, {
        agent: recordingAgent,
        n: 2,
        forkFromSessionId: 'base-session-id',
        score: makeScorer([0.5, 0.5]),
      });
      expect(received).toHaveLength(2);
      for (const input of received) {
        expect(input.resumeSessionId).toBe('base-session-id');
        expect(input.forkSession).toBe(true);
      }
    });
  }, FORK_SELECT_TEST_TIMEOUT_MS);
});
