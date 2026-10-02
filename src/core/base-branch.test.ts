import { describe, it, expect } from 'vitest';
import { assertSafeBaseBranch } from './base-branch.js';

describe('assertSafeBaseBranch', () => {
  it.each(['', '   ', '-dev', '--upload-pack=false', '+main', 'feature:main', '+refs/heads/x:refs/heads/main'])('rejects %s', (base) => {
    expect(() => assertSafeBaseBranch(base)).toThrow('Invalid base branch');
  });

  it.each([
    ['newline', 'main\nfake'],
    ['ANSI escape', 'main\u001b[31m'],
    ['NUL', 'ma\u0000in'],
    ['DEL', 'main\u007f'],
  ])('rejects a control character (%s)', (_label, base) => {
    expect(() => assertSafeBaseBranch(base)).toThrow('Invalid base branch');
  });

  it('escapes control characters in the message, so a value cannot forge log or terminal lines', () => {
    expect(() => assertSafeBaseBranch('-x\n\u001b[31mfake')).toThrow('Invalid base branch "-x\\n\\u001b[31mfake"');
  });

  it('accepts a normal branch name', () => {
    expect(() => assertSafeBaseBranch('release/1.2')).not.toThrow();
  });
});
