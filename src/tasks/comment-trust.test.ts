import { describe, expect, it } from 'vitest';
import { classifyAuthor, trustedComments, trustedSpecText, describeIgnoredAuthor } from './comment-trust.js';
import type { Task } from './fetcher.js';

describe('comment trust', () => {
  it('T1: fails closed and honours explicit author trust', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', ' owner ']) expect(classifyAuthor('alice', association)).toBe('association');
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) expect(classifyAuthor('mallory', association)).toBe('untrusted');
    // An absent association is "the provider models none" (GitLab), not "outsider".
    expect(classifyAuthor('mallory', undefined)).toBe('no-association');
    expect(classifyAuthor('Alice', 'NONE', { allowedAuthors: ['ALICE'] })).toBe('allowed');
    expect(classifyAuthor('Alice', undefined, { issueAuthor: 'ALICE' })).toBe('issue-author');
    for (const author of ['vanguard', 'foo[bot]', 'github-actions', 'custom']) {
      expect(classifyAuthor(author, 'OWNER', { botLogins: ['CUSTOM'] })).toBe('bot');
    }
    expect(classifyAuthor('mallory-vanguard', 'NONE')).toBe('untrusted');
  });
  it('T2: derives issue author, preserves order and excludes outsider text', () => {
    const task: Task = { id: '1', title: '', description: '', labels: [], children: [], author: 'Alice', comments: [
      { author: 'alice', authorAssociation: 'NONE', body: 'first' }, { author: 'mallory', authorAssociation: 'NONE', body: 'attack' },
      { author: 'maintainer', authorAssociation: 'OWNER', body: 'last' },
    ] };
    expect(trustedComments(task)).toEqual([task.comments[0], task.comments[2]]);
    expect(trustedSpecText(task)).toBe('first\nlast');
  });
  it('T3: describes known and absent associations', () => {
    expect(describeIgnoredAuthor('mallory', 'NONE')).toBe('@mallory (NONE)');
    expect(describeIgnoredAuthor('mallory', '')).toBe('@mallory (none)');
  });
});
