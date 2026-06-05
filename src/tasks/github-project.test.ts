import { describe, it, expect } from 'vitest';
import { GitHubProjectFetcher } from './github-project.js';
import type { GhRunner } from './github.js';

const itemList = JSON.stringify({
  items: [
    { content: { type: 'Issue', number: 5, title: 'A', body: 'ba', labels: ['bug'], repository: 'SebaBoler/vanguard' } },
    { content: { type: 'DraftIssue', title: 'draft' } },
    { content: { type: 'PullRequest', number: 9, title: 'pr' } },
  ],
});

function fakeGh(): GhRunner {
  return async (args: string[]): Promise<string> =>
    args.includes('item-list') ? itemList : JSON.stringify({ number: 5, title: 'A', body: 'ba', labels: [{ name: 'bug' }] });
}

describe('GitHubProjectFetcher', () => {
  it('lists only issue items from the project board', async () => {
    const fetcher = new GitHubProjectFetcher({ owner: 'SebaBoler', projectNumber: 1, repo: 'SebaBoler/vanguard', gh: fakeGh() });
    const tasks = await fetcher.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ id: 'SebaBoler/vanguard#5', title: 'A', description: 'ba', labels: ['bug'] });
  });

  it('fetches a single issue by id', async () => {
    const fetcher = new GitHubProjectFetcher({ owner: 'SebaBoler', projectNumber: 1, repo: 'SebaBoler/vanguard', gh: fakeGh() });
    const task = await fetcher.fetch('5');
    expect(task.id).toBe('SebaBoler/vanguard#5');
  });
});
