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
vi.mock('./preflight.js', () => ({
  runPreflight: vi.fn(async () => ({ ok: true, checks: [] })),
  formatPreflightReport: vi.fn(() => []),
}));
vi.mock('./provider-choice.js', () => ({ loadProviderChoice: vi.fn(async () => ({})) }));

import { watchLinear, watchGithub, watchGithubProject, watchGitlab, watchLinearLoopV1, watchGithubLoopV1, watchGitlabLoopV1 } from '../runners/watch.js';
import {
  buildGithubDeps,
  specOnlyReviewNote,
  watchCommand as runWatchCommand,
  watchLinearSource,
  watchGithubSource,
  watchGithubProjectSource,
  watchGitlabSource,
} from './watch.js';
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
    ['project', { source: 'project', projectNumber: 7 }, watchGithubProjectSource, '--spec-only is not supported with --source project'],
  ] as const)('%s: specOnly without the spec trigger throws instead of running the single-pass watch', async (_name, single, source, message) => {
    vi.stubEnv('LINEAR_API_KEY', 'key');
    await expect(source(watchCommand({ ...single, specOnly: true }), undefined, ctx, signal)).rejects.toThrow(message);

    expect(watchLinear).not.toHaveBeenCalled();
    expect(watchGithub).not.toHaveBeenCalled();
    expect(watchGitlab).not.toHaveBeenCalled();
    expect(watchGithubProject).not.toHaveBeenCalled();
  });
});

describe('specOnlyReviewNote', () => {
  it.each([
    ['github', { source: 'github', agentLabel: 'spec review', specOnly: true }, 'spec review'],
    ['gitlab', { source: 'gitlab', agentLabel: 'ready for agent', specOnly: true }, 'ready for agent'],
  ] as const)('%s: names the label specced issues get and that the build job must not trigger on it', (_name, overrides, label) => {
    expect(specOnlyReviewNote(watchCommand(overrides))).toBe(
      `watch: --spec-only moves specced issues to label "${label}". For a review window the build job must not trigger on it.`,
    );
  });

  it('linear: names the state in effect and both state-type rules', () => {
    const note = specOnlyReviewNote(watchCommand({ source: 'linear', agentState: 'Spec Review', specOnly: true }));
    expect(note).toContain('moves specced issues to state "Spec Review"');
    expect(note).toContain('must differ from the --spec-state type, or the spec pass specs them again on every poll');
    expect(note).toContain("the build job's trigger type (unstarted by default), or there is no review window");
  });

  it('linear: falls back to the default Todo state', () => {
    expect(specOnlyReviewNote(watchCommand({ source: 'linear', specOnly: true }))).toContain('moves specced issues to state "Todo"');
  });

  it('stays quiet without --spec-only', () => {
    expect(specOnlyReviewNote(watchCommand({ source: 'github', agentLabel: 'ready for agent' }))).toBeUndefined();
  });
});

describe('watchCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prints the spec-only review note before it dispatches to the source', async () => {
    vi.stubEnv('LINEAR_API_KEY', 'key');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'token');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // watchCommand registers SIGINT/SIGTERM handlers it never removes; keep them off the test worker.
    const once = vi.spyOn(process, 'once').mockImplementation(() => process);
    try {
      await runWatchCommand(
        watchCommand({
          source: 'linear',
          skillsDir: '/skills',
          specState: 'triage',
          specStateName: 'Spec',
          needsInfoState: 'Needs Info',
          agentState: 'Spec Review',
          specOnly: true,
        }),
      );

      const note = log.mock.calls.findIndex(([line]) => String(line).startsWith('watch: --spec-only moves specced issues to state "Spec Review"'));
      expect(note).toBeGreaterThanOrEqual(0);
      expect(log.mock.invocationCallOrder[note]).toBeLessThan(vi.mocked(watchLinearLoopV1).mock.invocationCallOrder[0]!);
      expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    } finally {
      log.mockRestore();
      once.mockRestore();
    }
  });
});
