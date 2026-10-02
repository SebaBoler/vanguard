import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the watch runners so the deps builders run without entering a real poll loop. We capture the
// deps each builder produces and assert the RunOptions fields survived — a guard the type system
// cannot provide, since the *Deps are wider structural types than RunOptions.
vi.mock('../runners/watch.js', () => ({
  watchLinear: vi.fn(async () => {}),
  watchLinearLoopV1: vi.fn(async () => {}),
  watchGithub: vi.fn(async () => {}),
  watchGithubLoopV1: vi.fn(async () => {}),
  watchGithubProject: vi.fn(async () => {}),
  watchGitlab: vi.fn(async () => {}),
  watchGitlabLoopV1: vi.fn(async () => {}),
}));
vi.mock('../runners/github.js', () => ({
  githubDepsFromEnv: vi.fn(async (repoPath: string, repoSlug: string) => ({ repoPath, repoSlug })),
}));
vi.mock('../runners/gitlab.js', () => ({
  gitlabDepsFromEnv: vi.fn(async (repoPath: string, project: string) => ({ repoPath, project })),
}));

import { watchLinear, watchGithub, watchGitlab, watchLinearLoopV1, watchGithubLoopV1, watchGitlabLoopV1 } from '../runners/watch.js';
import { buildGithubDeps, watchLinearSource, watchGithubSource, watchGitlabSource } from './watch.js';
import { RUN_OPTIONS } from './run-options.fixture.js';
import type { Command } from './args.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;

function watchCommand(overrides: Partial<WatchCommand> = {}): WatchCommand {
  return {
    kind: 'watch',
    source: 'github',
    label: 'agent',
    repoPath: '/repo',
    concurrency: 2,
    intervalMs: 1000,
    once: true,
    egress: false,
    ...RUN_OPTIONS,
    ...overrides,
  } as WatchCommand;
}

const ctx = { destroy: async () => {} } as SandboxContext;
const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('watch deps builders thread RunOptions', () => {
  it('watchLinearSource carries every option field', async () => {
    process.env.LINEAR_API_KEY = 'key';
    await watchLinearSource(watchCommand({ source: 'linear', skillsDir: '/skills' }), undefined, ctx, signal);
    const deps = vi.mocked(watchLinear).mock.calls[0]![0].deps;
    expect(deps).toMatchObject(RUN_OPTIONS);
  });

  it('buildGithubDeps carries every option field', async () => {
    const deps = await buildGithubDeps(watchCommand(), undefined, ctx);
    expect(deps).toMatchObject(RUN_OPTIONS);
  });

  it('watchGitlabSource carries every option field', async () => {
    await watchGitlabSource(watchCommand({ source: 'gitlab', project: 'g/p' }), undefined, ctx, signal);
    const deps = vi.mocked(watchGitlab).mock.calls[0]![0].deps;
    expect(deps).toMatchObject(RUN_OPTIONS);
  });
});

describe('loop-v1 sources pass --spec-only to the loop', () => {
  const linearLoop = { source: 'linear', skillsDir: '/skills', specState: 'triage', specStateName: 'Spec', needsInfoState: 'Needs Info' } as const;
  const githubLoop = { source: 'github', specLabel: 'ready for spec', agentLabel: 'ready for agent', needsInfoLabel: 'needs info' } as const;
  const gitlabLoop = { ...githubLoop, source: 'gitlab', project: 'g/p' } as const;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['linear', linearLoop, watchLinearSource, watchLinearLoopV1],
    ['github', githubLoop, watchGithubSource, watchGithubLoopV1],
    ['gitlab', gitlabLoop, watchGitlabSource, watchGitlabLoopV1],
  ] as const)('%s: specOnly reaches the loop, and is absent without the flag', async (_name, loop, source, runner) => {
    vi.stubEnv('LINEAR_API_KEY', 'key');
    await source(watchCommand({ ...loop, specOnly: true }), undefined, ctx, signal);
    await source(watchCommand(loop), undefined, ctx, signal);

    const calls = vi.mocked(runner).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ once: true, specOnly: true });
    expect('specOnly' in calls[1]![0]).toBe(false);
  });

  it.each([
    ['linear', { source: 'linear', skillsDir: '/skills' }, watchLinearSource, '--spec-state is required with --spec-only for linear loop-v1'],
    ['github', { source: 'github' }, watchGithubSource, '--spec-label is required with --spec-only for github loop-v1'],
    ['gitlab', { source: 'gitlab', project: 'g/p' }, watchGitlabSource, '--spec-label is required with --spec-only for gitlab loop-v1'],
  ] as const)('%s: specOnly without the spec trigger throws instead of running the single-pass watch', async (_name, single, source, message) => {
    vi.stubEnv('LINEAR_API_KEY', 'key');
    await expect(source(watchCommand({ ...single, specOnly: true }), undefined, ctx, signal)).rejects.toThrow(message);

    expect(watchLinear).not.toHaveBeenCalled();
    expect(watchGithub).not.toHaveBeenCalled();
    expect(watchGitlab).not.toHaveBeenCalled();
  });
});
