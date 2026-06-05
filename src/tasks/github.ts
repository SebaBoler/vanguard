import { execa } from 'execa';
import type { Task, TaskFetcher, TaskFilter } from './fetcher.js';

export interface GitHubLabel {
  name: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: GitHubLabel[];
}

/** Runs a `gh` subcommand and returns its stdout. Injected so unit tests never call real gh. */
export type GhRunner = (args: string[]) => Promise<string>;

const defaultGhRunner: GhRunner = async (args: string[]): Promise<string> => (await execa('gh', args)).stdout;

function toTask(repo: string, issue: GitHubIssue): Task {
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
  };
}

/** Fetches GitHub issues (via the gh CLI) and maps them to Vanguard tasks. */
export class GitHubTaskFetcher implements TaskFetcher {
  constructor(
    private readonly repo: string,
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const hash = id.indexOf('#');
    const number = hash === -1 ? id : id.slice(hash + 1);
    const out = await this.gh(['issue', 'view', number, '--repo', this.repo, '--json', 'number,title,body,labels']);
    return toTask(this.repo, JSON.parse(out) as GitHubIssue);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const args = ['issue', 'list', '--repo', this.repo, '--json', 'number,title,body,labels', '--state', filter?.state ?? 'open'];
    if (filter?.labels !== undefined && filter.labels.length > 0) args.push('--label', filter.labels.join(','));
    const out = await this.gh(args);
    return (JSON.parse(out) as GitHubIssue[]).map((issue) => toTask(this.repo, issue));
  }
}
