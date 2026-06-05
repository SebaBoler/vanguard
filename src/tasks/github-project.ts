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

export interface GitHubProjectFetcherOptions {
  owner: string;
  projectNumber: number;
  repo: string;
  gh?: GhRunner;
}

/** Reads issues from a GitHub Projects v2 board (via `gh project item-list`) and maps them to tasks. */
export class GitHubProjectFetcher implements TaskFetcher {
  constructor(private readonly options: GitHubProjectFetcherOptions) {}

  private get gh(): GhRunner {
    return this.options.gh ?? defaultGhRunner;
  }

  async fetch(id: string): Promise<Task> {
    const number = issueNumber(id);
    const out = await this.gh(['issue', 'view', number, '--repo', this.options.repo, '--json', 'number,title,body,labels']);
    return toTask(this.options.repo, JSON.parse(out) as GitHubIssue);
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
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}
