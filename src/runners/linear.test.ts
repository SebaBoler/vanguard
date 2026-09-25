import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./source-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source-adapter.js')>()),
  runSourcedIssue: vi.fn(async () => ({ task: { id: 'ENG-1' } })),
}));
vi.mock('../tasks/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tasks/github.js')>()),
  addPrFailureLabel: vi.fn(async () => {}),
}));

import { runSourcedIssue } from './source-adapter.js';
import { addPrFailureLabel } from '../tasks/github.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { GITHUB_VERIFY_FAILED_LABEL } from '../github-labels.js';
import { linearAdapter, runLinearIssue } from './linear.js';
import type { RunLinearIssueDeps } from './linear.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { StageOutcome } from '../pipeline/pipeline.js';

function makeDeps(overrides: Partial<RunLinearIssueDeps> = {}): RunLinearIssueDeps {
  return { repoPath: '/repo', linearKey: 'lin_key', skillsDir: '/skills', ...overrides };
}

function makeGlab(): { glab: GlabRunner; calls: string[][] } {
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => { calls.push(args); return ''; };
  return { calls, glab };
}

function reviewerOutcome(finalText: string): StageOutcome {
  return {
    name: 'reviewer',
    result: { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/tmp/wt', worktreePreserved: true, finalText },
  };
}

beforeEach(() => {
  vi.mocked(runSourcedIssue).mockClear();
  vi.mocked(addPrFailureLabel).mockClear();
});

describe('linearAdapter on a GitLab remote', () => {
  it('opens the MR with glab and posts the verdict as a GitLab MR note', async () => {
    const { calls, glab } = makeGlab();
    const adapter = linearAdapter(makeDeps(), 'group/project', glab);
    expect(adapter.reviewCli).toBe('glab');

    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: reviewerOutcome('No blocking findings.'),
      attribution: 'claude',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 6)).toEqual(['mr', 'note', 'create', '7', '--repo', 'group/project']);
    expect(calls[0]?.at(-1)).toContain('<!-- vanguard-mr-review: abcdef1234567890 -->');
  });

  it('labels a failed proof on the MR with the GitLab scoped label', async () => {
    const { calls, glab } = makeGlab();
    const adapter = linearAdapter(makeDeps(), 'group/project', glab);
    await adapter.addFailureLabel('https://gitlab.com/group/project/-/merge_requests/7', 'verify');
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::verify-failed'],
      ['mr', 'update', '7', '--repo', 'group/project', '--label', 'vanguard::verify-failed'],
    ]);
    expect(addPrFailureLabel).not.toHaveBeenCalled();
  });
});

describe('linearAdapter on a GitHub remote', () => {
  it('keeps the gh PR, the GitHub PR review and the GitHub failure label', async () => {
    const adapter = linearAdapter(makeDeps());
    expect('reviewCli' in adapter).toBe(false);
    expect(adapter.publishVerdict).toBe(publishReviewVerdict);

    await adapter.addFailureLabel('https://github.com/owner/repo/pull/3', 'verify');
    expect(addPrFailureLabel).toHaveBeenCalledWith('/repo', 'https://github.com/owner/repo/pull/3', GITHUB_VERIFY_FAILED_LABEL);
  });
});

describe('runLinearIssue review surface', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vanguard-linear-'));
    await execa('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function adapterFor(origin: string | undefined): Promise<ReturnType<typeof linearAdapter>> {
    if (origin !== undefined) await execa('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    await runLinearIssue('ENG-1', makeDeps({ repoPath: repo }));
    const adapter = vi.mocked(runSourcedIssue).mock.calls[0]?.[2];
    if (adapter === undefined) throw new Error('runSourcedIssue was not called');
    return adapter;
  }

  it('picks glab when origin is a GitLab remote', async () => {
    const adapter = await adapterFor('git@gitlab.com:group/project.git');
    expect(adapter.reviewCli).toBe('glab');
    expect(adapter.publishVerdict).not.toBe(publishReviewVerdict);
  });

  it('keeps the GitHub path when origin is a GitHub remote', async () => {
    const adapter = await adapterFor('https://github.com/owner/repo.git');
    expect('reviewCli' in adapter).toBe(false);
    expect(adapter.publishVerdict).toBe(publishReviewVerdict);
  });

  it('keeps the GitHub path when there is no origin remote', async () => {
    const adapter = await adapterFor(undefined);
    expect('reviewCli' in adapter).toBe(false);
  });
});
