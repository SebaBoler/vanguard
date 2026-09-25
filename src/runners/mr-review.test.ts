import { describe, it, expect, vi } from 'vitest';
import {
  parseMergeRequestRef,
  mergeRequestReviewMarker,
  hasMergeRequestReviewMarker,
  buildMergeRequestReviewComment,
  reviewMergeRequest,
} from './mr-review.js';
import type { GlabRunner } from '../tasks/gitlab.js';

describe('parseMergeRequestRef', () => {
  it('parses GitLab MR URL', () => {
    const target = parseMergeRequestRef('https://gitlab.com/owner/project/-/merge_requests/42');
    expect(target.project).toBe('owner/project');
    expect(target.iid).toBe(42);
  });
  it('parses self-hosted URL', () => {
    const target = parseMergeRequestRef('https://gitlab.internal/group/sub/project/-/merge_requests/7');
    expect(target.project).toBe('group/sub/project');
    expect(target.iid).toBe(7);
  });
  it('parses bare number with project', () => {
    const target = parseMergeRequestRef('5', 'g/p');
    expect(target.project).toBe('g/p');
    expect(target.iid).toBe(5);
  });
  it('throws on bare number without project', () => {
    expect(() => parseMergeRequestRef('5')).toThrow();
  });
});

describe('mergeRequestReviewMarker', () => {
  it('produces hidden HTML comment with sha', () => {
    const marker = mergeRequestReviewMarker('abc123');
    expect(marker).toContain('vanguard-mr-review');
    expect(marker).toContain('abc123');
  });
});

describe('hasMergeRequestReviewMarker', () => {
  it('detects matching marker', () => {
    const body = 'some text\n<!-- vanguard-mr-review: abc123 -->\nmore';
    expect(hasMergeRequestReviewMarker(body, 'abc123')).toBe(true);
  });
  it('returns false for different sha', () => {
    const body = '<!-- vanguard-mr-review: abc123 -->';
    expect(hasMergeRequestReviewMarker(body, 'def456')).toBe(false);
  });
});

describe('buildMergeRequestReviewComment', () => {
  it('wraps text in Vanguard Review header', () => {
    const comment = buildMergeRequestReviewComment('No blocking findings.');
    expect(comment).toContain('## Vanguard Review');
    expect(comment).toContain('No blocking findings.');
  });
  it('appends marker when sha provided', () => {
    const comment = buildMergeRequestReviewComment('ok', 'deadbeef');
    expect(comment).toContain('vanguard-mr-review');
    expect(comment).toContain('deadbeef');
  });
});

describe('reviewMergeRequest head dedupe', () => {
  const HEAD = 'abc123def4567890';

  function makeGlab(notes: string | Error, sha = HEAD): { glab: GlabRunner; calls: string[][] } {
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, title: 'T', sha });
      if (args[0] === 'mr' && args[1] === 'diff') return 'diff --git a/x b/x';
      if (args[0] === 'api') {
        if (notes instanceof Error) throw notes;
        return notes;
      }
      return '';
    };
    return { glab, calls };
  }

  const posted = (calls: string[][]): string[][] => calls.filter((c) => c[0] === 'mr' && c[1] === 'note');

  it('skips a head it already reviewed: no reviewer run, nothing posted', async () => {
    const notes = JSON.stringify([{ system: false, body: `## Vanguard Review\n\nok\n\n${mergeRequestReviewMarker(HEAD)}` }]);
    const { glab, calls } = makeGlab(notes);
    const reviewer = vi.fn(async () => 'No blocking findings.');
    const lines: string[] = [];

    const result = await reviewMergeRequest('5', { project: 'g/p', glab, reviewer, log: (l) => lines.push(l) });

    expect(reviewer).not.toHaveBeenCalled();
    expect(posted(calls)).toEqual([]);
    expect(result.commentBody).toBeUndefined();
    expect(lines).toContain(`review-mr g/p!5: head ${HEAD} already reviewed -> skip`);
    expect(calls).toContainEqual(['api', 'projects/g%2Fp/merge_requests/5/notes?per_page=100&sort=desc&order_by=created_at']);
  });

  it('reviews and posts when only an older head was reviewed', async () => {
    const notes = JSON.stringify([{ system: false, body: mergeRequestReviewMarker('0000000') }]);
    const { glab, calls } = makeGlab(notes);
    const reviewer = vi.fn(async () => 'No blocking findings.');

    const result = await reviewMergeRequest('5', { project: 'g/p', glab, reviewer });

    expect(reviewer).toHaveBeenCalledOnce();
    expect(posted(calls)).toHaveLength(1);
    expect(result.commentBody).toContain(mergeRequestReviewMarker(HEAD));
  });

  it('fails and posts nothing when the MR notes cannot be read', async () => {
    const { glab, calls } = makeGlab(new Error('glab: 403 Forbidden'));
    const reviewer = vi.fn(async () => 'No blocking findings.');

    await expect(reviewMergeRequest('5', { project: 'g/p', glab, reviewer })).rejects.toThrow(
      /cannot read the MR notes .* nothing posted \(glab: 403 Forbidden\)/,
    );
    expect(reviewer).not.toHaveBeenCalled();
    expect(posted(calls)).toEqual([]);
  });

  it('fails and posts nothing when glab returns no head SHA', async () => {
    const { glab, calls } = makeGlab('[]', '');
    const reviewer = vi.fn(async () => 'No blocking findings.');

    await expect(reviewMergeRequest('5', { project: 'g/p', glab, reviewer })).rejects.toThrow(/no head SHA/);
    expect(reviewer).not.toHaveBeenCalled();
    expect(posted(calls)).toEqual([]);
  });
});
