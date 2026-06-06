import { describe, it, expect } from 'vitest';
import { trackSandbox, untrackSandbox, destroyAllTracked } from './cleanup.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

function fakeSandbox(onDestroy: () => void, throws: boolean = false): IsolatedSandboxProvider {
  return {
    destroy: async (): Promise<void> => {
      onDestroy();
      if (throws) throw new Error('destroy failed');
    },
  } as unknown as IsolatedSandboxProvider;
}

describe('cleanup', () => {
  it('destroys every tracked sandbox and reports the count', async () => {
    const destroyed: number[] = [];
    trackSandbox(fakeSandbox(() => destroyed.push(1)));
    trackSandbox(fakeSandbox(() => destroyed.push(2)));
    const count = await destroyAllTracked();
    expect(count).toBe(2);
    expect(destroyed.sort()).toEqual([1, 2]);
  });

  it('does not destroy an untracked sandbox', async () => {
    let destroyed = false;
    const sandbox = fakeSandbox(() => {
      destroyed = true;
    });
    trackSandbox(sandbox);
    untrackSandbox(sandbox);
    await destroyAllTracked();
    expect(destroyed).toBe(false);
  });

  it('swallows a failing destroy and still clears the rest', async () => {
    const destroyed: string[] = [];
    trackSandbox(fakeSandbox(() => destroyed.push('boom'), true));
    trackSandbox(fakeSandbox(() => destroyed.push('ok')));
    await expect(destroyAllTracked()).resolves.toBe(2);
    expect(destroyed.sort()).toEqual(['boom', 'ok']);
    // set is cleared, so a second sweep destroys nothing
    expect(await destroyAllTracked()).toBe(0);
  });
});
