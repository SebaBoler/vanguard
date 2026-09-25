import { VanguardError } from '../core/errors.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import { defaultGlabRunner, encodeProject } from '../tasks/gitlab.js';

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

export interface MergeRequestReviewOutcome {
  text: string;
  completed: boolean;
}

export interface MergeRequestReviewAttempt {
  isRetry: boolean;
}

export type MergeRequestReviewer = (
  mr: MergeRequestForReview,
  opts: MergeRequestReviewAttempt,
) => Promise<string | MergeRequestReviewOutcome>;

function normalizeMergeRequestReviewOutcome(outcome: string | MergeRequestReviewOutcome): MergeRequestReviewOutcome {
  return typeof outcome === 'string' ? { text: outcome, completed: true } : outcome;
}

export interface ReviewMergeRequestDeps {
  project?: string;
  glab?: GlabRunner;
  reviewer: MergeRequestReviewer;
  log?: (line: string) => void;
}

export interface ReviewMergeRequestResult {
  mr: MergeRequestForReview;
  /** Absent when the head SHA already carries a Vanguard review, so nothing was posted. */
  commentBody?: string;
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

interface GlabMrNoteItem {
  body?: string | null;
  system?: boolean;
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
    webUrl: view.web_url ?? '',
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

/** Whether one of the MR's latest 100 notes carries the Vanguard review marker for `sha`. Throws when the notes cannot be read. */
export async function hasMergeRequestReviewForHead(
  target: MergeRequestReviewTarget,
  sha: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<boolean> {
  const out = await glab([
    'api',
    `projects/${encodeProject(target.project)}/merge_requests/${target.iid}/notes?per_page=100&sort=desc&order_by=created_at`,
  ]);
  const notes = JSON.parse(out) as GlabMrNoteItem[];
  return notes.some(
    (n) => !n.system && n.body !== undefined && n.body !== null && hasMergeRequestReviewMarker(n.body, sha),
  );
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

/**
 * Both review attempts ended without a verdict. Deliberately posts nothing — unlike review-pr, which
 * posts an incomplete notice — so no note ever carries the review marker for an incomplete review; the
 * CI caller surfaces this failure with its own note (no marker), and a retried job can review the head
 * again instead of being permanently skipped by the per-head dedupe.
 */
export class MergeRequestReviewIncompleteError extends VanguardError {
  constructor(readonly mr: MergeRequestForReview) {
    super(`Vanguard review of ${mr.project}!${mr.iid} did not complete: no verdict for head ${mr.sha.slice(0, 7)}.`);
  }
}

export async function reviewMergeRequest(
  ref: string,
  deps: ReviewMergeRequestDeps,
): Promise<ReviewMergeRequestResult> {
  const glab = deps.glab ?? defaultGlabRunner;
  const target = parseMergeRequestRef(ref, deps.project);
  deps.log?.(`review-mr ${target.project}!${target.iid}: fetch -> diff`);
  const mr = await fetchMergeRequestForReview(target, glab);
  // A CI retry re-runs review-mr on the same head. Skip when that head is already reviewed, and fail
  // when that cannot be established: a guess of "not reviewed yet" would post a second review.
  const id = `${target.project}!${target.iid}`;
  if (mr.sha === '') throw new Error(`review-mr ${id}: glab returned no head SHA, so an earlier review cannot be ruled out; nothing posted.`);
  let reviewed: boolean;
  try {
    reviewed = await hasMergeRequestReviewForHead(target, mr.sha, glab);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`review-mr ${id}: cannot read the MR notes to check for a review of ${mr.sha}; nothing posted (${reason})`, { cause: error });
  }
  if (reviewed) {
    deps.log?.(`review-mr ${id}: head ${mr.sha} already reviewed -> skip`);
    return { mr };
  }
  deps.log?.(`review-mr ${target.project}!${target.iid}: agent -> reviewing`);
  let outcome = normalizeMergeRequestReviewOutcome(await deps.reviewer(mr, { isRetry: false }));
  if (!outcome.completed) {
    deps.log?.(`review-mr ${id}: incomplete -> retry (larger budget)`);
    outcome = normalizeMergeRequestReviewOutcome(await deps.reviewer(mr, { isRetry: true }));
  }
  if (!outcome.completed) {
    throw new MergeRequestReviewIncompleteError(mr);
  }
  const commentBody = buildMergeRequestReviewComment(outcome.text, mr.sha);
  await postMergeRequestNote(target, commentBody, glab);
  deps.log?.(`review-mr ${target.project}!${target.iid}: posted -> mr note`);
  return { mr, commentBody };
}
