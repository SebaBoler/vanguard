import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the runners so the dispatch builders construct deps without doing real work. We capture the
// deps each builder hands to its runner and assert the RunOptions fields survived the threading —
// the type system cannot, because the *Deps are wider structural types than RunOptions, so a future
// edit dropping `...pickRunOptions(cmd)` would otherwise ship green.
vi.mock('../runners/github.js', () => ({
  githubDepsFromEnv: vi.fn(async (repoPath: string, repoSlug: string) => ({ repoPath, repoSlug })),
  runGithubIssue: vi.fn(async () => ({ task: { id: 'gh-1' }, prUrl: 'pr-url' })),
  runGithubProject: vi.fn(async () => ({ tasks: [], outcomes: [] })),
}));
vi.mock('../runners/gitlab.js', () => ({
  gitlabDepsFromEnv: vi.fn(async (repoPath: string, project: string) => ({ repoPath, project })),
  runGitlabIssue: vi.fn(async () => ({ task: { id: 'gl-1' }, prUrl: 'mr-url' })),
}));
vi.mock('../runners/linear.js', () => ({
  runLinearIssue: vi.fn(async () => ({ task: { id: 'lin-1' }, prUrl: 'pr-url' })),
  runLinearParent: vi.fn(async () => ({ parent: { id: 'p', title: 't', children: [] }, outcomes: [] })),
}));

import { runGithubIssue, runGithubProject } from '../runners/github.js';
import { runGitlabIssue } from '../runners/gitlab.js';
import { linearDeps, runGithub, runGitlab, runProject } from './run.js';
import { RUN_OPTIONS } from './run-options.fixture.js';
import type { Command } from './args.js';

type RunCommand = Extract<Command, { kind: 'run' }>;

function runCommand(overrides: Partial<RunCommand> = {}): RunCommand {
  return {
    kind: 'run',
    source: 'github',
    id: '42',
    parent: false,
    gcBefore: false,
    egress: false,
    repoPath: '/repo',
    concurrency: 2,
    ...RUN_OPTIONS,
    ...overrides,
  } as RunCommand;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('run deps builders thread RunOptions', () => {
  it('linearDeps carries every option field', () => {
    process.env.LINEAR_API_KEY = 'key';
    const cmd = runCommand({ source: 'linear', skillsDir: '/skills' });
    const deps = linearDeps(cmd, undefined, undefined, undefined, undefined);
    expect(deps).toMatchObject(RUN_OPTIONS);
  });

  it('runGithub carries every option field', async () => {
    await runGithub(runCommand(), undefined, undefined, undefined);
    const deps = vi.mocked(runGithubIssue).mock.calls[0]![1];
    expect(deps).toMatchObject(RUN_OPTIONS);
  });

  it('runGitlab carries every option field', async () => {
    await runGitlab(runCommand({ source: 'gitlab', project: 'g/p' }), undefined, undefined, undefined);
    const deps = vi.mocked(runGitlabIssue).mock.calls[0]![1];
    expect(deps).toMatchObject(RUN_OPTIONS);
  });

  // AC-5 / T4: runProject silently dropped conformance/conformanceModel before this refactor.
  it('runProject carries every option field, including conformance', async () => {
    await runProject(runCommand({ source: 'project' }), undefined, undefined, undefined);
    const deps = vi.mocked(runGithubProject).mock.calls[0]![0];
    expect(deps).toMatchObject(RUN_OPTIONS);
  });
});
