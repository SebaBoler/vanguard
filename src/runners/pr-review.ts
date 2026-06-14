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
  baseRefName?: string;
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_HASH_RE = /^([^/\s]+\/[^#\s]+)#(\d+)$/;
const PR_PATH_RE = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;
const NUMBER_RE = /^\d+$/;
const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;

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
    await gh(['pr', 'view', number, '--repo', target.repoSlug, '--json', 'number,title,body,url,author,headRefName,baseRefName']),
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

export function buildPullRequestReviewComment(agentText: string): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  return `## Vanguard Review\n\n${body === '' ? 'No blocking findings.' : body}`;
}

export async function reviewPullRequest(ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const target = parsePullRequestRef(ref, deps.repoSlug);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: fetch -> diff`);
  const pr = await fetchPullRequestForReview(target, gh);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: agent -> reviewing`);
  const reviewText = await deps.reviewer(pr);
  const commentBody = buildPullRequestReviewComment(reviewText);
  await gh(['pr', 'review', String(target.number), '--repo', target.repoSlug, '--comment', '--body', commentBody]);
  deps.log?.(`review-pr ${target.repoSlug}#${target.number}: posted -> pr review`);
  return { pr, commentBody };
}
