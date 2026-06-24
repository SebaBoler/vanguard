import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';

export interface PullRequestReviewTarget {
  repoSlug: string;
  number: number;
}

export interface PullRequestForReview extends PullRequestReviewTarget {
  title: string;
  body: string;
  url: string;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  diff: string;
}

export interface PullRequestReviewOutcome {
  text: string;
  completed: boolean;
}

export interface PullRequestReviewAttempt {
  isRetry: boolean;
}

export type PullRequestReviewer = (
  pr: PullRequestForReview,
  opts: PullRequestReviewAttempt,
) => Promise<string | PullRequestReviewOutcome>;

export interface ReviewPullRequestDeps {
  repoSlug?: string;
  gh?: GhRunner;
  reviewer: PullRequestReviewer;
  log?: (line: string) => void;
}

export interface ReviewPullRequestResult {
  pr: PullRequestForReview;
  commentBody: string;
}

interface GhPullRequestView {
  number?: number;
  title?: string;
  body?: string | null;
  url?: string;
  author?: { login?: string } | null;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_HASH_RE = /^([^/\s]+\/[^#\s]+)#(\d+)$/;
const PR_PATH_RE = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;
const NUMBER_RE = /^\d+$/;
const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;
const PR_REVIEW_MARKER_RE = /^<!--[ \t]*vanguard-pr-review:[ \t]*([a-fA-F0-9]+)[ \t]*-->$/gm;

function normalizePullRequestReviewOutcome(outcome: string | PullRequestReviewOutcome): PullRequestReviewOutcome {
  return typeof outcome === 'string' ? { text: outcome, completed: true } : outcome;
}

export function parsePullRequestRef(ref: string, repoSlug?: string): PullRequestReviewTarget {
  const trimmed = ref.trim();
  const url = PR_URL_RE.exec(trimmed);
  if (url?.[1] !== undefined && url[2] !== undefined) return { repoSlug: url[1], number: Number(url[2]) };

  const hash = PR_HASH_RE.exec(trimmed);
  if (hash?.[1] !== undefined && hash[2] !== undefined) return { repoSlug: hash[1], number: Number(hash[2]) };

  const path = PR_PATH_RE.exec(trimmed);
  if (path?.[1] !== undefined && path[2] !== undefined) return { repoSlug: path[1], number: Number(path[2]) };

  if (NUMBER_RE.test(trimmed)) {
    if (repoSlug === undefined) throw new Error(`Pull request ref "${trimmed}" needs --github-repo.`);
    return { repoSlug, number: Number(trimmed) };
  }

  throw new Error(`Unsupported pull request ref: ${ref}`);
}

export async function fetchPullRequestForReview(target: PullRequestReviewTarget, gh: GhRunner = defaultGhRunner): Promise<PullRequestForReview> {
  const number = String(target.number);
  const view = JSON.parse(
    await gh(['pr', 'view', number, '--repo', target.repoSlug, '--json', 'number,title,body,url,author,headRefName,headRefOid,baseRefName']),
  ) as GhPullRequestView;
  const diff = await gh(['pr', 'diff', number, '--repo', target.repoSlug]);
  return {
    repoSlug: target.repoSlug,
    number: view.number ?? target.number,
    title: view.title ?? '',
    body: view.body ?? '',
    url: view.url ?? `https://github.com/${target.repoSlug}/pull/${target.number}`,
    author: view.author?.login ?? '',
    headRefName: view.headRefName ?? '',
    headRefOid: view.headRefOid ?? '',
    baseRefName: view.baseRefName ?? '',
    diff,
  };
}

export function buildPullRequestReviewPrompt(pr: PullRequestForReview, opts: { retryTriage?: boolean } = {}): string {
  const lines = [
    '<task_instructions>',
    `PR: ${pr.repoSlug}#${pr.number}`,
    `URL: ${pr.url}`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}`,
    `Base: ${pr.baseRefName}`,
    `Head: ${pr.headRefName}`,
    `Head SHA: ${pr.headRefOid}`,
    '',
    'Description:',
    pr.body.trim() === '' ? '(empty)' : pr.body,
    '',
  ];
  if (opts.retryTriage) {
    lines.push(
      'This is a large diff. Do not attempt to read every file exhaustively. Triage: scan the whole diff first, then focus only on the highest-risk changes (correctness, security, data loss, broken contracts). Produce your verdict within the turn budget. If you cannot cover everything, report the findings you are confident in and state what you did not cover, but you MUST finish with a verdict and <promise>COMPLETE</promise>.',
      '',
    );
  }
  lines.push(
    'Review this pull request diff as an independent reviewer. Focus on correctness, security, tests, regressions, and maintainability.',
    'Report only actionable findings that the author can fix. Include file/function evidence when the diff supports it.',
    'If there are no blocking findings, say exactly: No blocking findings.',
    'Return Markdown only. When done, write <promise>COMPLETE</promise>.',
    '',
    '<diff>',
    pr.diff,
    '</diff>',
    '</task_instructions>',
  );
  return lines.join('\n');
}

export function pullRequestReviewMarker(headRefOid: string): string {
  return `<!-- vanguard-pr-review: ${headRefOid} -->`;
}

export function hasPullRequestReviewMarker(body: string, headRefOid: string): boolean {
  return Array.from(body.matchAll(PR_REVIEW_MARKER_RE)).some((marker) => marker[1] === headRefOid);
}

export const PR_REVIEW_INCOMPLETE_NOTICE =
  'Vanguard review did not complete; PR likely too large for a single pass. Please split or review manually.';

function appendMarker(visible: string, headRefOid?: string): string {
  return headRefOid === undefined || headRefOid === '' ? visible : `${visible}\n\n${pullRequestReviewMarker(headRefOid)}`;
}

export function buildPullRequestReviewIncompleteComment(headRefOid?: string): string {
  return appendMarker(`## Vanguard Review\n\n${PR_REVIEW_INCOMPLETE_NOTICE}`, headRefOid);
}

export function buildPullRequestReviewComment(agentText: string, headRefOid?: string): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  return appendMarker(`## Vanguard Review\n\n${body === '' ? 'No blocking findings.' : body}`, headRefOid);
}

export type PullRequestReviewAction = 'comment' | 'request-changes' | 'approve';

/** Post a Vanguard review verdict to a PR via `gh pr review`. Reused by review-pr and the main agent loop. */
export async function postPullRequestReview(
  target: PullRequestReviewTarget,
  commentBody: string,
  action: PullRequestReviewAction = 'comment',
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const flag = action === 'request-changes' ? '--request-changes' : action === 'approve' ? '--approve' : '--comment';
  await gh(['pr', 'review', String(target.number), '--repo', target.repoSlug, flag, '--body', commentBody]);
}

/**
 * Build a main-loop review comment with an attribution header.
 * Empty agentText → explicit "no blocking issues" sentinel (silence ≠ ok).
 * Non-empty agentText → the verdict text below the attribution header.
 * Appends the hidden head-SHA dedupe marker when headRefOid is provided.
 */
export function buildMainLoopReviewComment(
  agentText: string,
  opts: { headRefOid?: string; attribution: string },
): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  const oid = opts.headRefOid !== undefined && opts.headRefOid !== '' ? opts.headRefOid : undefined;
  const sha7 = oid?.slice(0, 7);
  const atSha = sha7 !== undefined ? ` @ ${sha7}` : '';
  const header = `Reviewed by ${opts.attribution}${atSha}`;
  const visible =
    body === '' ? `## Vanguard Review\n\n${header}: no blocking issues` : `## Vanguard Review\n\n${header}:\n\n${body}`;
  return oid !== undefined ? `${visible}\n\n${pullRequestReviewMarker(oid)}` : visible;
}

export async function reviewPullRequest(ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const target = parsePullRequestRef(ref, deps.repoSlug);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: fetch -> diff`);
  const pr = await fetchPullRequestForReview(target, gh);

  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: agent -> reviewing`);
  let outcome = normalizePullRequestReviewOutcome(await deps.reviewer(pr, { isRetry: false }));
  if (!outcome.completed) {
    deps.log?.(`review-pr ${target.repoSlug}#${target.number}: incomplete -> retry (larger budget)`);
    outcome = normalizePullRequestReviewOutcome(await deps.reviewer(pr, { isRetry: true }));
  }

  const commentBody = outcome.completed
    ? buildPullRequestReviewComment(outcome.text, pr.headRefOid)
    : buildPullRequestReviewIncompleteComment(pr.headRefOid);

  await postPullRequestReview(target, commentBody, 'comment', gh);
  deps.log?.(
    `review-pr ${target.repoSlug}#${target.number}: posted -> ${outcome.completed ? 'pr review' : 'incomplete notice'}`,
  );
  return { pr, commentBody };
}
