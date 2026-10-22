import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runApprover } from './approve.js';
import { readBranchFile } from '../core/metrics-branch.js';
import type { GhRunner } from '../tasks/github.js';

let root: string;
let origin: string;
let repo: string;
let headSha: string;
let baseSha: string;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout;
}

const POLICY = {
  schemaVersion: 1,
  enabled: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [{ name: 'build', appId: 15368 }, { name: 'dependency-review', appId: 15368 }],
  reviewAuthors: ['bot'],
  testGlobs: ['**/*.test.ts'],
  pathRules: { 'ci-config': ['.github/**'] },
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0 },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-approve-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  const seed = join(root, 'seed');
  await execa('git', ['init', '--quiet', '-b', 'main', seed]);
  await execa('git', ['-C', seed, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', seed, 'config', 'user.name', 't']);
  await mkdir(join(seed, '.vanguard'), { recursive: true });
  await writeFile(join(seed, '.vanguard', 'approver.json'), JSON.stringify(POLICY));
  await writeFile(join(seed, 'README.md'), 'hello\n');
  await execa('git', ['-C', seed, 'add', '.']);
  await execa('git', ['-C', seed, 'commit', '--quiet', '-m', 'seed']);
  await execa('git', ['-C', seed, 'push', '--quiet', origin, 'main']);
  baseSha = (await git(seed, ['rev-parse', 'HEAD'])).trim();

  await execa('git', ['-C', seed, 'checkout', '--quiet', '-b', 'chore/vanguard-1']);
  await writeFile(join(seed, 'src.ts'), 'export const x = 1;\n');
  await execa('git', ['-C', seed, 'add', '.']);
  await execa('git', ['-C', seed, 'commit', '--quiet', '-m', 'feature']);
  headSha = (await git(seed, ['rev-parse', 'HEAD'])).trim();
  await execa('git', ['-C', seed, 'push', '--quiet', origin, `chore/vanguard-1:refs/pull/1/head`]);

  repo = join(root, 'repo');
  await execa('git', ['clone', '--quiet', origin, repo]);
  await execa('git', ['-C', repo, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', repo, 'config', 'user.name', 't']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reviewBody = (sha: string): string => `## Vanguard Review\n\nVerdict: NO BLOCKING FINDINGS\n\nLooks good.\n\n<!-- vanguard-pr-review: ${sha} -->`;

function fakeGh(calls: string[][]): GhRunner {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return JSON.stringify({ comments: [] });
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({
        number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', isDraft: false,
        headRefName: 'chore/vanguard-1', headRefOid: headSha, baseRefName: 'main', baseRefOid: baseSha,
        headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' },
        reviews: [{ author: { login: 'bot' }, body: reviewBody(headSha), submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED' }],
      });
    }
    if (args[0] === 'api' && args[1]?.includes('check-runs?per_page')) {
      return JSON.stringify({
        check_runs: [
          { name: 'build', conclusion: 'success', app: { id: 15368 } },
          { name: 'dependency-review', conclusion: 'success', app: { id: 15368 } },
        ],
      });
    }
    if (args[0] === 'api' && args[1]?.includes('check-runs?check_name')) return JSON.stringify({ check_runs: [] });
    if (args[0] === 'api') return '{}';
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    return '';
  };
}

const DENY_RE = /(^merge$|^ready$|^edit$|^close$|^reopen$|^review$)/;

describe('runApprover — end to end', () => {
  it('APPROVE on an all-clean factory PR: records once, publishes a check run and a comment, makes no write call', async () => {
    const calls: string[][] = [];
    const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh(calls) });
    expect(record.verdict).toBe('APPROVE');
    expect(record.rulesFired).toEqual([]);

    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text.trim().split('\n')).toHaveLength(1);

    for (const args of calls) {
      if (args[0] === 'pr' && args[1] !== undefined) expect(DENY_RE.test(args[1])).toBe(false);
      expect(args.includes('--add-label')).toBe(false);
      expect(args.includes('--approve')).toBe(false);
    }
  });

  it('idempotence: running twice at the same head leaves one record line', async () => {
    await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
    const repo2 = join(root, 'repo2');
    await execa('git', ['clone', '--quiet', origin, repo2]);
    await execa('git', ['-C', repo2, 'config', 'user.email', 't@t']);
    await execa('git', ['-C', repo2, 'config', 'user.name', 't']);
    await runApprover({ repoPath: repo2, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('ESCALATE when the diff touches a CI-config path', async () => {
    await execa('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'refs/pull/1/head']);
    await execa('git', ['-C', repo, 'checkout', '--quiet', '-b', 'chore/vanguard-1', 'FETCH_HEAD']);
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, '.github', 'workflows', 'x.yml'), 'name: x\n');
    await execa('git', ['-C', repo, 'add', '.']);
    await execa('git', ['-C', repo, 'commit', '--quiet', '-m', 'touch ci']);
    const newHead = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await execa('git', ['-C', repo, 'push', '--quiet', 'origin', `chore/vanguard-1:refs/pull/1/head`, '--force']);
    await execa('git', ['-C', repo, 'checkout', '--quiet', 'main']);

    const gh: GhRunner = async (args: string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return JSON.stringify({ comments: [] });
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 1, isDraft: false, headRefName: 'chore/vanguard-1', headRefOid: newHead,
          baseRefName: 'main', baseRefOid: baseSha, headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' },
          reviews: [{ author: { login: 'bot' }, body: reviewBody(newHead), submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED' }],
        });
      }
      if (args[0] === 'api' && args[1]?.includes('check-runs?per_page')) {
        return JSON.stringify({ check_runs: [{ name: 'build', conclusion: 'success', app: { id: 15368 } }, { name: 'dependency-review', conclusion: 'success', app: { id: 15368 } }] });
      }
      return '{}';
    };
    const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh });
    expect(record.verdict).toBe('ESCALATE');
    expect(record.rulesFired).toContain('path:ci-config');
  });

  it('VANGUARD_APPROVER_STOP gives ESCALATE stopped, recorded, with no diff/ledger collection', async () => {
    process.env.VANGUARD_APPROVER_STOP = '1';
    try {
      const calls: string[][] = [];
      const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh(calls) });
      expect(record.rulesFired).toEqual(['stopped']);
      expect(record.verdict).toBe('ESCALATE');
      expect(calls.some((a) => a[0] === 'api' && a[1]?.includes('check-runs?per_page'))).toBe(false);
    } finally {
      delete process.env.VANGUARD_APPROVER_STOP;
    }
  });

  it('a failed record append still publishes the check run and the comment, then fails loudly', async () => {
    // Reads (fetch) keep working; only the push of the decision record is rejected by the remote.
    await writeFile(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "read-only" >&2\nexit 1\n', { mode: 0o755 });
    const calls: string[][] = [];
    await expect(runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh(calls) })).rejects.toThrow(/decision record/);
    expect(calls.some((a) => a[0] === 'api' && a.includes('POST') && a.includes('repos/o/r/check-runs'))).toBe(true);
    expect(calls.some((a) => a[0] === 'pr' && a[1] === 'comment')).toBe(true);
  });

  it('a failed check run is reported, not swallowed, and the decision is still recorded', async () => {
    const calls: string[][] = [];
    const base = fakeGh(calls);
    const gh: GhRunner = async (args) => {
      if (args.includes('POST')) throw new Error('HTTP 403: Resource not accessible by integration');
      return base(args);
    };
    await expect(runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh })).rejects.toThrow(/check run: HTTP 403/);
    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('a short-circuited decision is keyed by its head SHA, so a new head gets its own record', async () => {
    process.env.VANGUARD_APPROVER_STOP = '1';
    try {
      const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
      expect(record.headSha).toBe(headSha);
      const previous = headSha;
      headSha = 'b'.repeat(40);
      await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
      const lines = (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n');
      expect(lines.map((l) => (JSON.parse(l) as { headSha: string }).headSha)).toEqual([previous, headSha]);
    } finally {
      delete process.env.VANGUARD_APPROVER_STOP;
    }
  });

  it('a stop placeholder does not block the full decision for the same head once the stop is lifted', async () => {
    process.env.VANGUARD_APPROVER_STOP = '1';
    try {
      await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
    } finally {
      delete process.env.VANGUARD_APPROVER_STOP;
    }
    await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]) });
    const lines = (await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { rulesFired: string[] }).rulesFired)).toEqual([['stopped'], []]);
  });

  it('dry-run computes the decision but publishes and records nothing', async () => {
    const { record } = await runApprover({ repoPath: repo, repoSlug: 'o/r', prNumber: 1, mode: 'shadow', gh: fakeGh([]), dryRun: true });
    expect(record.verdict).toBe('APPROVE');
    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text).toBe('');
  });
});
