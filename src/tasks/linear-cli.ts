import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

/** Runs the `linear` CLI and returns stdout. Injected for testing. */
export type LinearCliRunner = (args: string[]) => Promise<string>;

const defaultRunner: LinearCliRunner = async (args: string[]): Promise<string> => (await execa('linear', args)).stdout;

// `issue view <id> --json` returns a single issue WITH a description, children.nodes (sub-issues) and
// comments (included by default; `--no-comments` excludes them) but no labels — so fetch() uses it.
// The comments field shape varies (array vs { nodes: [...] }) and author is exposed under user/author
// with name/displayName, so it is parsed defensively.
//
// list() does NOT use the CLI — see the note on list(). An earlier version shelled `issue query`,
// which does not exist in the installed CLI (this file previously claimed "verified against
// linear-cli 2.0"; the CLI in play is schpet v1.11.1). The same LinearCliIssue shape is reused for
// the GraphQL nodes, which return the same fields.
interface LinearCliActor {
  name?: string;
  displayName?: string;
}

interface LinearCliCommentNode {
  body?: string | null;
  user?: LinearCliActor;
  author?: LinearCliActor;
}

interface LinearCliIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  labels?: { nodes?: Array<{ name?: string }> };
  children?: { nodes?: Array<{ identifier?: string; id?: string; title?: string }> };
  comments?: LinearCliCommentNode[] | { nodes?: LinearCliCommentNode[] };
}

/** Accepts comments as either an array or a { nodes: [...] } connection; unknown shapes -> []. */
function parseComments(comments: LinearCliIssue['comments']): TaskComment[] {
  const nodes = Array.isArray(comments) ? comments : (comments?.nodes ?? []);
  return nodes
    .map((node) => ({
      author: node.user?.name ?? node.user?.displayName ?? node.author?.name ?? node.author?.displayName ?? '',
      body: node.body ?? '',
    }))
    .filter((comment) => comment.body !== ''); // attachment-only comments have no body; skip for v1
}

function toTask(issue: LinearCliIssue): Task {
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name ?? '').filter((name) => name !== '');
  const children = (issue.children?.nodes ?? [])
    .map((child) => ({ id: child.identifier ?? child.id ?? '', title: child.title ?? '' }))
    .filter((child) => child.id !== '');
  return {
    id: issue.identifier ?? issue.id ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    labels,
    children,
    comments: parseComments(issue.comments),
  };
}

/** One Linear GraphQL round-trip. Injected for testing; the default posts to the public API. */
export type LinearGraphql = (body: { query: string; variables: Record<string, unknown> }) => Promise<unknown>;

const LINEAR_API = 'https://api.linear.app/graphql';

/**
 * The credential, in the order the CLI itself resolves it. `LINEAR_API_KEY` first because the commands
 * that list issues already require it (`cli/watch.ts` and `sidecar/deps.ts` both hard-throw without
 * it), so it is present exactly where list() is used. The `linear auth token` fallback covers the
 * desktop, which inherits a login rather than an env var.
 */
async function linearToken(run: LinearCliRunner): Promise<string> {
  const fromEnv = process.env['LINEAR_API_KEY'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const token = (await run(['auth', 'token'])).trim();
  if (token === '') throw new VanguardError('No Linear credential — set LINEAR_API_KEY or run `linear auth login`.');
  return token;
}

/** POST one query. The token is sent BARE, not as `Bearer` — `linear auth login` mints a personal API
 *  key, which Linear authorizes unprefixed. (If the CLI ever moves to OAuth, this becomes `Bearer`.) */
async function postGraphql(token: string, body: { query: string; variables: Record<string, unknown> }): Promise<unknown> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new VanguardError(`Linear API request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/** One page of the issue list. `state { type }` is what TaskFilter.state selects on. */
const LIST_QUERY = `query($f: IssueFilter, $after: String) {
  issues(first: 100, after: $after, filter: $f) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description state { name type } labels { nodes { name } } }
  }
}`;

interface IssuePage {
  data?: { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: LinearCliIssue[] } };
  errors?: { message?: string }[];
}

export interface LinearCliOptions {
  team?: string;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
}

/** Fetches Linear issues via the `linear` CLI (lighter than the SDK; needs `linear auth login` or LINEAR_API_KEY). */
export class LinearCliTaskFetcher implements TaskFetcher {
  constructor(private readonly options: LinearCliOptions = {}) {}

  private get run(): LinearCliRunner {
    return this.options.linear ?? defaultRunner;
  }

  /** `issue view <id> --json` (includes the description; labels are not returned by view). */
  async fetch(id: string): Promise<Task> {
    const issue = JSON.parse(await this.run(['issue', 'view', id, '--json'])) as LinearCliIssue;
    if (issue.identifier === undefined && issue.id === undefined) {
      throw new VanguardError(`Linear issue not found: ${id}`);
    }
    return toTask(issue);
  }

  private get graphql(): LinearGraphql {
    const injected = this.options.graphql;
    if (injected !== undefined) return injected;
    const run = this.run;
    return async (body) => postGraphql(await linearToken(run), body);
  }

  /**
   * All issues matching the filter, over Linear's GraphQL API.
   *
   * NOT the `linear` CLI: it has no machine-readable issue list (schpet v1.11.1 has no `issue query`
   * at all, and `issue list` has no `--json`), and which flags exist varies by CLI version. The API
   * does not. This method used to shell `issue query` — a command that does not exist — which broke
   * `vanguard watch --linear` on every poll while the unit tests, all using a fake runner, stayed green.
   *
   * `filter.state` is a Linear state TYPE (triage/backlog/unstarted/started/completed/canceled) and
   * MUST reach the query: without it a watcher polls every issue in the team and would claim ones that
   * are already completed. Pagination runs to exhaustion for the same reason — a watcher that silently
   * caps its work queue is a bug, not a limit.
   */
  async list(filter?: TaskFilter): Promise<Task[]> {
    const issueFilter: Record<string, unknown> = {};
    if (this.options.team !== undefined) issueFilter['team'] = { key: { eq: this.options.team } };
    if (filter?.state !== undefined) issueFilter['state'] = { type: { eq: filter.state } };

    const issues: LinearCliIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const page = (await this.graphql({
        query: LIST_QUERY,
        variables: { f: issueFilter, ...(after !== undefined ? { after } : {}) },
      })) as IssuePage;
      // A GraphQL error arrives with HTTP 200 and no `data`. Returning [] here would be indistinguishable
      // from "no work to do" — the watcher would idle forever against a broken query.
      const errors = page.errors;
      if (errors !== undefined && errors.length > 0) {
        throw new VanguardError(`Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`);
      }
      const connection = page.data?.issues;
      issues.push(...(connection?.nodes ?? []));
      const next = connection?.pageInfo;
      if (next?.hasNextPage !== true || next.endCursor === null || next.endCursor === undefined) break;
      after = next.endCursor;
    }

    const tasks = issues.map(toTask);
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}

/** Move a Linear issue to a workflow state (by name or type), e.g. to claim it ("In Progress"). */
export async function setLinearState(issueId: string, state: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await runner(['issue', 'update', issueId, '--state', state]);
}

/** Add a freeform comment to a Linear issue (e.g. to report a failed run). */
export async function commentLinearIssue(issueId: string, body: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await runner(['issue', 'comment', 'add', issueId, '--body', body]);
}

/** Comment a PR link back onto a Linear issue via the CLI (closes the loop). */
export async function linkLinearIssue(issueId: string, prUrl: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await commentLinearIssue(issueId, `Vanguard opened a PR for review: ${prUrl}`, runner);
}
