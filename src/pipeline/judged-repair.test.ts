import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runJudgedRepair } from './judged-repair.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { PipelineStage } from './pipeline.js';
import type { Judge, EvalVerdict } from '../evals/types.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-hitl-'));
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
        await writeFile(join(hostPath, 'work.txt'), 'x');
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function agentReturning(finalText: string): AgentProvider {
  return {
    name: 'fake',
    async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      return { finalText, turns: 1, sessionId: 's' };
    },
  };
}

const generate: PipelineStage = { name: 'generator', promptTemplate: 'gen' };
const repair: PipelineStage = { name: 'repairer', promptTemplate: 'fix {{JUDGE_REASON}}' };

function judgeReject(times: number): Judge {
  let n = 0;
  return {
    judge: async (): Promise<EvalVerdict> => {
      n += 1;
      return n <= times ? { passed: false, score: 0, reason: 'nope' } : { passed: true, score: 1, reason: 'ok' };
    },
  };
}

describe('runJudgedRepair', () => {
  it('freezes to needs_human after 3 consecutive rejects, leaving a shell command', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'h1', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const result = await runJudgedRepair(ctx, { agent: agentReturning('done'), generate, repair, judge: judgeReject(99) });
    expect(result.status).toBe('frozen');
    if (result.status === 'frozen') {
      expect(result.reason).toBe('needs_human');
      expect(result.shellCommand).toContain('docker exec -it');
      expect(result.outcomes).toHaveLength(3); // generate + 2 repairs before the 3rd reject
    }
    await disposeContext(ctx, { keep: true });
  });

  it('completes when the judge passes within the reject budget', async () => {
    const wm = new WorktreeManager(repo);
    const ctx = await prepareContext({ taskId: 'h2', localRepoPath: repo, sandbox: makeSandbox() }, { worktrees: wm });
    const result = await runJudgedRepair(ctx, { agent: agentReturning('done'), generate, repair, judge: judgeReject(1) });
    expect(result.status).toBe('completed');
    await disposeContext(ctx);
  });
});
