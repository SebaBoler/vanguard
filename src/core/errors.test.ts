import { describe, it, expect } from 'vitest';
import { formatFailureComment, visibleError, VanguardError } from './errors.js';

describe('formatFailureComment', () => {
  it('carries the throwing site, so a bare TypeError is diagnosable from the comment alone', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'split')");

    const comment = formatFailureComment('Vanguard run failed', error);

    expect(comment).toContain("Vanguard run failed: TypeError: Cannot read properties of undefined (reading 'split')");
    expect(comment).toContain('<details><summary>stack</summary>');
    expect(comment).toContain('errors.test.ts');
  });

  it('trims the stack to 25 lines so a deep async trace cannot flood the comment', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 200 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`)].join(
      '\n',
    );

    const fenced = formatFailureComment('Vanguard run failed', error).split('```')[1] ?? '';

    expect(fenced.trim().split('\n')).toHaveLength(25);
    expect(fenced).toContain('at frame23');
    expect(fenced).not.toContain('at frame24');
  });

  it('falls back to the one-line shape for a non-Error throw', () => {
    expect(formatFailureComment('Vanguard spec failed', 'plain string')).toBe('Vanguard spec failed: plain string');
  });

  it('falls back to the one-line shape when an Error carries no stack', () => {
    const error = new Error('no stack here');
    error.stack = '';

    expect(formatFailureComment('Vanguard run failed', error)).toBe('Vanguard run failed: Error: no stack here');
  });
});

describe('visibleError', () => {
  it('passes a VanguardError through untouched', () => {
    const error = new VanguardError('already visible');

    expect(visibleError(error)).toBe(error);
  });

  it('wraps a foreign error with the first non-empty message line', () => {
    expect(visibleError(new Error('\n\ngh: not found\nusage: gh issue view')).message).toBe('gh: not found');
  });
});
