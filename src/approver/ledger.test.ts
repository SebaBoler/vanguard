import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { DECISIONS_FILE, moduleOf, readLedger } from './ledger.js';
import { appendBranchLines } from '../core/metrics-branch.js';
import type { ApproverPolicy } from './types.js';

const policy: ApproverPolicy = {
  schemaVersion: 1,
  enabled: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [],
  reviewAuthors: [],
  testGlobs: ['**/*.test.ts'],
  pathRules: {},
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0 },
};

const NOW = new Date('2026-10-22T12:00:00.000Z');

let root: string;
let repo: string;

interface SeedRecord {
  prNumber: number;
  verdict?: string;
  timestamp?: string;
  lines?: number;
  paths?: string[];
}

function decision(r: SeedRecord): string {
  return JSON.stringify({
    prNumber: r.prNumber,
    headSha: `sha${r.prNumber}`,
    verdict: r.verdict ?? 'APPROVE',
    timestamp: r.timestamp ?? '2026-10-21T12:00:00.000Z',
    signals: { lines: r.lines ?? 0, paths: r.paths ?? [] },
  });
}

async function seed(lines: string[]): Promise<void> {
  await appendBranchLines(repo, lines, { file: DECISIONS_FILE, key: (rec) => `${String(rec.prNumber)}:${String(rec.headSha)}` });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-ledger-'));
  const origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  repo = join(root, 'repo');
  await execa('git', ['init', '--quiet', '-b', 'main', repo]);
  await execa('git', ['-C', repo, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', repo, 'config', 'user.name', 't']);
  await execa('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('moduleOf', () => {
  it.each([
    ['src/approver/rules.ts', 'src/approver'],
    ['src/approver/nested/deep.ts', 'src/approver'],
    // A file directly under src/ is its own module — there is no shared directory to pool it with.
    ['src/index.ts', 'src/index.ts'],
    ['docs/approver-policy.md', 'docs'],
    ['README.md', '(root)'],
    ['src', '(root)'],
  ])('%s -> %s', (path, expected) => {
    expect(moduleOf(path)).toBe(expected);
  });
});

describe('readLedger', () => {
  it('is empty when the metrics branch does not exist yet', async () => {
    expect(await readLedger({ repoPath: repo, policy, now: NOW, prNumber: 1, touchedPaths: ['src/approver/rules.ts'] })).toEqual({});
  });

  it('sums APPROVE lines per module, for the modules this PR touches only', async () => {
    await seed([
      decision({ prNumber: 10, lines: 40, paths: ['src/approver/rules.ts', 'src/approver/facts.ts'] }),
      decision({ prNumber: 11, lines: 25, paths: ['src/approver/policy.ts'] }),
      decision({ prNumber: 12, lines: 90, paths: ['src/cli/args.ts'] }),
    ]);
    expect(await readLedger({ repoPath: repo, policy, now: NOW, prNumber: 1, touchedPaths: ['src/approver/ledger.ts'] })).toEqual({
      // 40 counts once per record, not once per path in it.
      'src/approver': 65,
    });
  });

  it('skips ESCALATE records, the PR being decided, and records outside the window', async () => {
    await seed([
      decision({ prNumber: 10, verdict: 'ESCALATE', lines: 100, paths: ['src/approver/a.ts'] }),
      decision({ prNumber: 7, lines: 100, paths: ['src/approver/b.ts'] }),
      decision({ prNumber: 11, lines: 100, paths: ['src/approver/c.ts'], timestamp: '2026-10-10T12:00:00.000Z' }),
      decision({ prNumber: 12, lines: 5, paths: ['src/approver/d.ts'] }),
    ]);
    expect(await readLedger({ repoPath: repo, policy, now: NOW, prNumber: 7, touchedPaths: ['src/approver/e.ts'] })).toEqual({
      'src/approver': 5,
    });
  });

  it('drops malformed lines, a missing/odd timestamp, and non-string paths', async () => {
    await seed([
      'not json',
      JSON.stringify({ prNumber: 20, headSha: 'a', verdict: 'APPROVE', signals: { lines: 10, paths: ['src/approver/a.ts'] } }),
      JSON.stringify({ prNumber: 21, headSha: 'b', verdict: 'APPROVE', timestamp: 'nonsense', signals: { lines: 10, paths: ['src/approver/a.ts'] } }),
      JSON.stringify({ prNumber: 22, headSha: 'c', verdict: 'APPROVE', timestamp: '2026-10-21T12:00:00.000Z', signals: { lines: 7, paths: [3, 'src/approver/a.ts'] } }),
      JSON.stringify({ prNumber: 23, headSha: 'd', verdict: 'APPROVE', timestamp: '2026-10-21T12:00:00.000Z', signals: { lines: 'many', paths: ['src/approver/a.ts'] } }),
    ]);
    expect(await readLedger({ repoPath: repo, policy, now: NOW, prNumber: 1, touchedPaths: ['src/approver/x.ts'] })).toEqual({
      // 7 from the record with one usable path; the 'many' record contributes 0 lines.
      'src/approver': 7,
    });
  });

  it('honours the policy window: a record just inside counts, just outside does not', async () => {
    const inside = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const outside = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await seed([
      decision({ prNumber: 30, lines: 11, paths: ['src/approver/a.ts'], timestamp: inside }),
      decision({ prNumber: 31, lines: 99, paths: ['src/approver/a.ts'], timestamp: outside }),
    ]);
    expect(await readLedger({ repoPath: repo, policy, now: NOW, prNumber: 1, touchedPaths: ['src/approver/a.ts'] })).toEqual({
      'src/approver': 11,
    });
  });
});
