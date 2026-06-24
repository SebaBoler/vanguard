import { describe, it, expect, vi } from 'vitest';
import {
  fetchPullRequestFeedback,
  selectActionableFeedback,
  buildRevisionPrompt,
  countRevisionRounds,
  referenceSnippet,
  buildItemReply,
  buildRevisionSummary,
  summaryContradictsDiff,
} from './pr-feedback.js';
import type { PullRequestFeedback, FeedbackItem, RevisionSummaryInput } from './pr-feedback.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFeedback(overrides: Partial<PullRequestFeedback> = {}): PullRequestFeedback {
  return {
    headRefOid: 'abc123',
    headCommittedDate: '2024-01-10T12:00:00Z',
    isDraft: true,
    items: [],
    threads: [],
    ...overrides,
  };
}

function threadItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    source: 'thread',
    threadId: 'thread-1',
    isResolved: false,
    author: 'alice',
    body: 'Please rename this variable.',
    createdAt: '2024-01-11T10:00:00Z',
    ...overrides,
  };
}

function reviewItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    source: 'review',
    author: 'alice',
    body: 'Overall LGTM but please address the naming.',
    createdAt: '2024-01-11T10:00:00Z',
    ...overrides,
  };
}

function commentItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    source: 'comment',
    author: 'alice',
    body: 'Can you add a test for the edge case?',
    createdAt: '2024-01-11T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fetchPullRequestFeedback
// ---------------------------------------------------------------------------

