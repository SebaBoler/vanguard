import { appendBranchLines } from '../core/metrics-branch.js';
import { DECISIONS_FILE } from './ledger.js';
import type { ApproverFacts, Decision, DecisionRecord, Mode } from './types.js';

export interface BuildDecisionRecordInput {
  mode: Mode;
  repo: string;
  prNumber: number;
  /** Head SHA the decision is for; keeps a short-circuited record keyed per head, not one per PR forever. */
  headSha?: string;
  /** Absent for a short-circuited decision (stopped / policy-unreadable): the record carries zeroed/empty signals. */
  facts: ApproverFacts | undefined;
  decision: Decision;
  policyHash: string;
  timestamp: string;
}

export function buildDecisionRecord(input: BuildDecisionRecordInput): DecisionRecord {
  const { facts, decision } = input;
  const base = {
    schemaVersion: 1 as const,
    mode: input.mode,
    repo: input.repo,
    prNumber: input.prNumber,
    auditSample: decision.auditSample,
    rulesFired: decision.rulesFired,
    verdict: decision.verdict,
    policyHash: input.policyHash,
    timestamp: input.timestamp,
    humanOutcome: null,
  };
  if (facts === undefined) {
    return {
      ...base,
      headSha: input.headSha !== undefined && input.headSha !== '' ? input.headSha : null,
      baseSha: null,
      patchId: null,
      reviewedSha: null,
      checks: [],
      review: { verdict: null, sha: null },
      signals: { files: 0, lines: 0, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: [] },
      ledger: {},
    };
  }
  return {
    ...base,
    headSha: facts.diff.headSha,
    baseSha: facts.diff.baseSha,
    patchId: facts.diff.headPatchId ?? null,
    reviewedSha: facts.review.sha,
    checks: facts.checks,
    review: { verdict: facts.review.verdict, sha: facts.review.sha },
    signals: {
      files: facts.diff.files,
      lines: facts.diff.lines,
      testFilesDeleted: facts.diff.testFilesDeleted,
      testCasesDelta: facts.diff.testCasesDelta,
      exportsRemoved: facts.diff.exportsRemoved,
      newDependency: facts.diff.newDependency,
      paths: facts.diff.paths,
    },
    ledger: facts.ledger,
  };
}

/** Append one decision record to decisions.jsonl on the metrics branch; a rerun for the same (PR, head SHA) appends nothing. */
export async function appendDecision(repoPath: string, record: DecisionRecord, opts: { branch?: string } = {}): Promise<void> {
  await appendBranchLines(repoPath, [JSON.stringify(record)], {
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    file: DECISIONS_FILE,
    key: (r) => `${String(r.prNumber)}:${String(r.headSha)}`,
  });
}
