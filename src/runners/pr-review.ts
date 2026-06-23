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

export type PullRequestReviewer = (pr: PullRequestForReview) => Promise<string>;

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

export function buildPullRequestReviewPrompt(pr: PullRequestForReview): string {
  return [
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
    'Review this pull request diff as an independent reviewer. Focus on correctness, security, tests, regressions, and maintainability.',
    'Report only actionable findings that the author can fix. Include file/function evidence when the diff supports it.',
    'If there are no blocking findings, say exactly: No blocking findings.',
    'Return Markdown only. When done, write <promise>COMPLETE</promise>.',
    '',
    '<diff>',
    pr.diff,
    '</diff>',
    '</task_instructions>',
  ].join('\n');
}

export function pullRequestReviewMarker(headRefOid: string): string {
  return `<!-- vanguard-pr-review: ${headRefOid} -->`;
}

export function hasPullRequestReviewMarker(body: string, headRefOid: string): boolean {
  return Array.from(body.matchAll(PR_REVIEW_MARKER_RE)).some((marker) => marker[1] === headRefOid);
}

export function buildPullRequestReviewComment(agentText: string, headRefOid?: string): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  const visible = `## Vanguard Review\n\n${body === '' ? 'No blocking findings.' : body}`;
  return headRefOid === undefined || headRefOid === '' ? visible : `${visible}\n\n${pullRequestReviewMarker(headRefOid)}`;
}

/** Action flag passed to `gh pr review`. */
export type PullRequestReviewAction = 'comment' | 'request-changes';

/** Post a Vanguard review verdict to a PR via `gh pr review`. Reused by review-pr and the agent loop. */
export async function postPullRequestReview(
  target: PullRequestReviewTarget,
  commentBody: string,
  action: PullRequestReviewAction = 'comment',
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const flag = action === 'request-changes' ? '--request-changes' : '--comment';
  await gh(['pr', 'review', String(target.number), '--repo', target.repoSlug, flag, '--body', commentBody]);
}

const NO_BLOCKING_RE = /^no blocking (?:findings|issues)\.?$/i;

/**
 * Build a review comment for the main-loop reviewer (after the PR is created). Unlike
 * buildPullRequestReviewComment (used by the standalone review-pr command), this always
 * includes an attribution line so the comment is traceable even when the verdict is empty.
 */
export function buildMainLoopReviewComment(
  agentText: string,
  opts: { headRefOid?: string; attribution: string },
): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  const oid = opts.headRefOid || undefined;
  const sha7 = oid?.slice(0, 7);
  const prefix = `Reviewed by ${opts.attribution}${sha7 !== undefined ? ` @ ${sha7}` : ''}`;
  const noIssues = body === '' || NO_BLOCKING_RE.test(body);
  const verdict = noIssues ? `${prefix}: no blocking issues` : `${prefix}:\n\n${body}`;
  const visible = `## Vanguard Review\n\n${verdict}`;
  const marker = oid !== undefined ? pullRequestReviewMarker(oid) : undefined;
  return marker !== undefined ? `${visible}\n\n${marker}` : visible;
}

export async function reviewPullRequest(ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const target = parsePullRequestRef(ref, deps.repoSlug);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: fetch -> diff`);
  const pr = await fetchPullRequestForReview(target, gh);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: agent -> reviewing`);
  const reviewText = await deps.reviewer(pr);
  const commentBody = buildPullRequestReviewComment(reviewText, pr.headRefOid);
  await postPullRequestReview(target, commentBody, 'comment', gh);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: posted -> pr review`);
  return { pr, commentBody };
}
