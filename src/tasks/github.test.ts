import { describe, it, expect } from 'vitest';
import { GitHubTaskFetcher } from './github.js';
import type { GhRunner } from './github.js';

function fakeGh(): GhRunner {
  const issue = { number: 7, title: 'Bug', body: 'desc', labels: [{ name: 'bug' }] };
  return async (args: string[]): Promise<string> =>
    args.includes('view') ? JSON.stringify(issue) : JSON.stringify([issue]);
}

describe('GitHubTaskFetcher', () => {
  it('maps an issue to a Task (id = repo#number)', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task).toEqual({ id: 'SebaBoler/vanguard#7', title: 'Bug', description: 'desc', labels: ['bug'] });
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
});
