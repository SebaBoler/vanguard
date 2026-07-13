import { describe, it, expect } from 'vitest';
import { createGithubIssue, createGitlabIssue, createLinearIssue, MAX_BODY_BYTES } from './create.js';
import type { LinearGraphql } from './linear-cli.js';

describe('createGithubIssue', () => {
  it('sends the body on stdin, not argv, and returns a runnable ref + url', async () => {
    let seen: string[] = [];
    let stdin: string | undefined;
    const task = await createGithubIssue(
      'o/r',
      { title: 'Add a thing', body: '# Add a thing\n\nbody', labels: ['vanguard'] },
      async (args, input) => {
        seen = args;
        stdin = input;
        return 'https://github.com/o/r/issues/42\n';
      },
    );
    // A doc-sized markdown body on the command line is an ARG_MAX gamble; gh lets us not take it.
    expect(seen).toContain('--body-file');
    expect(seen).toContain('-');
    expect(seen).not.toContain('# Add a thing\n\nbody'); // the body content is NOT an argv value
    expect(stdin).toBe('# Add a thing\n\nbody');
    expect(seen).toEqual(expect.arrayContaining(['--label', 'vanguard']));
    expect(task).toEqual({ id: 'o/r#42', url: 'https://github.com/o/r/issues/42' });
  });

  it('throws when gh prints no URL rather than reporting a success it cannot prove', async () => {
    await expect(
      createGithubIssue('o/r', { title: 't', body: 'b' }, async () => 'Creating issue...\n'),
    ).rejects.toThrow(/did not print an issue URL/);
  });
});

describe('createGitlabIssue', () => {
  it('passes the description as argv (glab has no --body-file) and returns a ref + url', async () => {
    let seen: string[] = [];
    const task = await createGitlabIssue(
      'g/p',
      { title: 'T', body: 'B', labels: ['a', 'b'] },
      async (args) => {
        seen = args;
        return 'https://gitlab.com/g/p/-/issues/7';
      },
    );
    expect(seen).toEqual(expect.arrayContaining(['--description', 'B']));
    expect(seen).toEqual(expect.arrayContaining(['--label', 'a,b']));
    expect(task).toEqual({ id: 'g/p#7', url: 'https://gitlab.com/g/p/-/issues/7' });
  });
});

describe('createLinearIssue', () => {
  const ok: LinearGraphql = async (body) => {
    if (body.query.includes('teams')) return { data: { teams: { nodes: [{ id: 'team-uuid' }] } } };
    return { data: { issueCreate: { success: true, issue: { identifier: 'DEV-9', url: 'https://linear.app/x/issue/DEV-9' } } } };
  };

  it('creates over GraphQL, resolving the team key to an id', async () => {
    const sent: string[] = [];
    const task = await createLinearIssue('DEV', { title: 'T', body: 'B' }, async (body) => {
      sent.push(body.query);
      return ok(body);
    });
    expect(sent[0]).toContain('teams'); // key -> uuid, because IssueCreateInput takes teamId
    expect(sent[1]).toContain('issueCreate');
    expect(task).toEqual({ id: 'DEV-9', url: 'https://linear.app/x/issue/DEV-9' });
  });

  it('refuses an unknown team key instead of creating in the wrong place', async () => {
    const graphql: LinearGraphql = async () => ({ data: { teams: { nodes: [] } } });
    await expect(createLinearIssue('NOPE', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/No Linear team/);
  });

  it('never reports a success it cannot prove', async () => {
    // The one action in the app that cannot be undone from inside it. `success: false`, or a missing
    // issue, must not surface to the user as "created" with no URL to check.
    const graphql: LinearGraphql = async (body) =>
      body.query.includes('teams')
        ? { data: { teams: { nodes: [{ id: 't' }] } } }
        : { data: { issueCreate: { success: false } } };
    await expect(createLinearIssue('DEV', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/did not confirm/i);
  });

  it('surfaces a GraphQL error', async () => {
    const graphql: LinearGraphql = async (body) =>
      body.query.includes('teams')
        ? { data: { teams: { nodes: [{ id: 't' }] } } }
        : { errors: [{ message: 'nope' }] };
    await expect(createLinearIssue('DEV', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/nope/);
  });
});

describe('input guards', () => {
  it('rejects an over-long body BEFORE calling out, so the user sees a real message not E2BIG', async () => {
    const body = 'x'.repeat(MAX_BODY_BYTES + 1);
    let called = false;
    await expect(
      createGitlabIssue('g/p', { title: 't', body }, async () => {
        called = true;
        return '';
      }),
    ).rejects.toThrow(/limit is/);
    expect(called).toBe(false); // never reached the transport
  });

  it('rejects an empty title', async () => {
    await expect(createGithubIssue('o/r', { title: '  ', body: 'b' }, async () => 'x')).rejects.toThrow(/needs a title/);
  });
});
