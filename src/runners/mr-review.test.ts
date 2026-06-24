import { describe, it, expect } from 'vitest';
import {
  parseMergeRequestRef,
  mergeRequestReviewMarker,
  hasMergeRequestReviewMarker,
  buildMergeRequestReviewComment,
} from './mr-review.js';

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
