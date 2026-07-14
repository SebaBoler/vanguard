import { describe, it, expect } from 'vitest';
import { issueIID, encodeProject, GitLabTaskFetcher, commentGitlabIssue, editGitlabLabels } from './gitlab.js';

describe('issueIID', () => {
  it('returns bare number unchanged', () => {
    expect(issueIID('42')).toBe('42');
  });
  it('strips group/project# prefix', () => {
    expect(issueIID('group/project#42')).toBe('42');
  });
  it('strips nested group prefix', () => {
    expect(issueIID('group/sub/project#7')).toBe('7');
  });
});

describe('encodeProject', () => {
  it('encodes slash to %2F', () => {
    expect(encodeProject('owner/project')).toBe('owner%2Fproject');
  });
  it('encodes all slashes in nested groups', () => {
    expect(encodeProject('group/sub/project')).toBe('group%2Fsub%2Fproject');
  });
});

describe('GitLabTaskFetcher', () => {
  const fakeIssue = JSON.stringify({
    iid: 42,
    title: 'Fix bug',
    description: 'Details',
    labels: ['backend'],
  });
  const fakeNotes = JSON.stringify([
    { id: 1, body: 'A comment', author: { username: 'alice' }, system: false },
    { id: 2, body: 'closed', author: { username: 'gitlab' }, system: true },
  ]);

  it('fetch returns task with comments, filters system notes', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args.includes('view')) return fakeIssue;
      return fakeNotes;
    };
    const fetcher = new GitLabTaskFetcher('owner/project', glab);
    const task = await fetcher.fetch('owner/project#42');
    expect(task.id).toBe('owner/project#42');
    expect(task.title).toBe('Fix bug');
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]!.author).toBe('alice');
    expect(calls[0]).toContain('42');
  });

  it('list returns tasks without comments', async () => {
    const glab = async () => JSON.stringify([{ iid: 1, title: 'T', description: null, labels: [] }]);
    const fetcher = new GitLabTaskFetcher('owner/project', glab);
    const tasks = await fetcher.list({ labels: ['vanguard'] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.comments).toHaveLength(0);
  });

  it('list passes label filters', async () => {
    const args: string[][] = [];
    const glab = async (a: string[]) => { args.push(a); return '[]'; };
    const fetcher = new GitLabTaskFetcher('g/p', glab);
    await fetcher.list({ labels: ['a', 'b'] });
    const listArgs = args[0]!;
    expect(listArgs.filter((a) => a === '--label')).toHaveLength(2);
  });

  it('list maps state to glab flags (no --state; opened is default)', async () => {
    const args: string[][] = [];
    const glab = async (a: string[]) => { args.push(a); return '[]'; };
    const fetcher = new GitLabTaskFetcher('g/p', glab);
    await fetcher.list();                         // default opened
    await fetcher.list({ state: 'closed' });
    await fetcher.list({ state: 'all' });
    expect(args[0]).not.toContain('--state');     // glab has no --state flag
    expect(args[0]).not.toContain('--closed');    // opened is the default
    expect(args[1]).toContain('--closed');
    expect(args[2]).toContain('--all');
  });
});

describe('commentGitlabIssue', () => {
  it('calls glab issue note create with correct args', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await commentGitlabIssue('g/p', 'g/p#5', 'hello', glab);
    expect(calls[0]).toEqual(['issue', 'note', 'create', '5', '--repo', 'g/p', '-m', 'hello']);
  });
});

describe('editGitlabLabels', () => {
  it('adds and removes labels', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await editGitlabLabels('g/p', 'g/p#3', { add: ['foo'], remove: ['bar'] }, glab);
    expect(calls[0]).toContain('--label');
    expect(calls[0]).toContain('foo');
    expect(calls[0]).toContain('--unlabel');
    expect(calls[0]).toContain('bar');
  });

  it('skips call when no labels to change', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await editGitlabLabels('g/p', 'g/p#3', {}, glab);
    expect(calls).toHaveLength(0);
  });
});

// S9: TaskFilter.limit is STRICTLY conditional — unset keeps watch's argv byte-identical.
it('list() argv is byte-identical to the pre-S9 shape when limit is unset (watch contract)', async () => {
  const calls: string[][] = [];
  const glab = async (args: string[]): Promise<string> => {
    calls.push(args);
    return '[]';
  };
  await new GitLabTaskFetcher('g/p', glab).list({ labels: ['x'] });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'g/p', '--output', 'json', '--label', 'x']);
});

it('list() with limit + all adds -P and --all (the board call); state carried onto the task', async () => {
  const calls: string[][] = [];
  const glab = async (args: string[]): Promise<string> => {
    calls.push(args);
    return JSON.stringify([{ iid: 5, title: 't', description: null, labels: [], state: 'closed' }]);
  };
  const tasks = await new GitLabTaskFetcher('g/p', glab).list({ state: 'all', limit: 50 });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'g/p', '--output', 'json', '--all', '-P', '50']);
  expect(tasks[0]).toMatchObject({ ref: '5', state: 'closed' });
});
