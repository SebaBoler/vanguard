import { LinearCliTaskFetcher, setLinearState, commentLinearIssue } from '../tasks/linear-cli.js';
import { GitHubTaskFetcher, editGithubLabels, commentGithubIssue, defaultGhRunner } from '../tasks/github.js';
import { runLinearIssue } from './linear.js';
import { runGithubIssue } from './github.js';
import { fanOut } from '../pipeline/fan-out.js';
import type { RunLinearIssueDeps } from './linear.js';
import type { RunGithubIssueDeps } from './github.js';
import type { LinearCliRunner } from '../tasks/linear-cli.js';
import type { GhRunner } from '../tasks/github.js';

export interface WatchPrimitives {
  /** List issues currently ready to run (trigger state + label). */
  listReady: () => Promise<Array<{ id: string }>>;
  /** Claim an issue so a later poll won't pick it again (e.g. move it out of the trigger state). */
  claim: (id: string) => Promise<void>;
  runOne: (id: string) => Promise<{ prUrl?: string }>;
  /** Mark an issue as in review (a PR opened). */
  review: (id: string) => Promise<void>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface WatchTick {
  opened: string[];
  noChange: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
}

type Kind = 'opened' | 'noChange' | 'failed' | 'skipped';

/**
 * One poll: claim each ready issue (skipping any that can't be claimed), run it, then move it to
 * review when a PR opens or report the failure. Pure orchestration over injected primitives, so the
 * claim-before-run ordering and dedup are unit-testable without Linear.
 */
export async function watchOnce(primitives: WatchPrimitives, opts: { concurrency?: number } = {}): Promise<WatchTick> {
  const ready = await primitives.listReady();
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: Kind }> => {
      try {
        await primitives.claim(item.id);
      } catch {
        return { id: item.id, kind: 'skipped' };
      }
      try {
        const { prUrl } = await primitives.runOne(item.id);
        if (prUrl === undefined) return { id: item.id, kind: 'noChange' };
        await primitives.review(item.id);
        return { id: item.id, kind: 'opened' };
      } catch (error) {
        await primitives.onFailure(item.id, error);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts,
  );
  const ids = (kind: Kind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { opened: ids('opened'), noChange: ids('noChange'), failed: ids('failed'), skipped: ids('skipped') };
}

export interface WatchLinearOptions {
  deps: RunLinearIssueDeps;
  label: string;
  /** Linear state TYPE to poll (triage/backlog/unstarted/started/...); default 'unstarted' (Todo-like). */
  triggerState?: string;
  /** State NAME to move an issue to on claim, e.g. 'In Progress'. */
  claimedState: string;
  /** State NAME after a PR opens, e.g. 'In Review'. */
  reviewState: string;
  team?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  linear?: LinearCliRunner;
}

/** Build the real Linear-backed primitives: state+label trigger, claim and review via state changes. */
export function linearWatchPrimitives(opts: WatchLinearOptions): WatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
  });
  const trigger = opts.triggerState ?? 'unstarted';
  return {
    listReady: () => fetcher.list({ labels: [opts.label], state: trigger }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runOne: (id) => runLinearIssue(id, opts.deps),
    review: (id) => setLinearState(id, opts.reviewState, opts.linear),
    onFailure: (id, error) => commentLinearIssue(id, `Vanguard run failed: ${String(error)}`, opts.linear),
  };
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

interface LoopControls {
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Poll on an interval, running each newly-ready item. Stops on signal or after one pass (once). */
async function runWatchLoop(primitives: WatchPrimitives, opts: LoopControls, log: (msg: string) => void): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchOnce(primitives, { ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) });
    log(`watch: ${tick.opened.length} PR(s), ${tick.noChange.length} no-change, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

/** Poll Linear and run each newly-ready issue. */
export async function watchLinear(opts: WatchLinearOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(linearWatchPrimitives(opts), opts, log);
}

export interface WatchGithubOptions {
  deps: RunGithubIssueDeps;
  /** Trigger label: open issues with this label are picked. */
  label: string;
  /** Label added on claim (and the trigger label removed) so re-polls skip it, e.g. 'vanguard:running'. */
  claimedLabel: string;
  /** Label added after a PR opens, e.g. 'vanguard:review'. */
  reviewLabel: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/** GitHub-issue primitives: trigger by label, claim/review by swapping labels (issues have no states). */
export function githubIssueWatchPrimitives(opts: WatchGithubOptions): WatchPrimitives {
  const repo = opts.deps.repoSlug;
  const fetcher = new GitHubTaskFetcher(repo, opts.gh);
  return {
    listReady: async () => (await fetcher.list({ labels: [opts.label] })).map((task) => ({ id: task.id })),
    claim: (id) => editGithubLabels(repo, id, { remove: [opts.label], add: [opts.claimedLabel] }, opts.gh),
    runOne: (id) => runGithubIssue(id, opts.deps),
    review: (id) => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, opts.gh),
    onFailure: (id, error) => commentGithubIssue(repo, id, `Vanguard run failed: ${String(error)}`, opts.gh),
  };
}

/** Poll GitHub Issues and run each newly-ready (labeled) issue. */
export async function watchGithub(opts: WatchGithubOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubIssueWatchPrimitives(opts), opts, log);
}

export interface WatchGithubProjectOptions {
  deps: RunGithubIssueDeps;
  projectNumber: number;
  /** Owner of the project (default: first segment of deps.repoSlug). */
  owner?: string;
  /** Only pick up board items with this label (optional). */
  label?: string;
  /** Status option name for ready-to-run items (e.g. 'Todo'). */
  triggerStatus: string;
  /** Status option name set on claim so re-polls skip the item. */
  claimedStatus: string;
  /** Status option name set after a PR opens. */
  reviewStatus: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * GitHub Projects v2 primitives: trigger by Status field value, claim/review by updating the Status
 * field via `gh project item-edit`. Field and option IDs are resolved once via `gh project field-list`
 * and `gh project view` and then cached for the lifetime of the primitives object.
 *
 * The Status option names (triggerStatus / claimedStatus / reviewStatus) must match the exact names
 * configured on the project's Status field — find them with:
 *   gh project field-list <projectNumber> --owner <owner> --format json
 */
interface ProjectMeta {
  projectNodeId: string;
  statusFieldId: string;
  statusOptionIds: Map<string, string>;
}

export function githubProjectWatchPrimitives(opts: WatchGithubProjectOptions): WatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  const owner = opts.owner ?? (opts.deps.repoSlug.split('/')[0] as string);
  const repo = opts.deps.repoSlug;
  const projectNumber = String(opts.projectNumber);

  // Populated on each listReady call; claim/review look up the project item node ID here.
  const itemNodeIds = new Map<string, string>();

  // Single cached promise: fetches project node ID and Status field in parallel, resolved once.
  let projectMeta: Promise<ProjectMeta> | undefined;

  function getProjectMeta(): Promise<ProjectMeta> {
    if (projectMeta === undefined) {
      projectMeta = Promise.all([
        gh(['project', 'view', projectNumber, '--owner', owner, '--format', 'json'])
          .then((out) => (JSON.parse(out) as { id: string }).id),
        gh(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']).then((out) => {
          const parsed = JSON.parse(out) as {
            fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
          };
          const field = parsed.fields.find((f) => f.name === 'Status');
          if (field === undefined) throw new Error(`GitHub project ${opts.projectNumber} has no "Status" field`);
          return { fieldId: field.id, optionIds: new Map(field.options?.map((o) => [o.name, o.id] as [string, string]) ?? []) };
        }),
      ]).then(([projectNodeId, { fieldId: statusFieldId, optionIds: statusOptionIds }]) => ({
        projectNodeId,
        statusFieldId,
        statusOptionIds,
      }));
    }
    return projectMeta;
  }

  async function setStatus(issueRef: string, statusName: string): Promise<void> {
    const { projectNodeId, statusFieldId, statusOptionIds } = await getProjectMeta();
    const nodeId = itemNodeIds.get(issueRef);
    if (nodeId === undefined) throw new Error(`Project item for ${issueRef} not in cache; call listReady first`);
    const optionId = statusOptionIds.get(statusName);
    if (optionId === undefined) throw new Error(`Status option "${statusName}" not found in project ${opts.projectNumber}`);
    await gh(['project', 'item-edit', '--id', nodeId, '--project-id', projectNodeId, '--field-id', statusFieldId, '--single-select-option-id', optionId]);
  }

  return {
    listReady: async () => {
      const out = await gh(['project', 'item-list', projectNumber, '--owner', owner, '--format', 'json', '--limit', '1000']);
      const parsed = JSON.parse(out) as {
        items: Array<{
          id: string;
          status?: string;
          content?: { type?: string; number?: number; repository?: string; labels?: string[] };
        }>;
      };
      itemNodeIds.clear();
      const ready: Array<{ id: string }> = [];
      for (const item of parsed.items) {
        const content = item.content;
        if (content === undefined || content.type !== 'Issue' || content.number === undefined) continue;
        const issueRef = `${content.repository ?? repo}#${content.number}`;
        itemNodeIds.set(issueRef, item.id);
        if (item.status !== opts.triggerStatus) continue;
        if (opts.label !== undefined && !(content.labels ?? []).includes(opts.label)) continue;
        ready.push({ id: issueRef });
      }
      return ready;
    },
    claim: (id) => setStatus(id, opts.claimedStatus),
    runOne: (id) => runGithubIssue(id, opts.deps),
    review: (id) => setStatus(id, opts.reviewStatus),
    onFailure: (id, error) => commentGithubIssue(repo, id, `Vanguard run failed: ${String(error)}`, gh),
  };
}

/** Poll GitHub Projects v2 and run each item in the trigger Status. */
export async function watchGithubProject(opts: WatchGithubProjectOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubProjectWatchPrimitives(opts), opts, log);
}
