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

export const defaultGhRunner: GhRunner = async (args: string[]): Promise<string> => (await execa('gh', args)).stdout;

/** Strips an optional `owner/repo#` prefix, returning just the numeric part. */
export function issueNumber(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

export function toTask(repo: string, issue: GitHubIssue): Task {
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    children: [], // the gh issue mapping does not fetch sub-issues
  };
}

/** Fetches GitHub issues (via the gh CLI) and maps them to Vanguard tasks. */
export class GitHubTaskFetcher implements TaskFetcher {
  constructor(
    private readonly repo: string,
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const number = issueNumber(id);
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

/** Comment a PR link back onto the source GitHub issue (closes the loop). */
export async function linkPullRequest(
  repo: string,
  issueRef: string,
  prUrl: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const number = issueNumber(issueRef);
  await gh(['issue', 'comment', number, '--repo', repo, '--body', `Vanguard opened a PR for review: ${prUrl}`]);
}
