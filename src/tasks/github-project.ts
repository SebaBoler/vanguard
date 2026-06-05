import type { Task, TaskFetcher, TaskFilter } from './fetcher.js';
import { defaultGhRunner, issueNumber, toTask } from './github.js';
import type { GhRunner, GitHubIssue } from './github.js';

interface ProjectItemContent {
  type: string;
  number?: number;
  title?: string;
  body?: string | null;
  labels?: string[];
  repository?: string;
}

interface ProjectItem {
  content?: ProjectItemContent;
}

interface ProjectItemList {
  items: ProjectItem[];
}

const DEFAULT_LIMIT = 1000;

export interface GitHubProjectFetcherOptions {
  owner: string;
  projectNumber: number;
  repo: string;
  gh?: GhRunner;
  limit?: number;
}

/** Reads issues from a GitHub Projects v2 board (via `gh project item-list`) and maps them to tasks. */
export class GitHubProjectFetcher implements TaskFetcher {
  constructor(private readonly options: GitHubProjectFetcherOptions) {}

  private get gh(): GhRunner {
    return this.options.gh ?? defaultGhRunner;
  }

  async fetch(id: string): Promise<Task> {
    const hashIndex = id.indexOf('#');
    const repo = hashIndex > 0 && id.slice(0, hashIndex).includes('/') ? id.slice(0, hashIndex) : this.options.repo;
    const out = await this.gh(['issue', 'view', issueNumber(id), '--repo', repo, '--json', 'number,title,body,labels']);
    return toTask(repo, JSON.parse(out) as GitHubIssue);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const out = await this.gh([
      'project',
      'item-list',
      String(this.options.projectNumber),
      '--owner',
      this.options.owner,
      '--format',
      'json',
      '--limit',
      String(this.options.limit ?? DEFAULT_LIMIT),
    ]);
    const parsed = JSON.parse(out) as ProjectItemList;
    const tasks: Task[] = [];
    for (const item of parsed.items) {
      const content = item.content;
      if (content === undefined || content.type !== 'Issue' || content.number === undefined) continue;
      tasks.push({
        id: `${content.repository ?? this.options.repo}#${content.number}`,
        title: content.title ?? '',
        description: content.body ?? '',
        labels: content.labels ?? [],
      });
    }
    // filter.state is intentionally not applied here: Projects v2 boards organise items by their own
    // Status field rather than the issue open/closed state, so a generic state filter is meaningless.
    // Label filtering is still honoured below.
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}
