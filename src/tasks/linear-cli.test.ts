import { describe, it, expect } from 'vitest';
import { LinearCliTaskFetcher, linkLinearIssue } from './linear-cli.js';
import type { LinearCliRunner } from './linear-cli.js';

function runner(payload: unknown): LinearCliRunner {
  return async (): Promise<string> => JSON.stringify(payload);
}

// Real linear-cli 2.0 shapes: `issue view` returns one object with description,
// children.nodes (sub-issues) and comments (by default) but no labels; `issue query` returns
// { nodes: [...] } with labels.nodes (no description/children). The comments field shape varies
// (array vs { nodes: [...] }), so it is parsed defensively.
const viewIssue = {
  identifier: 'TES-1',
  title: 'Test task',
  description: 'the body',
  state: { name: 'Todo' },
  children: { nodes: [{ identifier: 'TES-2', title: 'Sub one' }] },
};
const queryIssue = { identifier: 'TES-1', title: 'Test task', labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] } };

describe('LinearCliTaskFetcher', () => {
  it('fetches via issue view, mapping identifier/title/description and children', async () => {
    const task = await new LinearCliTaskFetcher({ linear: runner(viewIssue) }).fetch('TES-1');
    expect(task).toEqual({
      id: 'TES-1',
      title: 'Test task',
      description: 'the body',
      labels: [],
      children: [{ id: 'TES-2', title: 'Sub one' }],
      comments: [],
    });
  });

  it('defaults children to [] when the issue has none', async () => {
    const task = await new LinearCliTaskFetcher({ linear: runner({ identifier: 'TES-3', title: 'No kids' }) }).fetch('TES-3');
    expect(task.children).toEqual([]);
  });

  it('defaults comments to [] when the issue has none', async () => {
    const task = await new LinearCliTaskFetcher({ linear: runner(viewIssue) }).fetch('TES-1');
    expect(task.comments).toEqual([]);
  });

  it('maps comments in the { nodes: [...] } connection shape (author from user.name)', async () => {
    const issue = {
      identifier: 'TES-1',
      title: 'Test task',
      comments: { nodes: [{ body: 'A spec comment', user: { name: 'alice' } }, { body: '' }] },
    };
    const task = await new LinearCliTaskFetcher({ linear: runner(issue) }).fetch('TES-1');
    expect(task.comments).toEqual([{ author: 'alice', body: 'A spec comment' }]);
  });

  it('maps comments in the array shape (author from author.displayName)', async () => {
    const issue = {
      identifier: 'TES-1',
      title: 'Test task',
      comments: [{ body: 'Another comment', author: { displayName: 'Bob Builder' } }],
    };
    const task = await new LinearCliTaskFetcher({ linear: runner(issue) }).fetch('TES-1');
    expect(task.comments).toEqual([{ author: 'Bob Builder', body: 'Another comment' }]);
  });

  it('lists via issue query, mapping labels.nodes and filtering by label', async () => {
    const fetcher = new LinearCliTaskFetcher({ linear: runner({ nodes: [queryIssue] }) });
    const all = await fetcher.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.labels).toEqual(['bug', 'p1']);
    expect(all[0]?.children).toEqual([]);
    expect(await fetcher.list({ labels: ['nope'] })).toHaveLength(0);
  });

  it('throws when the issue is not found', async () => {
    await expect(new LinearCliTaskFetcher({ linear: runner({}) }).fetch('TES-99')).rejects.toThrow(/not found/);
  });
});

describe('linkLinearIssue', () => {
  it('adds a PR-link comment via the CLI', async () => {
    let seen: string[] = [];
    await linkLinearIssue('TES-1', 'https://example/pr/1', async (args) => {
      seen = args;
      return '';
    });
    expect(seen).toEqual(expect.arrayContaining(['issue', 'comment', 'add', 'TES-1', '--body']));
    expect(seen.join(' ')).toContain('https://example/pr/1');
  });
});
