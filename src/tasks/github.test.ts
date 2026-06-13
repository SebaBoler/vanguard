import { describe, it, expect } from 'vitest';
import { GitHubTaskFetcher, linkPullRequest } from './github.js';
import type { GhRunner } from './github.js';

function fakeGh(): GhRunner {
  const issue = { number: 7, title: 'Bug', body: 'desc', labels: [{ name: 'bug' }] };
  return async (args: string[]): Promise<string> =>
    args.includes('view') ? JSON.stringify(issue) : JSON.stringify([issue]);
}

describe('GitHubTaskFetcher', () => {
  it('maps an issue to a Task (id = repo#number)', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task).toEqual({ id: 'SebaBoler/vanguard#7', title: 'Bug', description: 'desc', labels: ['bug'], children: [], comments: [] });
  });

  it('accepts a repo#number reference', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('SebaBoler/vanguard#7');
    expect(task.id).toBe('SebaBoler/vanguard#7');
  });

  it('lists open issues', async () => {
    const list = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('SebaBoler/vanguard#7');
  });

  it('maps comments from the JSON response into Task.comments', async () => {
    const issueWithComments = {
      number: 7,
      title: 'Bug',
      body: 'desc',
      labels: [{ name: 'bug' }],
      comments: [
        { author: { login: 'alice' }, body: 'First comment', createdAt: '2024-01-01T00:00:00Z' },
        { author: { login: 'bob' }, body: 'Second comment', createdAt: '2024-01-02T00:00:00Z' },
      ],
    };
    const gh: GhRunner = async (): Promise<string> => JSON.stringify(issueWithComments);
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', gh).fetch('7');
    expect(task.comments).toEqual([
      { author: 'alice', body: 'First comment' },
      { author: 'bob', body: 'Second comment' },
    ]);
  });

  it('defaults comments to [] when the issue has no comments field', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task.comments).toEqual([]);
  });
});

describe('linkPullRequest', () => {
  it('comments the PR url onto the issue', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return '';
    };
    await linkPullRequest('SebaBoler/vanguard', 'SebaBoler/vanguard#7', 'https://example/pr/1', gh);
    expect(calls[0]).toEqual(expect.arrayContaining(['issue', 'comment', '7', '--repo', 'SebaBoler/vanguard']));
    expect(calls[0]?.join(' ')).toContain('https://example/pr/1');
  });
});
