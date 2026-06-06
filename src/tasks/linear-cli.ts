import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import type { Task, TaskFetcher, TaskFilter } from './fetcher.js';

/** Runs the `linear` CLI and returns stdout. Injected for testing. */
export type LinearCliRunner = (args: string[]) => Promise<string>;

const defaultRunner: LinearCliRunner = async (args: string[]): Promise<string> => (await execa('linear', args)).stdout;

// Verified against linear-cli 2.0: `issue view <id> --json` returns a single issue WITH a
// description but no labels; `issue query --json` returns { nodes: [...] } WITH labels.nodes but
// no description. So fetch() uses view (description) and list() uses query (labels).
interface LinearCliIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  labels?: { nodes?: Array<{ name?: string }> };
}

function toTask(issue: LinearCliIssue): Task {
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name ?? '').filter((name) => name !== '');
  return {
    id: issue.identifier ?? issue.id ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    labels,
  };
}

function parseIssueList(stdout: string): LinearCliIssue[] {
  const data: unknown = JSON.parse(stdout);
  if (Array.isArray(data)) return data as LinearCliIssue[];
  if (data !== null && typeof data === 'object') {
    const obj = data as { nodes?: unknown; issues?: unknown };
    if (Array.isArray(obj.nodes)) return obj.nodes as LinearCliIssue[];
    if (Array.isArray(obj.issues)) return obj.issues as LinearCliIssue[];
  }
  return [];
}

export interface LinearCliOptions {
  team?: string;
  linear?: LinearCliRunner;
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

  /** `issue query --json` (includes labels; description is not returned by query). */
  async list(filter?: TaskFilter): Promise<Task[]> {
    const scope = this.options.team !== undefined ? ['--team', this.options.team] : ['--all-teams'];
    const tasks = parseIssueList(await this.run(['issue', 'query', ...scope, '--json', '--limit', '0'])).map(toTask);
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}

/** Comment a PR link back onto a Linear issue via the CLI (closes the loop). */
export async function linkLinearIssue(issueId: string, prUrl: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await runner(['issue', 'comment', 'add', issueId, '--body', `Vanguard opened a PR for review: ${prUrl}`]);
}
