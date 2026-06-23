import { describe, it, expect, vi } from 'vitest';
import {
  buildMainLoopReviewComment,
  buildPullRequestReviewComment,
  buildPullRequestReviewPrompt,
  fetchPullRequestForReview,
  hasPullRequestReviewMarker,
  parsePullRequestRef,
  postPullRequestReview,
  reviewPullRequest,
} from './pr-review.js';
import type { GhRunner } from '../tasks/github.js';

describe('parsePullRequestRef', () => {
  it('parses GitHub PR URLs', () => {
    expect(parsePullRequestRef('https://github.com/o/r/pull/12')).toEqual({ repoSlug: 'o/r', number: 12 });
  });

  it('parses a bare number when repo slug is supplied', () => {
    expect(parsePullRequestRef('12', 'o/r')).toEqual({ repoSlug: 'o/r', number: 12 });
  });

  it('requires a repo slug for bare numbers', () => {
    expect(() => parsePullRequestRef('12')).toThrow('needs --github-repo');
  });
});

describe('fetchPullRequestForReview', () => {
  it('loads PR metadata and diff through gh', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 12,
          title: 'Fix auth',
          body: 'Adds guard.',
          url: 'https://github.com/o/r/pull/12',
          author: { login: 'alice' },
          headRefName: 'fix-auth',
          headRefOid: 'abc123',
          baseRefName: 'main',
        });
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/auth.ts b/auth.ts';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const pr = await fetchPullRequestForReview({ repoSlug: 'o/r', number: 12 }, gh);

    expect(pr).toEqual({
      repoSlug: 'o/r',
      number: 12,
      title: 'Fix auth',
      body: 'Adds guard.',
      url: 'https://github.com/o/r/pull/12',
      author: 'alice',
      headRefName: 'fix-auth',
      headRefOid: 'abc123',
      baseRefName: 'main',
      diff: 'diff --git a/auth.ts b/auth.ts',
    });
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '12',
      '--repo',
      'o/r',
      '--json',
      'number,title,body,url,author,headRefName,headRefOid,baseRefName',
    ]);
    expect(calls[1]).toEqual(['pr', 'diff', '12', '--repo', 'o/r']);
  });
});

describe('reviewPullRequest', () => {
  it('posts an injected reviewer result as a non-blocking PR review', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 12,
          title: 'Fix auth',
          body: '',
          url: 'https://github.com/o/r/pull/12',
          author: { login: 'alice' },
          headRefName: 'h',
          headRefOid: 'def456',
          baseRefName: 'main',
        });
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff';
      if (args[0] === 'pr' && args[1] === 'review') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const reviewer = vi.fn().mockResolvedValue('No blocking findings.\n<promise>COMPLETE</promise>');

    const result = await reviewPullRequest('12', {
      repoSlug: 'o/r',
      gh,
      reviewer,
      log: () => {},
    });

    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ repoSlug: 'o/r', number: 12, diff: 'diff' }));
    expect(result.commentBody).toContain('No blocking findings.');
    expect(result.commentBody).toContain('<!-- vanguard-pr-review: def456 -->');
    expect(result.commentBody).not.toContain('<promise>');
    const reviewCall = calls.find((args) => args[0] === 'pr' && args[1] === 'review');
    expect(reviewCall).toEqual(['pr', 'review', '12', '--repo', 'o/r', '--comment', '--body', result.commentBody]);
  });
});

describe('review prompt and comment formatting', () => {
  it('builds an adversarial review prompt with PR metadata and diff', () => {
    const prompt = buildPullRequestReviewPrompt({
      repoSlug: 'o/r',
      number: 12,
      title: 'Fix auth',
      body: 'Adds guard.',
      url: 'https://github.com/o/r/pull/12',
      author: 'alice',
      headRefName: 'fix-auth',
      headRefOid: 'abc123',
      baseRefName: 'main',
      diff: 'diff --git a/auth.ts b/auth.ts',
    });

    expect(prompt).toContain('PR: o/r#12');
    expect(prompt).toContain('Fix auth');
    expect(prompt).toContain('diff --git a/auth.ts b/auth.ts');
    expect(prompt).toContain('<promise>COMPLETE</promise>');
  });

  it('strips completion markers from the posted comment', () => {
    expect(buildPullRequestReviewComment('Looks good.\n<promise>COMPLETE</promise>')).toBe('## Vanguard Review\n\nLooks good.');
  });

  it('adds a hidden head SHA marker when a head ref oid is supplied', () => {
    expect(buildPullRequestReviewComment('No blocking findings.\n<promise>COMPLETE</promise>', 'abc123')).toBe(
      '## Vanguard Review\n\nNo blocking findings.\n\n<!-- vanguard-pr-review: abc123 -->',
    );
  });

  it('builds a main-loop review comment with attribution and a short SHA', () => {
    expect(
      buildMainLoopReviewComment('No blocking issues.\n<promise>COMPLETE</promise>', {
        headRefOid: 'abcdef123456',
        attribution: 'codex/gpt-5',
      }),
    ).toBe(
      [
        '## Vanguard Review',
        '',
        'Reviewed by codex/gpt-5 @ abcdef1: no blocking issues',
        '',
        '<!-- vanguard-pr-review: abcdef123456 -->',
      ].join('\n'),
    );
  });

  it('posts request-changes reviews through gh when requested', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return '';
    };

    await postPullRequestReview({ repoSlug: 'o/r', number: 12 }, 'body', 'request-changes', gh);

    expect(calls).toEqual([['pr', 'review', '12', '--repo', 'o/r', '--request-changes', '--body', 'body']]);
  });

  it('finds a matching hidden head SHA marker after older markers in the same body', () => {
    const body = [
      '## Vanguard Review',
      '',
      '<!-- vanguard-pr-review: deadbeef -->',
      '',
      'Later copied review text.',
      '',
      '<!-- vanguard-pr-review: abc123 -->',
    ].join('\n');

    expect(hasPullRequestReviewMarker(body, 'abc123')).toBe(true);
  });

  it('does not match a different hidden head SHA marker', () => {
    const body = [
      '## Vanguard Review',
      '',
      '<!-- vanguard-pr-review: deadbeef -->',
      '',
      '<!-- vanguard-pr-review: abc123 -->',
    ].join('\n');

    expect(hasPullRequestReviewMarker(body, 'feed456')).toBe(false);
  });

  it('rejects a multiline hidden review marker comment', () => {
    const body = ['<!--', ' vanguard-pr-review: abc123', '-->'].join('\n');

    expect(hasPullRequestReviewMarker(body, 'abc123')).toBe(false);
  });

  it('still finds a single-line marker after an older marker with the strict regex', () => {
    const body = [
      '<!-- vanguard-pr-review: deadbeef -->',
      'Copied review text.',
      '<!-- vanguard-pr-review: abc123 -->',
    ].join('\n');

    expect(hasPullRequestReviewMarker(body, 'abc123')).toBe(true);
  });
});