describe('fetchPullRequestFeedback', () => {
  it('parses a full GraphQL response into PullRequestFeedback', async () => {
    const payload = {
      data: {
        repository: {
          pullRequest: {
            isDraft: true,
            headRefOid: 'sha-abc',
            commits: { nodes: [{ commit: { committedDate: '2024-01-10T09:00:00Z' } }] },
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-42',
                  isResolved: false,
                  comments: {
                    nodes: [
                      { author: { login: 'alice' }, body: 'Fix this', createdAt: '2024-01-11T08:00:00Z' },
                    ],
                  },
                },
              ],
            },
            reviews: {
              nodes: [
                { author: { login: 'bob' }, body: 'Looks good overall', state: 'COMMENTED', submittedAt: '2024-01-11T09:00:00Z' },
              ],
            },
            comments: {
              nodes: [
                { author: { login: 'carol' }, body: 'Please add docs', createdAt: '2024-01-11T10:00:00Z' },
              ],
            },
          },
        },
      },
    };

    const gh = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const fb = await fetchPullRequestFeedback({ repoSlug: 'o/r', number: 7 }, gh);

    expect(fb.headRefOid).toBe('sha-abc');
    expect(fb.headCommittedDate).toBe('2024-01-10T09:00:00Z');
    expect(fb.isDraft).toBe(true);

    // Thread items
    expect(fb.threads).toHaveLength(1);
    expect(fb.threads[0]?.id).toBe('thread-42');
    expect(fb.threads[0]?.isResolved).toBe(false);
    expect(fb.threads[0]?.items).toHaveLength(1);

    const threadItem = fb.items.find((i) => i.source === 'thread');
    expect(threadItem?.threadId).toBe('thread-42');
    expect(threadItem?.author).toBe('alice');
    expect(threadItem?.body).toBe('Fix this');

    const reviewIt = fb.items.find((i) => i.source === 'review');
    expect(reviewIt?.author).toBe('bob');
    expect(reviewIt?.createdAt).toBe('2024-01-11T09:00:00Z');

    const commentIt = fb.items.find((i) => i.source === 'comment');
    expect(commentIt?.author).toBe('carol');

    // Verify gh was called with the right args
    const args = gh.mock.calls[0]?.[0] as string[];
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    expect(args).toContain('owner=o');
    expect(args).toContain('name=r');
  });

  it('emits a log line when reviewThreads is at the 100-node cap', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      isResolved: false,
      comments: { nodes: [] },
    }));
    const payload = {
      data: {
        repository: {
          pullRequest: {
            isDraft: false,
            headRefOid: 'abc',
            commits: { nodes: [] },
            reviewThreads: { nodes },
            reviews: { nodes: [] },
            comments: { nodes: [] },
          },
        },
      },
    };
    const gh = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const logs: string[] = [];
    await fetchPullRequestFeedback({ repoSlug: 'o/r', number: 1 }, gh, (l) => logs.push(l));
    expect(logs.some((l) => l.includes('truncated'))).toBe(true);
  });

  it('returns empty feedback for an empty PR', async () => {
    const payload = {
      data: {
        repository: {
          pullRequest: {
            isDraft: false,
            headRefOid: '',
            commits: { nodes: [] },
            reviewThreads: { nodes: [] },
            reviews: { nodes: [] },
            comments: { nodes: [] },
          },
        },
      },
    };
    const gh = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const fb = await fetchPullRequestFeedback({ repoSlug: 'o/r', number: 1 }, gh);
    expect(fb.items).toHaveLength(0);
    expect(fb.threads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectActionableFeedback
// ---------------------------------------------------------------------------

describe('selectActionableFeedback', () => {
  const headRefOid = 'abc123';
  const opts = { headRefOid, headCommittedDate: '2024-01-10T12:00:00Z' };

  it('keeps a normal human comment', () => {
    const fb = makeFeedback({ items: [commentItem()] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(1);
  });

  it('drops a comment authored by vanguard (non-recursion)', () => {
    const fb = makeFeedback({ items: [commentItem({ author: 'vanguard' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('drops a comment authored by a [bot] login (non-recursion)', () => {
    const fb = makeFeedback({ items: [commentItem({ author: 'dependabot[bot]' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('drops a comment authored by github-actions (non-recursion)', () => {
    const fb = makeFeedback({ items: [commentItem({ author: 'github-actions' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('drops a comment authored by an extra bot login', () => {
    const fb = makeFeedback({ items: [commentItem({ author: 'my-bot' })] });
    expect(selectActionableFeedback(fb, { ...opts, botLogins: ['my-bot'] })).toHaveLength(0);
  });

  it('drops a body containing the current head vanguard-pr-review marker', () => {
    const body = `Nice review.\n\n<!-- vanguard-pr-review: ${headRefOid} -->`;
    const fb = makeFeedback({ items: [commentItem({ body })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('drops revision acknowledgement comments even when authored by a human token', () => {
    const body = `Addressed in commit abc1234.\n\n<!-- vanguard-revision: deadbeef -->`;
    const fb = makeFeedback({ items: [commentItem({ author: 'octocat', body })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('keeps a body with a marker for a DIFFERENT sha (stale marker)', () => {
    const body = '<!-- vanguard-pr-review: deadbeef -->';
    const fb = makeFeedback({ items: [commentItem({ body })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(1);
  });

  it('drops an item in a resolved thread', () => {
    const fb = makeFeedback({ items: [threadItem({ isResolved: true })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('keeps an item in an unresolved thread', () => {
    const fb = makeFeedback({ items: [threadItem({ isResolved: false })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(1);
  });

  it('drops a comment older than the watermark', () => {
    const fb = makeFeedback({ items: [commentItem({ createdAt: '2024-01-10T11:00:00Z' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('drops a comment equal to the watermark', () => {
    const fb = makeFeedback({ items: [commentItem({ createdAt: '2024-01-10T12:00:00Z' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(0);
  });

  it('keeps a comment strictly newer than the watermark', () => {
    const fb = makeFeedback({ items: [commentItem({ createdAt: '2024-01-10T12:00:01Z' })] });
    expect(selectActionableFeedback(fb, opts)).toHaveLength(1);
  });

  it('skips watermark filter when headCommittedDate is empty', () => {
    const fb = makeFeedback({
      headCommittedDate: '',
      items: [commentItem({ createdAt: '2020-01-01T00:00:00Z' })],
    });
    // Pass '' explicitly to opts to override headCommittedDate
    expect(selectActionableFeedback(fb, { headRefOid, headCommittedDate: '' })).toHaveLength(1);
  });

  it('handles mixed bag: returns only the expected survivors', () => {
    const items: FeedbackItem[] = [
      threadItem({ author: 'alice', isResolved: false }),                   // keep
      threadItem({ author: 'vanguard', isResolved: false }),                 // drop (bot)
      threadItem({ isResolved: true, author: 'alice' }),                    // drop (resolved)
      reviewItem({ author: 'bob', createdAt: '2024-01-11T00:00:00Z' }),    // keep
      commentItem({ author: 'carol', createdAt: '2024-01-09T00:00:00Z' }), // drop (old)
    ];
    const fb = makeFeedback({ items });
    const result = selectActionableFeedback(fb, opts);
    expect(result).toHaveLength(2);
    expect(result[0]?.author).toBe('alice');
    expect(result[1]?.author).toBe('bob');
  });

  it('surfaces review summaries even when reviewThreads is empty (--comment review case)', () => {
    const fb = makeFeedback({
      threads: [],
      items: [
        reviewItem({ author: 'alice', body: 'Please fix the imports.' }),
        commentItem({ author: 'alice', body: 'And add a test.' }),
      ],
    });
    const result = selectActionableFeedback(fb, opts);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.source)).toEqual(['review', 'comment']);
  });
});

// ---------------------------------------------------------------------------
// countRevisionRounds
// ---------------------------------------------------------------------------

describe('countRevisionRounds', () => {
  it('counts repeated markers for the same head as one revision round', async () => {
    const gh = vi.fn().mockResolvedValue(
      JSON.stringify({
        comments: [
          { body: 'Re: first\n\n<!-- vanguard-revision: deadbeef -->' },
          { body: 'Re: second\n\n<!-- vanguard-revision: deadbeef -->' },
          { body: '## Revision Summary\n\n<!-- vanguard-revision: deadbeef -->' },
        ],
        reviews: [],
      }),
    );

    await expect(countRevisionRounds({ repoSlug: 'o/r', number: 7 }, gh)).resolves.toBe(1);
  });

  it('counts distinct revision marker heads as distinct rounds', async () => {
    const gh = vi.fn().mockResolvedValue(
      JSON.stringify({
        comments: [
          { body: '<!-- vanguard-revision: deadbeef -->' },
          { body: '<!-- vanguard-revision: abc1234 -->' },
        ],
        reviews: [],
      }),
    );

    await expect(countRevisionRounds({ repoSlug: 'o/r', number: 7 }, gh)).resolves.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildRevisionPrompt
// ---------------------------------------------------------------------------

describe('buildRevisionPrompt', () => {
  const pr = {
    repoSlug: 'o/r',
    number: 42,
    headRefOid: 'sha-xyz',
    title: 'Add auth guard',
    diff: 'diff --git a/src/auth.ts b/src/auth.ts',
  };

  it('embeds PR identity, head SHA, title, and diff', () => {
    const prompt = buildRevisionPrompt(pr, []);
    expect(prompt).toContain('o/r#42');
    expect(prompt).toContain('sha-xyz');
    expect(prompt).toContain('Add auth guard');
    expect(prompt).toContain('diff --git a/src/auth.ts');
  });

  it('ends with the completion signal instruction', () => {
    const prompt = buildRevisionPrompt(pr, []);
    expect(prompt).toContain('<promise>COMPLETE</promise>');
  });

  it('renders an empty actionable list safely', () => {
    const prompt = buildRevisionPrompt(pr, []);
    expect(prompt).toContain('(no actionable feedback)');
  });

  it('numbers and labels each feedback item by source', () => {
    const items: FeedbackItem[] = [
      threadItem({ source: 'thread', author: 'alice', body: 'Rename the variable.', threadId: 't1', isResolved: false, createdAt: '' }),
      reviewItem({ source: 'review', author: 'bob', body: 'LGTM overall.' }),
      commentItem({ source: 'comment', author: 'carol', body: 'Add a test.' }),
    ];
    const prompt = buildRevisionPrompt(pr, items);
    expect(prompt).toContain('1. [inline thread] @alice:');
    expect(prompt).toContain('Rename the variable.');
    expect(prompt).toContain('2. [review summary] @bob:');
    expect(prompt).toContain('LGTM overall.');
    expect(prompt).toContain('3. [PR comment] @carol:');
    expect(prompt).toContain('Add a test.');
  });

  it('does not include bot/marker-filtered items (caller must filter before building)', () => {
    // The prompt builder trusts the caller to pass only actionable items.
    const items: FeedbackItem[] = [
      commentItem({ author: 'alice', body: 'Real feedback.' }),
    ];
    const prompt = buildRevisionPrompt(pr, items);
    expect(prompt).not.toContain('vanguard');
    expect(prompt).not.toContain('<!-- vanguard-pr-review');
  });
});

// ---------------------------------------------------------------------------
// referenceSnippet
// ---------------------------------------------------------------------------

describe('referenceSnippet', () => {
  it('labels a review item with "review"', () => {
    const snippet = referenceSnippet(reviewItem());
    expect(snippet).toContain('Re: your review by @alice');
    expect(snippet).toContain('"Overall LGTM but please address the naming."');
  });

  it('labels a comment item with "comment"', () => {
    const snippet = referenceSnippet(commentItem());
    expect(snippet).toContain('Re: your comment by @alice');
    expect(snippet).toContain('"Can you add a test for the edge case?"');
  });

  it('labels a thread item with "inline thread"', () => {
    const snippet = referenceSnippet(threadItem());
    expect(snippet).toContain('Re: your inline thread by @alice');
  });

  it('truncates long bodies at 120 chars with ellipsis', () => {
    const long = 'A'.repeat(130);
    const snippet = referenceSnippet(commentItem({ body: long }));
    expect(snippet).toContain('…');
    expect(snippet.indexOf('"')).not.toBe(-1);
    // Preview part should be at most 120 chars
    const quoted = snippet.slice(snippet.indexOf('"') + 1);
    expect(quoted.startsWith('A'.repeat(120))).toBe(true);
  });

  it('collapses newlines in the preview', () => {
    const snippet = referenceSnippet(reviewItem({ body: 'Line one\nLine two' }));
    expect(snippet).not.toContain('\n');
    expect(snippet).toContain('Line one Line two');
  });
});

// ---------------------------------------------------------------------------
// buildItemReply
// ---------------------------------------------------------------------------

describe('buildItemReply', () => {
  const sha = 'abc1234';
  const headRefOid = 'deadbeef';

  it('contains the referenceSnippet, SHA, and revision marker for a review item', () => {
    const body = buildItemReply(reviewItem(), '', sha, headRefOid);
    expect(body).toContain('Re: your review by @alice');
    expect(body).toContain('Addressed in commit abc1234.');
    expect(body).toContain('<!-- vanguard-revision: deadbeef -->');
  });

  it('contains the referenceSnippet, SHA, and revision marker for a comment item', () => {
    const body = buildItemReply(commentItem(), '', sha, headRefOid);
    expect(body).toContain('Re: your comment by @alice');
    expect(body).toContain('Addressed in commit abc1234.');
    expect(body).toContain('<!-- vanguard-revision: deadbeef -->');
  });

  it('appends a colon-delimited point when non-empty', () => {
    const body = buildItemReply(reviewItem(), 'Updated the variable name', sha, headRefOid);
    expect(body).toContain('Addressed in commit abc1234: Updated the variable name');
  });

  it('uses a period when point is empty', () => {
    const body = buildItemReply(commentItem(), '', sha, headRefOid);
    expect(body).toContain('Addressed in commit abc1234.');
    expect(body).not.toContain('Addressed in commit abc1234:');
  });
});

// ---------------------------------------------------------------------------
// buildRevisionSummary
// ---------------------------------------------------------------------------

describe('buildRevisionSummary', () => {
  const base: RevisionSummaryInput = {
    repoSlug: 'o/r',
    number: 42,
    headRefOid: 'deadbeef',
    commitSha: 'abc1234',
    addressed: [
      { item: reviewItem({ author: 'alice' }), point: '' },
      { item: commentItem({ author: 'bob', body: 'Add a test.' }), point: 'Added test for edge case.' },
    ],
    deferred: [],
    verification: { typecheck: 'pass', test: 'pass' },
  };

  it('includes repo/number heading and commit SHA', () => {
    const text = buildRevisionSummary(base);
    expect(text).toContain('o/r#42');
    expect(text).toContain('abc1234');
  });

  it('lists each addressed item by referenceSnippet', () => {
    const text = buildRevisionSummary(base);
    expect(text).toContain('@alice');
    expect(text).toContain('@bob');
  });

  it('renders empty-state "(none)" in deferred section when no deferred items', () => {
    const text = buildRevisionSummary(base);
    expect(text).toContain('Deferred / not addressed');
    expect(text).toContain('(none)');
  });

  it('lists deferred items when present', () => {
    const input: RevisionSummaryInput = {
      ...base,
      deferred: [{ item: commentItem({ author: 'carol', body: 'Fix the thing.' }), reason: 'Out of scope for this round' }],
    };
    const text = buildRevisionSummary(input);
    expect(text).toContain('@carol');
    expect(text).toContain('Out of scope for this round');
  });

  it('ends with the revision marker', () => {
    const text = buildRevisionSummary(base);
    expect(text.trimEnd()).toMatch(/<!--\s*vanguard-revision: deadbeef\s*-->$/);
  });

  it('renders verification status for pass', () => {
    const text = buildRevisionSummary(base);
    expect(text).toContain('Typecheck: pass');
    expect(text).toContain('Tests: pass');
  });

  it('renders verification status for fail', () => {
    const text = buildRevisionSummary({ ...base, verification: { typecheck: 'fail', test: 'fail' } });
    expect(text).toContain('Typecheck: fail');
    expect(text).toContain('Tests: fail');
  });

  it('renders verification status for unknown', () => {
    const text = buildRevisionSummary({ ...base, verification: { typecheck: 'unknown', test: 'unknown' } });
    expect(text).toContain('Typecheck: unknown');
    expect(text).toContain('Tests: unknown');
  });
});

// ---------------------------------------------------------------------------
// summaryContradictsDiff — accuracy guard (#177 regression)
// ---------------------------------------------------------------------------

describe('summaryContradictsDiff', () => {
  const removeDiff = [
    '--- a/src/runner.ts',
    '+++ b/src/runner.ts',
    '@@ -1,4 +1,3 @@',
    ' function runCommand() {',
    '-  validateProviderChoice(provider, allowedProviders);',
    ' }',
  ].join('\n');

  it('flags "Restored … `validateProviderChoice`" when the diff only removes it (#177)', () => {
    const text = 'Restored defensive runtime validation in `runCommand` (`validateProviderChoice`)';
    const result = summaryContradictsDiff(text, removeDiff);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain('validateProviderChoice');
  });

  it('does not flag "Removed `validateProviderChoice`" when the diff only removes it (consistent)', () => {
    const text = 'Removed `validateProviderChoice` to simplify the flow.';
    const result = summaryContradictsDiff(text, removeDiff);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('does not flag "Added `newHelper`" when the diff adds it (consistent)', () => {
    const addDiff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' function foo() {',
      '+  newHelper();',
      ' }',
    ].join('\n');
    const text = 'Added `newHelper` to handle the edge case.';
    const result = summaryContradictsDiff(text, addDiff);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('does not flag when a symbol appears on both + and - lines (modified, not removed)', () => {
    const modifyDiff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' function foo() {',
      '-  helperFn(oldArg);',
      '+  helperFn(newArg);',
      ' }',
    ].join('\n');
    const text = 'Restored `helperFn` with updated arguments.';
    const result = summaryContradictsDiff(text, modifyDiff);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for text with no backtick symbols', () => {
    const result = summaryContradictsDiff('Addressed the review feedback in this commit.', removeDiff);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns ok:true for an empty diff', () => {
    const text = 'Restored `validateProviderChoice` here.';
    const result = summaryContradictsDiff(text, '');
    expect(result.ok).toBe(true);
  });
});
