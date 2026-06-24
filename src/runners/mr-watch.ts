import { fanOut } from '../pipeline/fan-out.js';
import { hasMergeRequestReviewMarker } from './mr-review.js';
import { defaultGlabRunner, encodeProject } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { MergeRequestReviewTarget } from './mr-review.js';

export interface MergeRequestWatchItem extends MergeRequestReviewTarget {
  title: string;
  draft: boolean;
  author: string;
  sha: string;
  labels: string[];
}

export interface MergeRequestWatchPrimitives {
  listReady: () => Promise<MergeRequestWatchItem[]>;
  claim: (item: MergeRequestWatchItem) => Promise<void>;
  review: (item: MergeRequestWatchItem) => Promise<void>;
  markReviewed: (item: MergeRequestWatchItem) => Promise<void>;
  onFailure: (item: MergeRequestWatchItem, error: unknown) => Promise<void>;
}

export interface MergeRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchMergeRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchMergeRequestsLoopOptions extends WatchMergeRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitLabMergeRequestWatchOptions {
  project: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  /** Only review MRs opened by this GitLab username (optional). */
  author?: string;
  glab?: GlabRunner;
  reviewOne: (item: MergeRequestWatchItem) => Promise<void>;
}

interface GlabMrListItem {
  iid?: number;
  title?: string;
  draft?: boolean;
  author?: { username?: string } | null;
  sha?: string;
  labels?: string[];
}

interface GlabMrNoteItem {
  body?: string | null;
  system?: boolean;
}

function mrId(item: MergeRequestWatchItem): string {
  return `${item.project}!${item.iid}`;
}

function isAutomationAuthor(username: string): boolean {
  const lower = username.toLowerCase();
  return lower.includes('vanguard') || lower.endsWith('[bot]') || lower === 'gitlab-ci-token';
}

function parseMrList(
  out: string,
  project: string,
  triggerLabel: string,
  onlyAuthor?: string,
): MergeRequestWatchItem[] {
  const parsed = JSON.parse(out) as GlabMrListItem[];
  return parsed.flatMap((item) => {
    if (item.iid === undefined) return [];
    const author = item.author?.username ?? '';
    const labels = item.labels ?? [];
    const mr: MergeRequestWatchItem = {
      project,
      iid: item.iid,
      title: item.title ?? '',
      draft: item.draft === true,
      author,
      sha: item.sha ?? '',
      labels,
    };
    if (mr.draft) return [];
    if (isAutomationAuthor(author)) return [];
    if (onlyAuthor !== undefined && author !== onlyAuthor) return [];
    if (!labels.includes(triggerLabel)) return [];
    return [mr];
  });
}

function editMrLabels(
  glab: GlabRunner,
  project: string,
  iid: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['mr', 'update', String(iid), '--repo', project];
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  for (const label of labels.add ?? []) args.push('--label', label);
  return glab(args);
}

async function hasExistingReviewForHead(
  glab: GlabRunner,
  item: MergeRequestWatchItem,
): Promise<boolean> {
  if (item.sha === '') return false;
  try {
    const out = await glab([
      'api',
      `projects/${encodeProject(item.project)}/merge_requests/${item.iid}/notes`,
    ]);
    const notes = JSON.parse(out) as GlabMrNoteItem[];
    return notes.some(
      (n) => !n.system && n.body !== undefined && n.body !== null && hasMergeRequestReviewMarker(n.body, item.sha),
    );
  } catch {
    return false;
  }
}

/**
 * GitLab-backed MR review watch primitives. Scoped labels (`vanguard::reviewing`,
 * `vanguard::reviewed`) replace each other automatically on the GitLab side.
 */
export function gitlabMergeRequestWatchPrimitives(
  opts: GitLabMergeRequestWatchOptions,
): MergeRequestWatchPrimitives {
  const glab = opts.glab ?? defaultGlabRunner;
  return {
    listReady: async () => {
      const listArgs = [
        'mr', 'list',
        '--repo', opts.project,
        '--state', 'opened',
        '--label', opts.label,
        '--output', 'json',
      ];
      if (opts.author !== undefined) listArgs.push('--author', opts.author);
      const candidates = parseMrList(await glab(listArgs), opts.project, opts.label, opts.author);
      const ready = await Promise.all(
        candidates.map(async (item): Promise<MergeRequestWatchItem | undefined> =>
          (await hasExistingReviewForHead(glab, item)) ? undefined : item,
        ),
      );
      return ready.filter((item): item is MergeRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      // GitLab scoped labels: adding vanguard::reviewed auto-removes vanguard::reviewing
      editMrLabels(glab, item.project, item.iid, {
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: async (item, error) => {
      try {
        await glab([
          'mr', 'note', 'create',
          String(item.iid),
          '--repo', item.project,
          '-m', `Vanguard MR review failed: ${String(error)}`,
        ]);
      } catch {
        // note posting is best-effort; always restore the trigger label
      }
      await editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        add: [opts.label],
      });
    },
  };
}

type MrWatchKind = 'reviewed' | 'failed' | 'skipped';

/** Run one MR-watch poll: list, claim, review, and mark each ready MR. */
export async function watchMergeRequestsOnce(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsOnceOptions = {},
): Promise<MergeRequestWatchTick> {
  const phase = opts.phase ?? 'watch-mrs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: MrWatchKind }> => {
      const id = mrId(item);
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
        try {
          await primitives.onFailure(item, error);
        } catch (restoreError) {
          const msg = restoreError instanceof Error ? restoreError.message : String(restoreError);
          opts.log?.(`${phase} ${id}: restore failed -> manual label check (${msg})`);
        }
        opts.log?.(`${phase} ${id}: failed -> retry later`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: MrWatchKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Poll GitLab MRs until stopped, running the MR review loop for each ready MR. */
export async function watchMergeRequests(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchMergeRequestsOnce(primitives, opts);
    opts.log?.(
      `watch-mrs: ${tick.reviewed.length} reviewed, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`,
    );
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}
