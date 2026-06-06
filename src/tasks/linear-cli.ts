import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import type { Task, TaskFetcher, TaskFilter } from './fetcher.js';

/** Runs the `linear` CLI and returns stdout. Injected for testing. */
export type LinearCliRunner = (args: string[]) => Promise<string>;

const defaultRunner: LinearCliRunner = async (args: string[]): Promise<string> => (await execa('linear', args)).stdout;

// NOTE: the linear-cli --json schema is not officially documented; this mapper is tolerant and
// should be confirmed against real `linear issue query --json` output, then tightened.
interface LinearCliIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  labels?: Array<string | { name?: string }>;
}

function toTask(issue: LinearCliIssue): Task {
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name !== '');
  return {
    id: issue.identifier ?? issue.id ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    labels,
  };
}

function parseIssues(stdout: string): LinearCliIssue[] {
  const data: unknown = JSON.parse(stdout);
  if (Array.isArray(data)) return data as LinearCliIssue[];
  if (data !== null && typeof data === 'object') {
    const obj = data as { issues?: unknown; nodes?: unknown };
    if (Array.isArray(obj.issues)) return obj.issues as LinearCliIssue[];
    if (Array.isArray(obj.nodes)) return obj.nodes as LinearCliIssue[];
  }
  return [];
}

export interface LinearCliOptions {
  team?: string;
  linear?: LinearCliRunner;
}

/** Fetches Linear issues via the `linear` CLI (lighter than the SDK; needs `linear auth login`). */
export class LinearCliTaskFetcher implements TaskFetcher {
  constructor(private readonly options: LinearCliOptions = {}) {}

  private get run(): LinearCliRunner {
    return this.options.linear ?? defaultRunner;
  }

  async fetch(id: string): Promise<Task> {
    const teamArgs = this.options.team !== undefined ? ['--team', this.options.team] : [];
    const args = ['issue', 'query', '--search', id, '--json', ...teamArgs];
    const issues = parseIssues(await this.run(args));
    const match = issues.find((issue) => (issue.identifier ?? issue.id) === id) ?? issues[0];
    if (match === undefined) throw new VanguardError(`Linear issue not found: ${id}`);
    return toTask(match);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const teamArgs = this.options.team !== undefined ? ['--team', this.options.team] : [];
    const args = ['issue', 'query', '--json', '--limit', '0', ...teamArgs];
    const tasks = parseIssues(await this.run(args)).map(toTask);
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}
