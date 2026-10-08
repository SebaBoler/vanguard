import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { WorktreeManager } from '../worktree/manager.js';
import { deliverChange } from './deliver-change.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-deliver-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** A sandbox whose copy-out writes `content` into feature.txt (undefined = the agent changed nothing). */
function makeSandbox(content?: string): IsolatedSandboxProvider {
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    execStream: () => ({ stdout: (async function* (): AsyncIterable<string> {})(), result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace' && content !== undefined) {
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, 'feature.txt'), content);
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
  } as unknown as IsolatedSandboxProvider;
}

async function withWork(content: string | undefined, run: (ctx: Awaited<ReturnType<typeof prepareContext>>) => Promise<void>): Promise<void> {
  const ctx = await prepareContext({ taskId: 'dc', localRepoPath: repo, sandbox: makeSandbox(content) }, { worktrees: new WorktreeManager(repo) });
  try {
    // Simulate the stage sync: write what the sandbox "produced" into the worktree.
    if (content !== undefined) await writeFile(join(ctx.worktreePath, 'feature.txt'), content);
    await run(ctx);
  } finally {
    await disposeContext(ctx);
  }
}

describe('deliverChange', () => {
  it('blocks on a secret in the outgoing diff before anything is committed or pushed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[][] = [];
    try {
      await withWork('token = "ghp_' + 'A'.repeat(40) + '"', async (ctx) => {
        const r = await deliverChange(ctx, {
          taskId: 'T-1',
          commitMessage: 'feat: x',
          target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
        });
        expect(r.kind).toBe('secret-blocked');
        expect((await execa('git', ['log', '--oneline'], { cwd: ctx.worktreePath })).stdout.split('\n')).toHaveLength(1); // only init
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it('reports no-changes when the worktree is clean and pushes nothing', async () => {
    const calls: string[][] = [];
    await withWork(undefined, async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'T-1',
        commitMessage: 'feat: x',
        target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
      });
      expect(r.kind).toBe('no-changes');
    });
    expect(calls).toEqual([]);
  });

  it('existing-branch: commits with the given identity and pushes HEAD onto the PR head', async () => {
    const calls: string[][] = [];
    await withWork('work', async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'T-1',
        commitMessage: 'fix: address review feedback',
        commitAuthor: { name: 'Acme Bot', email: 'bot@acme.test' },
        target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
      });
      expect(r.kind).toBe('delivered');
      if (r.kind !== 'delivered') return;
      expect(r.headSha).toBe(r.sha);
      expect(r.prUrl).toBeUndefined();
      const log = (await execa('git', ['log', '-1', '--format=%an <%ae> %s'], { cwd: ctx.worktreePath })).stdout;
      expect(log).toBe('Acme Bot <bot@acme.test> fix: address review feedback');
    });
    expect(calls.some((a) => a[0] === 'push' && a.includes('HEAD:pr-head'))).toBe(true);
  });

  it('new-pr: builds the body after the commit with the closing-keyword leaks, pushes, opens the PR and reports the pushed head', async () => {
    const calls: string[][] = [];
    await withWork('work', async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'o/r#7',
        commitMessage: 'feat: thing\n\nCloses #7',
        closingKeywordBase: 'main',
        target: {
          kind: 'new-pr',
          title: 'thing (o/r#7)',
          draft: true,
          body: ({ commitLeaks }) => `Part of #7\n\nleaks=${commitLeaks.length}`,
          runner: async (file, a) => {
            calls.push([file, ...a]);
            if (file === 'gh') return 'https://github.com/o/r/pull/9';
            if (a[0] === 'rev-parse') return 'rebasedhead';
            return '';
          },
        },
      });
      expect(r.kind).toBe('delivered');
      if (r.kind !== 'delivered') return;
      expect(r.prUrl).toBe('https://github.com/o/r/pull/9');
      expect(r.headSha).toBe('rebasedhead');
      expect(r.commitLeaks.length).toBeGreaterThan(0);
    });
    const gh = calls.find((c) => c[0] === 'gh');
    expect(gh?.[gh.indexOf('--body') + 1]).toMatch(/leaks=[1-9]/);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(true);
  });
});
