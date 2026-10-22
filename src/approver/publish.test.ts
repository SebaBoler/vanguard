import { describe, it, expect } from 'vitest';
import { assertShadowSafeGhArgs } from './publish.js';

describe('assertShadowSafeGhArgs', () => {
  it.each([
    ['pr', ['pr', 'merge', '1']],
    ['pr review --approve', ['pr', 'review', '1', '--approve']],
    ['pr review --request-changes', ['pr', 'review', '1', '--request-changes']],
    ['pr edit --add-label', ['pr', 'edit', '1', '--add-label', 'x']],
    ['pr ready', ['pr', 'ready', '1']],
    ['label create', ['label', 'create', 'x']],
    ['issue edit', ['issue', 'edit', '1', '--add-label', 'x']],
    ['api -X PUT merge', ['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge']],
    ['api labels path', ['api', 'repos/o/r/issues/1/labels']],
  ])('throws for %s', (_label, args) => {
    expect(() => assertShadowSafeGhArgs(args)).toThrow();
  });

  it.each([
    ['pr view --json', ['pr', 'view', '1', '--json', 'number']],
    ['api check-runs', ['api', 'repos/o/r/commits/sha/check-runs']],
    ['pr comment --body', ['pr', 'comment', '1', '--body', 'x']],
  ])('permits %s', (_label, args) => {
    expect(() => assertShadowSafeGhArgs(args)).not.toThrow();
  });
});
