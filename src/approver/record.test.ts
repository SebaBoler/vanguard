import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { appendDecision, buildDecisionRecord } from './record.js';
import { DECISIONS_FILE } from './ledger.js';
import { readBranchFile, METRICS_BRANCH_DEFAULT } from '../core/metrics-branch.js';
import { cleanDiff, cleanFacts } from './facts.fixture.js';
import type { ApproverFacts, Decision, DecisionRecord } from './types.js';

let root: string;
let repo: string;

/** Distinct values in every field the record carries, so a mis-sourced field shows up as a mismatch. */
function facts(headSha = 'head'): ApproverFacts {
  return cleanFacts({
    checks: [{ name: 'build', appId: 15368, conclusion: 'success' }],
    diff: cleanDiff({ files: 2, lines: 12, paths: ['src/a.ts', 'src/a.test.ts'], testCasesDelta: 1, headSha }),
    ledger: { 'src/approver': 40 },
    thisPrLines: 12,
  });
}

const decision: Decision = {
  verdict: 'APPROVE',
  rulesFired: [],
  auditSample: { p: 0.1, seed: 'o/r:1:head:sha256:abc', hit: false },
  reviewValid: true,
};

function record({ prNumber = 1, headSha = 'head' }: { prNumber?: number; headSha?: string } = {}): DecisionRecord {
  return buildDecisionRecord({
    mode: 'shadow',
    repo: 'o/r',
    prNumber,
    facts: facts(headSha),
    decision,
    policyHash: 'sha256:abc',
    timestamp: '2026-10-22T12:00:00.000Z',
  });
}

async function branchLines(): Promise<string[]> {
  const text = await readBranchFile(repo, { file: DECISIONS_FILE });
  return text.trim() === '' ? [] : text.trim().split('\n');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-record-'));
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

describe('buildDecisionRecord', () => {
  it('carries every schema field, sourced from the facts', () => {
    expect(record()).toEqual({
      schemaVersion: 1,
      mode: 'shadow',
      repo: 'o/r',
      prNumber: 1,
      headSha: 'head',
      baseSha: 'base',
      patchId: 'p1',
      reviewedSha: 'head',
      checks: [{ name: 'build', appId: 15368, conclusion: 'success' }],
      review: { verdict: 'clean', sha: 'head' },
      signals: { files: 2, lines: 12, testFilesDeleted: 0, testCasesDelta: 1, exportsRemoved: 0, newDependency: false, paths: ['src/a.ts', 'src/a.test.ts'] },
      ledger: { 'src/approver': 40 },
      auditSample: { p: 0.1, seed: 'o/r:1:head:sha256:abc', hit: false },
      rulesFired: [],
      verdict: 'APPROVE',
      policyHash: 'sha256:abc',
      timestamp: '2026-10-22T12:00:00.000Z',
      humanOutcome: null,
    });
  });

  it('keeps the same field set, zeroed, for a short-circuited decision with no facts', () => {
    const stopped = buildDecisionRecord({
      mode: 'shadow',
      repo: 'o/r',
      prNumber: 1,
      facts: undefined,
      decision: { verdict: 'ESCALATE', rulesFired: ['stopped'], auditSample: decision.auditSample, reviewValid: false },
      policyHash: 'none',
      timestamp: '2026-10-22T12:00:00.000Z',
    });
    expect(Object.keys(stopped).sort()).toEqual(Object.keys(record()).sort());
    expect(stopped).toMatchObject({
      headSha: null, baseSha: null, patchId: null, reviewedSha: null, checks: [],
      review: { verdict: null, sha: null },
      signals: { files: 0, lines: 0, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: [] },
      ledger: {}, verdict: 'ESCALATE', rulesFired: ['stopped'], policyHash: 'none',
    });
  });
});

describe('appendDecision', () => {
  it('appends exactly one JSON line per decision, parseable back into the record', async () => {
    await appendDecision(repo, record());
    const lines = await branchLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(record());
  });

  it('appends nothing for a rerun at the same (PR, head SHA), even with different content', async () => {
    await appendDecision(repo, record());
    const rerun: DecisionRecord = { ...record(), timestamp: '2026-10-22T13:00:00.000Z', verdict: 'ESCALATE', rulesFired: ['head-moved'] };
    await appendDecision(repo, rerun);
    const lines = await branchLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ verdict: 'APPROVE', timestamp: '2026-10-22T12:00:00.000Z' });
  });

  it('appends a new line for the same PR at a new head SHA, and for another PR', async () => {
    await appendDecision(repo, record());
    await appendDecision(repo, record({ headSha: 'head2' }));
    await appendDecision(repo, record({ prNumber: 2 }));
    expect(await branchLines()).toHaveLength(3);
  });

  it('is append-only on the metrics branch: earlier lines survive and each commit builds on the last tip', async () => {
    await appendDecision(repo, record());
    const first = (await branchLines())[0]!;
    await appendDecision(repo, record({ headSha: 'head2' }));

    const lines = await branchLines();
    expect(lines[0]).toBe(first);
    expect(lines).toHaveLength(2);

    const log = (await execa('git', ['-C', repo, 'log', '--format=%H %P', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout.trim().split('\n');
    expect(log).toHaveLength(2);
    const [tip, parent] = log.map((entry) => entry.split(' '));
    expect(tip![1]).toBe(parent![0]);
  });
});
