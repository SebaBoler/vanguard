import { parsePullRequestUrl, postPullRequestReview, buildMainLoopReviewComment } from '../runners/pr-review.js';
import { extractFindings } from '../structured/findings.js';
import type { StageOutcome } from './pipeline.js';
import type { RunResult } from '../core/types.js';
import type { GhRunner } from '../tasks/github.js';

export interface PublishReviewVerdictInput {
  /** Full GitHub PR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA — also the dedupe marker embedded in the comment. */
  headSha: string;
  /** The 'reviewer' StageOutcome. Missing → hard error (no-silence guarantee). */
  reviewerOutcome?: StageOutcome | undefined;
  /** The 'conformance' StageOutcome. Optional; when present appends a ## Conformance section. */
  conformanceOutcome?: StageOutcome | undefined;
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

const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;

/** Rendered when a conformance pass exhausts its turn budget without completing. */
const CONFORMANCE_INCOMPLETE_NOTICE =
  '⚠️ Conformance pass did not complete (large diff / turn budget) — treat as unverified.';

/** Sentinel the conformance stage emits when the task has no <tech_spec> to check against. */
const CONFORMANCE_SKIP_SENTINEL = 'No spec, conformance skipped.';

/**
 * Build the body of the ## Conformance comment section for a conformance outcome, or undefined to
 * suppress the section entirely. Incomplete → unverified notice; the no-spec skip sentinel →
 * suppressed (a near-empty section is just noise); otherwise the structured <findings> block
 * rendered as a bullet list, falling back to the cleaned prose when no findings are present.
 */
export function renderConformanceSection(result: RunResult): string | undefined {
  if (result.completed === false) return CONFORMANCE_INCOMPLETE_NOTICE;
  const cleaned = result.finalText.replace(PROMISE_RE, '').trim();
  if (cleaned === CONFORMANCE_SKIP_SENTINEL) return undefined;
  try {
    const { findings } = extractFindings(cleaned);
    if (findings.length > 0) {
      return findings.map((f) => `- **${f.severity}** (${f.kind}) — ${f.title}\n  ${f.evidence}`).join('\n');
    }
  } catch {
    // No structured findings block — fall through to the cleaned prose.
  }
  return cleaned;
}

/**
 * Post the reviewer stage's verdict to an already-opened PR.
 * Called by runGithubIssue / runLinearIssue immediately after publishForReview.
 *
 * No-silence guarantee: if reviewerOutcome is undefined the call throws (the run errors loudly
 * rather than silently recording "ok"). A gh failure also propagates — it is NOT swallowed.
 * conformanceOutcome is additive and optional — its absence never throws.
 */
export async function publishReviewVerdict(input: PublishReviewVerdictInput): Promise<void> {
  if (input.reviewerOutcome === undefined) {
    throw new Error(`publishReviewVerdict: no reviewer outcome for ${input.prUrl} — silence is not ok`);
  }

  const target = parsePullRequestUrl(input.prUrl);
  const verdictText = input.reviewerOutcome.result.finalText;
  let commentBody = buildMainLoopReviewComment(verdictText, {
    headRefOid: input.headSha,
    attribution: input.attribution,
  });

  const conformanceResult = input.conformanceOutcome?.result;
  if (conformanceResult !== undefined) {
    const section = renderConformanceSection(conformanceResult);
    if (section !== undefined) {
      commentBody = `${commentBody}\n\n## Conformance\n\n${section}`;
    }
  }

  // Gate on blocking findings in the reviewer verdict or a completed conformance pass (incomplete is
  // advisory only and never blocks). Gating reads the raw outcome text, independent of rendering.
  const conformanceGateText = conformanceResult?.completed === false ? undefined : conformanceResult?.finalText;
  const blocking =
    input.gate === true &&
    (hasBlockingFinding(verdictText) || (conformanceGateText !== undefined && hasBlockingFinding(conformanceGateText)));
  const action = blocking ? 'request-changes' : 'comment';
  await postPullRequestReview(target, commentBody, action, input.gh);
}
