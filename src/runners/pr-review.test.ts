import { describe, it, expect, vi } from 'vitest';
import {
  buildPullRequestReviewComment,
  buildPullRequestReviewIncompleteComment,
  buildPullRequestReviewPrompt,
  fetchPullRequestForReview,
  hasPullRequestReviewMarker,
  parsePullRequestRef,
  PR_REVIEW_INCOMPLETE_NOTICE,
  PR_REVIEW_NO_OUTPUT_NOTICE,
  PullRequestReviewIncompleteError,
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

function makeGh(): { calls: string[][]; gh: GhRunner } {
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
  return { calls, gh };
}

describe('reviewPullRequest', () => {
  it('completed first attempt posts as a normal review', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: 'No blocking findings.\n<promise>COMPLETE</promise>', completed: true });
    const logs: string[] = [];

    const result = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: (l) => logs.push(l) });

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ repoSlug: 'o/r', number: 12 }), { isRetry: false });
    expect(result.commentBody).toContain('No blocking findings.');
    expect(result.commentBody).toContain('<!-- vanguard-pr-review: def456 -->');
    expect(result.commentBody).not.toContain('<promise>');
    expect(result.commentBody).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    const reviewCall = calls.find((a) => a[0] === 'pr' && a[1] === 'review');
    expect(reviewCall).toEqual(['pr', 'review', '12', '--repo', 'o/r', '--comment', '--body', result.commentBody]);
    expect(logs).toContain('review-pr o/r#12: posted -> pr review');
  });

  it('publish:false fetches + reviews but posts NOTHING to the PR, still returning commentBody', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: 'Looks good.', completed: true });
    const logs: string[] = [];

    const result = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, publish: false, log: (l) => logs.push(l) });

    expect(calls.some((a) => a[0] === 'pr' && a[1] === 'view')).toBe(true); // still fetched
    expect(calls.some((a) => a[0] === 'pr' && a[1] === 'review')).toBe(false); // never posted
    expect(result.commentBody).toContain('Looks good.');
    expect(logs).not.toContain('review-pr o/r#12: posted -> pr review');
  });

  it('accepts the legacy string reviewer result as completed', async () => {
    const { gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue('Legacy review text.\n<promise>COMPLETE</promise>');

    const result = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: () => {} });

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result.commentBody).toContain('Legacy review text.');
    expect(result.commentBody).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
  });

  it('incomplete twice with partial output posts the too-large notice (no marker) and throws', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: 'Now let me examine the auth module...', completed: false });
    const logs: string[] = [];

    await expect(
      reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: (l) => logs.push(l) }),
    ).rejects.toBeInstanceOf(PullRequestReviewIncompleteError);

    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer).toHaveBeenNthCalledWith(1, expect.objectContaining({ repoSlug: 'o/r' }), { isRetry: false });
    expect(reviewer).toHaveBeenNthCalledWith(2, expect.objectContaining({ repoSlug: 'o/r' }), { isRetry: true });
    const reviewCall = calls.find((a) => a[0] === 'pr' && a[1] === 'review');
    expect(reviewCall).toBeDefined();
    const body = reviewCall?.at(-1) ?? '';
    expect(body).toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    expect(body).not.toContain('Now let me examine');
    // No head marker: the notice must not block a retry after re-labeling the same head.
    expect(body).not.toContain('vanguard-pr-review');
    expect(logs).toContain('review-pr o/r#12: incomplete -> retry (larger budget)');
    expect(logs).toContain('review-pr o/r#12: posted -> incomplete notice (too-large)');
  });

  it('incomplete with no output at all posts the provider-failure notice and throws', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: '  ', completed: false });

    await expect(reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: () => {} })).rejects.toThrow(
      'did not complete',
    );

    const body = calls.find((a) => a[0] === 'pr' && a[1] === 'review')?.at(-1) ?? '';
    expect(body).toContain(PR_REVIEW_NO_OUTPUT_NOTICE);
    expect(body).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    expect(body).not.toContain('vanguard-pr-review');
  });

  it('publish:false incomplete posts nothing and carries the notice on the error', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: '', completed: false });

    const error = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, publish: false, log: () => {} }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PullRequestReviewIncompleteError);
    expect((error as PullRequestReviewIncompleteError).commentBody).toContain(PR_REVIEW_NO_OUTPUT_NOTICE);
    expect(calls.some((a) => a[0] === 'pr' && a[1] === 'review')).toBe(false);
  });

  it('incomplete then completed (retry succeeds) posts the real verdict', async () => {
    const { calls, gh } = makeGh();
    const reviewer = vi
      .fn()
      .mockResolvedValueOnce({ text: 'frag', completed: false })
      .mockResolvedValueOnce({ text: 'Found a bug in auth.ts\n<promise>COMPLETE</promise>', completed: true });

    const result = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: () => {} });

    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(result.commentBody).toContain('Found a bug in auth.ts');
    expect(result.commentBody).not.toContain('frag');
    expect(result.commentBody).not.toContain('<promise>');
    expect(result.commentBody).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    const reviewCall = calls.find((a) => a[0] === 'pr' && a[1] === 'review');
    expect(reviewCall).toBeDefined();
  });

  it('completed but empty text posts No blocking findings.', async () => {
    const { gh } = makeGh();
    const reviewer = vi.fn().mockResolvedValue({ text: '', completed: true });

    const result = await reviewPullRequest('12', { repoSlug: 'o/r', gh, reviewer, log: () => {} });

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result.commentBody).toContain('No blocking findings.');
    expect(result.commentBody).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
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

  it('adds retry triage instructions when opts.retryTriage is true', () => {
    const prompt = buildPullRequestReviewPrompt(
      {
        repoSlug: 'o/r',
        number: 1,
        title: 'Big PR',
        body: '',
        url: 'https://github.com/o/r/pull/1',
        author: 'bob',
        headRefName: 'big',
        headRefOid: 'aaa',
        baseRefName: 'main',
        diff: 'diff',
      },
      { retryTriage: true },
    );

    expect(prompt).toContain('This is a large diff');
    expect(prompt).toContain('Triage');
  });

  it('does not add retry triage instructions by default', () => {
    const prompt = buildPullRequestReviewPrompt({
      repoSlug: 'o/r',
      number: 1,
      title: 'Small PR',
      body: '',
      url: 'https://github.com/o/r/pull/1',
      author: 'bob',
      headRefName: 'small',
      headRefOid: 'bbb',
      baseRefName: 'main',
      diff: 'diff',
    });

    expect(prompt).not.toContain('This is a large diff');
  });

  it('strips completion markers from the posted comment', () => {
    expect(buildPullRequestReviewComment('Looks good.\n<promise>COMPLETE</promise>')).toBe('## Vanguard Review\n\nLooks good.');
  });

  it('adds a hidden head SHA marker when a head ref oid is supplied', () => {
    expect(buildPullRequestReviewComment('No blocking findings.\n<promise>COMPLETE</promise>', 'abc123')).toBe(
      '## Vanguard Review\n\nNo blocking findings.\n\n<!-- vanguard-pr-review: abc123 -->',
    );
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

describe('buildPullRequestReviewIncompleteComment', () => {
  it('defaults to the too-large notice without any head marker', () => {
    const comment = buildPullRequestReviewIncompleteComment();
    expect(comment).toContain('## Vanguard Review');
    expect(comment).toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    // A marker would make watch-prs treat the failed attempt as a delivered verdict for the head.
    expect(comment).not.toContain('vanguard-pr-review');
  });

  it('names the provider failure for the no-output reason', () => {
    const comment = buildPullRequestReviewIncompleteComment('no-output');
    expect(comment).toContain(PR_REVIEW_NO_OUTPUT_NOTICE);
    expect(comment).not.toContain(PR_REVIEW_INCOMPLETE_NOTICE);
    expect(comment).not.toContain('vanguard-pr-review');
  });
});
