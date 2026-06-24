import type { GlabRunner } from '../tasks/gitlab.js';
import { defaultGlabRunner } from '../tasks/gitlab.js';

export interface MergeRequestReviewTarget {
  project: string;
  iid: number;
}

export interface MergeRequestForReview extends MergeRequestReviewTarget {
  title: string;
  description: string;
  webUrl: string;
  author: string;
  sourceBranch: string;
  sha: string;
  targetBranch: string;
  diff: string;
}

export type MergeRequestReviewer = (mr: MergeRequestForReview) => Promise<string>;

export interface ReviewMergeRequestDeps {
  project?: string;
  glab?: GlabRunner;
  reviewer: MergeRequestReviewer;
  log?: (line: string) => void;
}

export interface ReviewMergeRequestResult {
  mr: MergeRequestForReview;
  commentBody: string;
}

const MR_URL_RE = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/;
const NUMBER_RE = /^\d+$/;
const MR_REVIEW_MARKER_RE = /^<!--[ \t]*vanguard-mr-review:[ \t]*([a-fA-F0-9]+)[ \t]*-->$/gm;
const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;

export function parseMergeRequestRef(ref: string, project?: string): MergeRequestReviewTarget {
  const trimmed = ref.trim();
  const url = MR_URL_RE.exec(trimmed);
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { project: url[1], iid: Number(url[2]) };
  }
  if (NUMBER_RE.test(trimmed)) {
    if (project === undefined) throw new Error(`MR ref "${trimmed}" needs --gitlab-project.`);
    return { project, iid: Number(trimmed) };
  }
  throw new Error(`Unsupported MR ref: ${ref}`);
}

interface GlabMrView {
  iid?: number;
  title?: string;
  description?: string | null;
  web_url?: string;
  author?: { username?: string } | null;
  source_branch?: string;
  sha?: string;
  target_branch?: string;
}

export async function fetchMergeRequestForReview(
  target: MergeRequestReviewTarget,
  glab: GlabRunner = defaultGlabRunner,
): Promise<MergeRequestForReview> {
  const iid = String(target.iid);
  const view = JSON.parse(
    await glab(['mr', 'view', iid, '--repo', target.project, '--output', 'json']),
  ) as GlabMrView;
  const diff = await glab(['mr', 'diff', iid, '--repo', target.project]);
  return {
    project: target.project,
    iid: view.iid ?? target.iid,
    title: view.title ?? '',
    description: view.description ?? '',
    webUrl: view.web_url ?? `https://gitlab.com/${target.project}/-/merge_requests/${target.iid}`,
    author: view.author?.username ?? '',
    sourceBranch: view.source_branch ?? '',
    sha: view.sha ?? '',
    targetBranch: view.target_branch ?? '',
    diff,
  };
}

export function buildMergeRequestReviewPrompt(mr: MergeRequestForReview): string {
  return [
    '<task_instructions>',
    `MR: ${mr.project}!${mr.iid}`,
    `URL: ${mr.webUrl}`,
    `Title: ${mr.title}`,
    `Author: ${mr.author}`,
    `Base: ${mr.targetBranch}`,
    `Head: ${mr.sourceBranch}`,
    `Head SHA: ${mr.sha}`,
    '',
    'Description:',
    mr.description.trim() === '' ? '(empty)' : mr.description,
    '',
    'Review this merge request diff as an independent reviewer. Focus on correctness, security, tests, regressions, and maintainability.',
    'Report only actionable findings that the author can fix. Include file/function evidence when the diff supports it.',
    'If there are no blocking findings, say exactly: No blocking findings.',
    'Return Markdown only. When done, write <promise>COMPLETE</promise>.',
    '',
    '<diff>',
    mr.diff,
    '</diff>',
    '</task_instructions>',
  ].join('\n');
}

export function mergeRequestReviewMarker(sha: string): string {
  return `<!-- vanguard-mr-review: ${sha} -->`;
}

export function hasMergeRequestReviewMarker(body: string, sha: string): boolean {
  return Array.from(body.matchAll(MR_REVIEW_MARKER_RE)).some((m) => m[1] === sha);
}

export function buildMergeRequestReviewComment(agentText: string, sha?: string): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  const visible = `## Vanguard Review\n\n${body === '' ? 'No blocking findings.' : body}`;
  return sha === undefined || sha === '' ? visible : `${visible}\n\n${mergeRequestReviewMarker(sha)}`;
}

/** Post a Vanguard review as a note on a GitLab MR. */
export async function postMergeRequestNote(
  target: MergeRequestReviewTarget,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await glab([
    'mr', 'note', 'create',
    String(target.iid),
    '--repo', target.project,
    '-m', body,
  ]);
}

export async function reviewMergeRequest(
  ref: string,
  deps: ReviewMergeRequestDeps,
): Promise<ReviewMergeRequestResult> {
  const glab = deps.glab ?? defaultGlabRunner;
  const target = parseMergeRequestRef(ref, deps.project);
  deps.log?.(`review-mr ${target.project}!${target.iid}: fetch -> diff`);
  const mr = await fetchMergeRequestForReview(target, glab);
  deps.log?.(`review-mr ${target.project}!${target.iid}: agent -> reviewing`);
  const reviewText = await deps.reviewer(mr);
  const commentBody = buildMergeRequestReviewComment(reviewText, mr.sha);
  await postMergeRequestNote(target, commentBody, glab);
  deps.log?.(`review-mr ${target.project}!${target.iid}: posted -> mr note`);
  return { mr, commentBody };
}
