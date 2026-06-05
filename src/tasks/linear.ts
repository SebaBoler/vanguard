import { LinearClient } from '@linear/sdk';
import type { Task, TaskFetcher, TaskFilter } from './fetcher.js';

export interface LinearLabelNode {
  name: string;
}

export interface LinearIssueLike {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  labels: () => Promise<{ nodes: LinearLabelNode[] }>;
}

export interface LinearClientLike {
  issue: (id: string) => Promise<LinearIssueLike>;
  issues: () => Promise<{ nodes: LinearIssueLike[] }>;
}

async function toTask(issue: LinearIssueLike): Promise<Task> {
  const labels = await issue.labels();
  return {
    id: issue.identifier ?? issue.id,
    title: issue.title,
    description: issue.description ?? '',
    labels: labels.nodes.map((node) => node.name),
  };
}

/** Fetches Linear issues and maps them to Vanguard tasks. Depends only on the methods it uses. */
export class LinearTaskFetcher implements TaskFetcher {
  constructor(private readonly client: LinearClientLike) {}

  async fetch(id: string): Promise<Task> {
    return toTask(await this.client.issue(id));
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const result = await this.client.issues();
    const tasks = await Promise.all(result.nodes.map(toTask));
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}

/** Wire a fetcher against the real Linear API (LINEAR_API_KEY). */
export function createLinearTaskFetcher(apiKey: string): LinearTaskFetcher {
  return new LinearTaskFetcher(new LinearClient({ apiKey }) as unknown as LinearClientLike);
}

/** Minimal client surface for commenting (satisfied structurally by LinearClient). */
export interface LinearCommentClient {
  createComment: (input: { issueId: string; body: string }) => Promise<unknown>;
}

/** Comment a PR link back onto the source Linear issue (closes the loop). */
export async function linkLinearIssue(client: LinearCommentClient, issueId: string, prUrl: string): Promise<void> {
  await client.createComment({ issueId, body: `Vanguard opened a PR for review: ${prUrl}` });
}
