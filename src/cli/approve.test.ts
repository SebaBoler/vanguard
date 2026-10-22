import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The engine is covered end to end (record, check run, comment, dry-run, no write call) by
// src/approver/approve.test.ts; this file is only about the thin command layer around it.
vi.mock('../approver/approve.js', () => ({ runApprover: vi.fn() }));

import { runApprover } from '../approver/approve.js';
import { parseCli } from './args.js';
import { approveCommand } from './approve.js';
import type { Command } from './args.js';
import type { RunApproverInput } from '../approver/approve.js';
import type { DecisionRecord } from '../approver/types.js';

function fakeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schemaVersion: 1,
    mode: 'shadow',
    repo: 'o/r',
    prNumber: 7,
    headSha: 'head',
    baseSha: 'base',
    patchId: 'p1',
    reviewedSha: 'head',
    checks: [{ name: 'build', appId: 15368, conclusion: 'success' }],
    review: { verdict: 'clean', sha: 'head' },
    signals: { files: 1, lines: 4, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: ['src/a.ts'] },
    ledger: {},
    auditSample: { p: 0.1, seed: 'o/r:7:head:sha256:abc', hit: false },
    rulesFired: [],
    verdict: 'APPROVE',
    policyHash: 'sha256:abc',
    timestamp: '2026-10-22T12:00:00.000Z',
    humanOutcome: null,
    ...overrides,
  };
}

/** The command exactly as the CLI builds it: argv -> parseCli -> approveCommand. */
async function runCli(argv: string[]): Promise<void> {
  const command: Command = parseCli(argv, '/work');
  if (command.kind !== 'approve') throw new Error(`expected an approve command, got ${command.kind}`);
  await approveCommand(command);
}

function engineInput(): RunApproverInput {
  return vi.mocked(runApprover).mock.calls[0]![0];
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.mocked(runApprover).mockReset();
  vi.mocked(runApprover).mockResolvedValue({ record: fakeRecord() });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('approveCommand', () => {
  it('passes every parsed flag through to the engine and prints the verdict', async () => {
    await runCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--repo', '/r', '--branch', 'b', '--dry-run']);

    expect(engineInput()).toEqual({ repoPath: '/r', repoSlug: 'o/r', prNumber: 7, mode: 'shadow', dryRun: true, branch: 'b' });
    expect(logs).toEqual(['vanguard approve: APPROVE']);
    expect(process.exitCode).not.toBe(1);
  });

  it('omits branch and dryRun defaults to false when the flags are absent', async () => {
    await runCli(['approve', '--pr', '7', '--github-repo', 'o/r']);

    expect(engineInput()).toEqual({ repoPath: '/work', repoSlug: 'o/r', prNumber: 7, mode: 'shadow', dryRun: false });
  });

  it('lists the rules that fired next to an ESCALATE verdict', async () => {
    vi.mocked(runApprover).mockResolvedValue({ record: fakeRecord({ verdict: 'ESCALATE', rulesFired: ['path:ci-config', 'size-lines'] }) });
    await runCli(['approve', '--pr', '7', '--github-repo', 'o/r']);

    expect(logs).toEqual(['vanguard approve: ESCALATE (path:ci-config, size-lines)']);
  });

  it('prints the decision record as a single JSON line with --json', async () => {
    await runCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--json']);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual(fakeRecord());
  });

  it('reports an engine failure on stderr and exits non-zero', async () => {
    vi.mocked(runApprover).mockRejectedValue(new Error('gh: not authenticated'));
    await runCli(['approve', '--pr', '7', '--github-repo', 'o/r']);

    expect(errors[0]).toContain('vanguard approve: gh: not authenticated');
    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
