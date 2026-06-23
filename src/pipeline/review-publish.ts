import { parsePullRequestRef, postPullRequestReview, buildMainLoopReviewComment } from '../runners/pr-review.js';
import { extractFindings } from '../structured/findings.js';
import type { StageOutcome } from './pipeline.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestReviewAction } from '../runners/pr-review.js';

export interface PublishReviewVerdictInput {
  repoSlug: string;
  /** Full GitHub PR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA (from commitStage); used as the dedupe marker. */
  headSha: string;
  /** The 'reviewer' StageOutcome from runStages/runBudgetedStages. Undefined is a hard error. */
  reviewerOutcome: StageOutcome | undefined;
  /** Attribution string shown in the comment, e.g. "codex/gpt-5" or "claude". */
  attribution: string;
  /** When true, high/critical structured findings post as --request-changes to block merge. */
  gate?: boolean;
  /** Injected for tests; defaults to the real gh runner. */
  gh?: GhRunner;
}

function hasBlockingFinding(text: string): boolean {
  try {
    const parsed = extractFindings(text);
    return parsed.findings.some((f) => f.severity === 'high' || f.severity === 'critical');
  } catch {
    // No <findings> block or unparseable — conservative: never block merge on free-form text.
    return false;
  }
}

/**
 * Post the main-loop reviewer's verdict as a GitHub PR review comment.
 *
 * Always produces an artifact: findings → comment with them; empty / no-issues → explicit
 * "no blocking issues" line. A missing reviewerOutcome (reviewer stage never ran) is a hard error
 * because silence must be impossible: if a PR was opened, a verdict must follow.
 */
export async function publishReviewVerdict(input: PublishReviewVerdictInput): Promise<void> {
  if (input.reviewerOutcome === undefined) {
    throw new Error(
      `publishReviewVerdict: reviewer stage outcome is missing for PR ${input.prUrl} — cannot post verdict`,
    );
  }
  const target = parsePullRequestRef(input.prUrl, input.repoSlug);
  const verdictText = input.reviewerOutcome.result.finalText;
  const commentBody = buildMainLoopReviewComment(verdictText, {
    headRefOid: input.headSha,
    attribution: input.attribution,
  });
  const action: PullRequestReviewAction =
    input.gate === true && hasBlockingFinding(verdictText) ? 'request-changes' : 'comment';
  await postPullRequestReview(target, commentBody, action, input.gh);
}
