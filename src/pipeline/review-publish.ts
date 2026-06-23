import { parsePullRequestRef, postPullRequestReview, buildMainLoopReviewComment } from '../runners/pr-review.js';
import { extractFindings } from '../structured/findings.js';
import type { StageOutcome } from './pipeline.js';
import type { GhRunner } from '../tasks/github.js';

export interface PublishReviewVerdictInput {
  /** Optional fallback for numeric PR refs; full GitHub URLs do not need it. */
  repoSlug?: string;
  /** Full GitHub PR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA — also the dedupe marker embedded in the comment. */
  headSha: string;
  /** The 'reviewer' StageOutcome. Missing → hard error (no-silence guarantee). */
  reviewerOutcome?: StageOutcome | undefined;
  /** Attribution string e.g. "codex" or "claude/sonnet". */
  attribution: string;
  /** When true, blocking (high/critical) findings post as --request-changes to block merge. */
  gate?: boolean;
  /** Injected for tests; defaults to the real gh runner. */
  gh?: GhRunner;
}

/** Build an attribution string from a reviewer stage outcome, e.g. "codex/gpt-5" or "claude". */
export function buildReviewerAttribution(outcome: StageOutcome | undefined, fallbackName: string): string {
  return outcome?.model !== undefined
    ? `${outcome.providerName ?? fallbackName}/${outcome.model}`
    : outcome?.providerName ?? fallbackName;
}

/**
 * Determine whether a reviewer verdict contains blocking (high or critical severity) findings.
 * Prefers a structured <findings> JSON block when present; falls back to keyword detection in the
 * Markdown text for robustness when the reviewer produces free-form prose only.
 */
export function hasBlockingFinding(verdictText: string): boolean {
  try {
    const { findings } = extractFindings(verdictText);
    return findings.some((f) => f.severity === 'high' || f.severity === 'critical');
  } catch {
    // No structured findings block — scan prose for severity keywords.
    return /\b(critical|high[- ]severity)\b/i.test(verdictText);
  }
}

/**
 * Post the reviewer stage's verdict to an already-opened PR.
 * Called by runGithubIssue / runLinearIssue immediately after publishForReview.
 *
 * No-silence guarantee: if reviewerOutcome is undefined the call throws (the run errors loudly
 * rather than silently recording "ok"). A gh failure also propagates — it is NOT swallowed.
 */
export async function publishReviewVerdict(input: PublishReviewVerdictInput): Promise<void> {
  if (input.reviewerOutcome === undefined) {
    throw new Error(`publishReviewVerdict: no reviewer outcome for ${input.prUrl} — silence is not ok`);
  }

  const target = parsePullRequestRef(input.prUrl, input.repoSlug);
  const verdictText = input.reviewerOutcome.result.finalText;
  const commentBody = buildMainLoopReviewComment(verdictText, {
    headRefOid: input.headSha,
    attribution: input.attribution,
  });

  const action = input.gate === true && hasBlockingFinding(verdictText) ? 'request-changes' : 'comment';
  await postPullRequestReview(target, commentBody, action, input.gh);
}
