import { describe, it, expect } from 'vitest';
import { assertSafeBaseBranch } from './base-branch.js';

describe('assertSafeBaseBranch', () => {
  it.each(['-dev', '--upload-pack=false', '+main', 'feature:main', '+refs/heads/x:refs/heads/main'])('rejects %s', (base) => {
    expect(() => assertSafeBaseBranch(base)).toThrow('Invalid base branch');
  });

  it('accepts a normal branch name', () => {
    expect(() => assertSafeBaseBranch('release/1.2')).not.toThrow();
  });
});
