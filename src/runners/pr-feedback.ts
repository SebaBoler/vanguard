import { hasPullRequestReviewMarker } from './pr-review.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { PullRequestReviewTarget } from './pr-review.js';
import type { GhRunner } from '../tasks/github.js';

export interface FeedbackItem {
  source: 'thread' | 'review' | 'comment';
  /** Present only when source === 'thread'. */
  threadId?: string;
  /** True when the owning thread is resolved; undefined for review/comment sources. */
  isResolved?: boolean;
  author: string;
  body: string;
  /** ISO timestamp; empty string when GitHub omits it. */
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  items: FeedbackItem[];
}

export interface PullRequestFeedback {
  headRefOid: string;
  /** ISO timestamp of the head commit; empty string when unavailable. */
  headCommittedDate: string;
  isDraft: boolean;
  items: FeedbackItem[];
  threads: ReviewThread[];
}

export interface ActionableOptions {
  /** Extra logins to treat as bots (in addition to the built-in heuristic). */
  botLogins?: string[];
  /** Current PR head SHA — items with this SHA's marker in their body are skipped. */
  headRefOid: string;
  /**
   * Override for the watermark timestamp. Defaults to PullRequestFeedback.headCommittedDate.
   * Pass '' to skip the watermark filter entirely (rely on resolve-state alone).
   */
  headCommittedDate?: string;
}

const FEEDBACK_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!){',
  '  repository(owner:$owner,name:$name){',
  '    pullRequest(number:$number){',
  '      isDraft headRefOid',
  '      commits(last:1){ nodes{ commit{ committedDate } } }',
  '      reviewThreads(first:100){',
  '        nodes{ id isResolved comments(first:50){ nodes{ author{ login } body createdAt } } }',
  '      }',
  '      reviews(first:100){ nodes{ author{ login } body state submittedAt } }',
  '      comments(first:100){ nodes{ author{ login } body createdAt } }',
  '    }',
  '  }',
  '}',
].join('\n');

interface GqlComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
}

interface GqlReview {
  author?: { login?: string } | null;
  body?: string;
  state?: string;
  submittedAt?: string;
}

interface GqlThread {
  id?: string;
  isResolved?: boolean;
  comments?: { nodes?: GqlComment[] };
}

interface GqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        isDraft?: boolean;
        headRefOid?: string;
        commits?: { nodes?: Array<{ commit?: { committedDate?: string } }> };
        reviewThreads?: { nodes?: GqlThread[] };
        reviews?: { nodes?: GqlReview[] };
        comments?: { nodes?: GqlComment[] };
      };
    };
  };
}

function warnTruncated(nodes: unknown[], kind: string, prefix: string, log?: (s: string) => void): void {
  if (nodes.length >= 100) log?.(`${prefix}: ${kind} truncated at 100`);
}

