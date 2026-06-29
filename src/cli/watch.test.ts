import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import { watchLinear, watchGitlab } from '../runners/watch.js';
import { buildGithubDeps, watchLinearSource, watchGitlabSource } from './watch.js';
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
