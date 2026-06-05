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

  it('requests a high item limit to avoid silent truncation', async () => {
    let captured: string[] = [];
    const gh: GhRunner = async (args: string[]): Promise<string> => {
      captured = args;
      return JSON.stringify({ items: [] });
    };
    await new GitHubProjectFetcher({ owner: 'o', projectNumber: 1, repo: 'o/r', gh }).list();
    expect(captured).toEqual(expect.arrayContaining(['--limit', '1000']));
  });

  it('fetches from the repo embedded in a cross-repo id', async () => {
    let captured: string[] = [];
    const gh: GhRunner = async (args: string[]): Promise<string> => {
      captured = args;
      return JSON.stringify({ number: 3, title: 'X', body: '', labels: [] });
    };
    const task = await new GitHubProjectFetcher({ owner: 'o', projectNumber: 1, repo: 'o/default', gh }).fetch('other/repo#3');
    expect(captured).toEqual(expect.arrayContaining(['--repo', 'other/repo']));
    expect(task.id).toBe('other/repo#3');
  });
});
