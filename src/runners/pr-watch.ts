import { fanOut } from '../pipeline/fan-out.js';
import { hasPullRequestReviewMarker } from './pr-review.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';

export interface PullRequestWatchItem {
  repoSlug: string;
  number: number;
  title: string;
  isDraft: boolean;
  author: string;
  headRefOid: string;
  labels: string[];
}

export interface PullRequestWatchPrimitives {
  listReady: () => Promise<PullRequestWatchItem[]>;
  claim: (item: PullRequestWatchItem) => Promise<void>;
  review: (item: PullRequestWatchItem) => Promise<void>;
  markReviewed: (item: PullRequestWatchItem) => Promise<void>;
  onFailure: (item: PullRequestWatchItem, error: unknown) => Promise<void>;
}

export interface PullRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchPullRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchPullRequestsLoopOptions extends WatchPullRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitHubPullRequestWatchOptions {
  repoSlug: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  gh?: GhRunner;
  reviewOne: (item: PullRequestWatchItem) => Promise<void>;
}

interface GhPullRequestListItem {
  number?: number;
  title?: string;
  isDraft?: boolean;
  author?: { login?: string } | string | null;
  headRefOid?: string;
  labels?: Array<{ name?: string } | string>;
}

interface GhPullRequestReviewBody {
  body?: string | null;
}

interface GhPullRequestReviewView {
  comments?: GhPullRequestReviewBody[];
  reviews?: GhPullRequestReviewBody[];
}

type PullRequestWatchKind = 'reviewed' | 'failed' | 'skipped';

function prId(item: PullRequestWatchItem): string {
  return `${item.repoSlug}#${item.number}`;
}

function labelNames(labels: GhPullRequestListItem['labels']): string[] {
  return (labels ?? []).flatMap((label) => {
    if (typeof label === 'string') return [label];
    return typeof label.name === 'string' ? [label.name] : [];
  });
}

function authorLogin(author: GhPullRequestListItem['author']): string {
  if (typeof author === 'string') return author;
  return author?.login ?? '';
}

function isAutomationAuthor(login: string): boolean {
  const lower = login.toLowerCase();
  return lower.includes('vanguard') || lower.endsWith('[bot]') || lower === 'github-actions';
}

function parsePullRequestList(out: string, repoSlug: string, triggerLabel: string): PullRequestWatchItem[] {
  const parsed = JSON.parse(out) as GhPullRequestListItem[];
  return parsed.flatMap((item) => {
    if (item.number === undefined) return [];
    const labels = labelNames(item.labels);
    const author = authorLogin(item.author);
    const pr: PullRequestWatchItem = {
      repoSlug,
      number: item.number,
      title: item.title ?? '',
      isDraft: item.isDraft === true,
      author,
      headRefOid: item.headRefOid ?? '',
      labels,
    };
    if (pr.isDraft) return [];
    if (isAutomationAuthor(author)) return [];
    if (!labels.includes(triggerLabel)) return [];
    return [pr];
  });
}

function editPullRequestLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['pr', 'edit', String(number), '--repo', repoSlug];
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  for (const label of labels.add ?? []) args.push('--add-label', label);
  return gh(args);
}

async function hasExistingReviewForHead(gh: GhRunner, item: PullRequestWatchItem): Promise<boolean> {
  if (item.headRefOid === '') return false;
  const out = await gh(['pr', 'view', String(item.number), '--repo', item.repoSlug, '--json', 'comments,reviews']);
  const view = JSON.parse(out) as GhPullRequestReviewView;
  const bodies = [...(view.comments ?? []), ...(view.reviews ?? [])].map((entry) => entry.body ?? '');
  return bodies.some((body) => hasPullRequestReviewMarker(body, item.headRefOid));
}

/**
 * GitHub-backed PR review watch primitives. Label state is the dedup mechanism: a PR leaves the
 * trigger label before review starts, so the same head commit is not reviewed again unless a human or
 * automation deliberately re-adds the trigger label.
 */
export function githubPullRequestWatchPrimitives(opts: GitHubPullRequestWatchOptions): PullRequestWatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  return {
    listReady: async () => {
      const candidates = parsePullRequestList(
        await gh([
          'pr',
          'list',
          '--repo',
          opts.repoSlug,
          '--state',
          'open',
          '--label',
          opts.label,
          '--limit',
          '100',
          '--json',
          'number,title,isDraft,author,headRefOid,labels',
        ]),
        opts.repoSlug,
        opts.label,
      );
      const ready = await Promise.all(
        candidates.map(async (item): Promise<PullRequestWatchItem | undefined> =>
          (await hasExistingReviewForHead(gh, item)) ? undefined : item,
        ),
      );
      return ready.filter((item): item is PullRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.reviewingLabel],
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.reviewingLabel],
        add: [opts.label],
      }).then(() => {}),
  };
}

/** Run one PR-watch poll: list, claim, review, and mark each ready PR. */
export async function watchPullRequestsOnce(
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsOnceOptions = {},
): Promise<PullRequestWatchTick> {
  const phase = opts.phase ?? 'watch-prs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: PullRequestWatchKind }> => {
      const id = prId(item);
      try {
        await primitives.claim(item);
        opts.log?.(`${phase} ${id}: claim -> reviewing`);
      } catch {
        opts.log?.(`${phase} ${id}: skipped -> already claimed`);
        return { id, kind: 'skipped' };
      }

      try {
        await primitives.review(item);
        await primitives.markReviewed(item);
        opts.log?.(`${phase} ${id}: reviewed -> marked`);
        return { id, kind: 'reviewed' };
      } catch (error) {
        await primitives.onFailure(item, error);
        opts.log?.(`${phase} ${id}: failed -> retry later`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: PullRequestWatchKind): string[] =>
    results.flatMap((outcome) => (outcome.status === 'fulfilled' && outcome.value.kind === kind ? [outcome.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Poll GitHub PRs until stopped, running the PR review loop for each ready PR. */
export async function watchPullRequests(
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchPullRequestsOnce(primitives, opts);
    opts.log?.(`watch-prs: ${tick.reviewed.length} reviewed, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}