export async function fetchPullRequestFeedback(
  target: PullRequestReviewTarget,
  gh: GhRunner = defaultGhRunner,
  log?: (line: string) => void,
): Promise<PullRequestFeedback> {
  const slash = target.repoSlug.indexOf('/');
  if (slash === -1) throw new Error(`Invalid repoSlug: ${target.repoSlug}`);
  const owner = target.repoSlug.slice(0, slash);
  const repoName = target.repoSlug.slice(slash + 1);

  const out = await gh([
    'api', 'graphql',
    '-f', `query=${FEEDBACK_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `name=${repoName}`,
    '-F', `number=${target.number}`,
  ]);

  const response = JSON.parse(out) as GqlResponse;
  const pr = response.data?.repository?.pullRequest;

  const headRefOid = pr?.headRefOid ?? '';
  const isDraft = pr?.isDraft ?? false;
  const headCommittedDate = pr?.commits?.nodes?.[0]?.commit?.committedDate ?? '';

  const threads: ReviewThread[] = [];
  const items: FeedbackItem[] = [];
  const prefix = `revise-pr ${target.repoSlug}#${target.number}`;

  const threadNodes = pr?.reviewThreads?.nodes ?? [];
  warnTruncated(threadNodes, 'review threads', prefix, log);

  for (const thread of threadNodes) {
    const threadId = thread?.id ?? '';
    const isResolved = thread?.isResolved ?? false;
    const threadItems: FeedbackItem[] = [];

    for (const comment of thread?.comments?.nodes ?? []) {
      const item: FeedbackItem = {
        source: 'thread',
        threadId,
        isResolved,
        author: comment?.author?.login ?? '',
        body: comment?.body ?? '',
        createdAt: comment?.createdAt ?? '',
      };
      threadItems.push(item);
      items.push(item);
    }

    threads.push({ id: threadId, isResolved, items: threadItems });
  }

  const reviewNodes = pr?.reviews?.nodes ?? [];
  warnTruncated(reviewNodes, 'reviews', prefix, log);

  for (const review of reviewNodes) {
    items.push({
      source: 'review',
      author: review?.author?.login ?? '',
      body: review?.body ?? '',
      createdAt: review?.submittedAt ?? '',
    });
  }

  const commentNodes = pr?.comments?.nodes ?? [];
  warnTruncated(commentNodes, 'comments', prefix, log);

  for (const comment of commentNodes) {
    items.push({
      source: 'comment',
      author: comment?.author?.login ?? '',
      body: comment?.body ?? '',
      createdAt: comment?.createdAt ?? '',
    });
  }

  return { headRefOid, headCommittedDate, isDraft, items, threads };
}

function isBotAuthor(login: string, extraBotLogins: string[]): boolean {
  const lower = login.toLowerCase();
  return (
    lower.includes('vanguard') ||
    lower.endsWith('[bot]') ||
    lower === 'github-actions' ||
    extraBotLogins.some((b) => lower === b.toLowerCase())
  );
}

/**
 * Filter PullRequestFeedback down to items Vanguard should act on this round.
 * Drops: bot-authored items, items carrying the current head's PR-review marker,
 * items in resolved threads, and items older than the head commit (watermark).
 */
export function selectActionableFeedback(fb: PullRequestFeedback, opts: ActionableOptions): FeedbackItem[] {
  const extraBots = opts.botLogins ?? [];
  const watermark = opts.headCommittedDate !== undefined ? opts.headCommittedDate : fb.headCommittedDate;

  return fb.items.filter((item) => {
    if (isBotAuthor(item.author, extraBots)) return false;
    if (hasPullRequestReviewMarker(item.body, opts.headRefOid)) return false;
    if (item.isResolved === true) return false;
    if (watermark !== '' && item.createdAt !== '' && item.createdAt <= watermark) return false;
    return true;
  });
}

const SOURCE_LABEL: Record<FeedbackItem['source'], string> = {
  thread: 'inline thread',
  review: 'review summary',
  comment: 'PR comment',
};

/**
 * Build the implementer prompt for a revision round.
 * Embeds PR identity, diff, and a numbered list of actionable feedback grouped by source.
 */
export function buildRevisionPrompt(
  pr: { repoSlug: string; number: number; headRefOid: string; title: string; diff: string },
  actionable: FeedbackItem[],
): string {
  const feedbackSection =
    actionable.length === 0
      ? '(no actionable feedback)'
      : actionable
          .map((item, i) => `${i + 1}. [${SOURCE_LABEL[item.source]}] @${item.author}:\n${item.body.trim()}`)
          .join('\n\n');

  return [
    '<task_instructions>',
    `PR: ${pr.repoSlug}#${pr.number}`,
    `Head SHA: ${pr.headRefOid}`,
    `Title: ${pr.title}`,
    '',
    'Human review feedback to address:',
    feedbackSection,
    '',
    '<diff>',
    pr.diff,
    '</diff>',
    '',
    'Apply the requested fixes in the repo. Keep changes minimal and scoped to the feedback. Run typecheck/tests after making changes.',
    'When done, write exactly <promise>COMPLETE</promise>.',
    '</task_instructions>',
  ].join('\n');
}

const REPLY_MUTATION = [
  'mutation($threadId:ID!,$body:String!){',
  '  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){',
  '    comment{ id }',
  '  }',
  '}',
].join('\n');

const RESOLVE_MUTATION = [
  'mutation($threadId:ID!){',
  '  resolveReviewThread(input:{threadId:$threadId}){',
  '    thread{ id }',
  '  }',
  '}',
].join('\n');

/** Post a reply to a review thread and then resolve it. */
export async function replyAndResolveThread(
  threadId: string,
  body: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await gh(['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-F', `threadId=${threadId}`, '-f', `body=${body}`]);
  await gh(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-F', `threadId=${threadId}`]);
}

const REVISION_MARKER_RE = /<!--\s*vanguard-revision:/;

/** Count how many revision rounds Vanguard has already completed on this PR. */
export async function countRevisionRounds(target: PullRequestReviewTarget, gh: GhRunner = defaultGhRunner): Promise<number> {
  const out = await gh(['pr', 'view', String(target.number), '--repo', target.repoSlug, '--json', 'comments,reviews']);
  const view = JSON.parse(out) as { comments?: Array<{ body?: string }>; reviews?: Array<{ body?: string }> };
  const bodies = [...(view.comments ?? []), ...(view.reviews ?? [])].map((e) => e.body ?? '');
  return bodies.filter((b) => REVISION_MARKER_RE.test(b)).length;
}

/** Marker embedded in revision replies for round-counting and non-recursion. */
export const revisionMarker = (headRefOid: string): string => `<!-- vanguard-revision: ${headRefOid} -->`;
