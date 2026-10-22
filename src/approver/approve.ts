import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { loadPolicy, POLICY_HASH_NONE } from './policy.js';
import { collectPrFacts, collectCheckFacts, collectReviewFacts, isFactoryPr } from './facts.js';
import { collectDiffFacts, emptyDiffFacts } from './diff-facts.js';
import { readLedger } from './ledger.js';
import { decide } from './rules.js';
import { buildDecisionRecord, appendDecision } from './record.js';
import { publishCheckRun, commentDecision, shadowSafeGhRunner } from './publish.js';
import { VanguardError } from '../core/errors.js';
import type { ApproverFacts, Decision, DecisionRecord } from './types.js';

export interface RunApproverInput {
  repoPath: string;
  repoSlug: string;
  prNumber: number;
  mode: 'shadow';
  gh?: GhRunner;
  branch?: string;
  now?: Date;
  /** Compute and print the decision but publish/record nothing (the day-one backtest + local inspection). */
  dryRun?: boolean;
}

export interface RunApproverResult {
  record: DecisionRecord;
}

/**
 * Orchestration: level-triggered, idempotent per (PR, head SHA). Every step re-fetches from the API;
 * no in-process locking (the caller's workflow concurrency group serializes a PR). Exit is always
 * "a decision was computed and recorded", including ESCALATE — only an operational failure throws.
 */
export async function runApprover(input: RunApproverInput): Promise<RunApproverResult> {
  const gh = shadowSafeGhRunner(input.gh ?? defaultGhRunner);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();

  const finish = async (facts: ApproverFacts | undefined, decision: Decision, policyHash: string, publishHeadSha: string): Promise<RunApproverResult> => {
    const record = buildDecisionRecord({ mode: input.mode, repo: input.repoSlug, prNumber: input.prNumber, headSha: publishHeadSha, facts, decision, policyHash, timestamp });
    if (input.dryRun) return { record };
    // Publish first, record last, and run every step even when one fails: a failed record append must not
    // hide the check run, and no failure is swallowed — they are reported together once all three ran.
    const failures: string[] = [];
    const attempt = async (step: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        failures.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await attempt('check run', () => publishCheckRun(gh, input.repoSlug, publishHeadSha, input.prNumber, decision, record));
    await attempt('comment', () => commentDecision(gh, input.repoSlug, input.prNumber, decision, record));
    await attempt('decision record', () => appendDecision(input.repoPath, record, input.branch !== undefined ? { branch: input.branch } : {}));
    if (failures.length > 0) {
      throw new VanguardError(`approver: ${decision.verdict} for #${input.prNumber} was decided, but ${failures.join('; ')}`);
    }
    return { record };
  };

  const prFacts = await collectPrFacts(gh, input.repoSlug, input.prNumber);
  const base = prFacts.baseRefName !== '' ? prFacts.baseRefName : 'main';
  const loaded = await loadPolicy(input.repoPath, base);
  if (loaded === undefined) {
    const decision: Decision = { verdict: 'ESCALATE', rulesFired: ['policy-unreadable'], auditSample: { p: 0, seed: '', hit: false }, reviewValid: false };
    return finish(undefined, decision, POLICY_HASH_NONE, prFacts.headSha);
  }
  const { policy, policyHash } = loaded;
  const { reviews: _reviews, ...prWithoutReviews } = prFacts;
  const seed = `${input.repoSlug}:${input.prNumber}:${prFacts.headSha}:${policyHash}`;

  const stopped = policy.enabled === false || (process.env.VANGUARD_APPROVER_STOP ?? '') !== '';
  if (stopped) {
    // Kill switch short-circuits before any diff/ledger collection (no head fetch, no merge-tree).
    const stoppedFacts: ApproverFacts = {
      pr: prWithoutReviews,
      isFactoryPr: false,
      checks: [],
      review: { verdict: null, sha: null, author: null },
      ledger: {},
      thisPrLines: 0,
      diff: emptyDiffFacts(prFacts.headSha),
    };
    const decision = decide(stoppedFacts, policy, seed);
    return finish(undefined, decision, policyHash, prFacts.headSha);
  }

  const factory = isFactoryPr(prFacts, input.repoSlug, policy);
  const checks = await collectCheckFacts(gh, input.repoSlug, prFacts.headSha, policy);
  const review = collectReviewFacts(prFacts, policy);
  const diff = await collectDiffFacts({
    repoPath: input.repoPath,
    prNumber: input.prNumber,
    baseRefName: base,
    apiHeadSha: prFacts.headSha,
    reviewedSha: review.sha,
    policy,
  });
  const ledger = await readLedger({
    repoPath: input.repoPath,
    policy,
    now,
    prNumber: input.prNumber,
    touchedPaths: diff.paths,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  });

  const facts: ApproverFacts = { pr: prWithoutReviews, isFactoryPr: factory, checks, review, diff, ledger, thisPrLines: diff.lines };
  const decision = decide(facts, policy, seed);
  return finish(facts, decision, policyHash, diff.headSha);
}
