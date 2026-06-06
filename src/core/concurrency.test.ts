import { describe, it, expect, afterEach } from 'vitest';
import { acquireSandboxSlot, releaseSandboxSlot, setSandboxLimit, sandboxLimit } from './concurrency.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const fake = (id: string): IsolatedSandboxProvider => ({ id }) as unknown as IsolatedSandboxProvider;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => setSandboxLimit(64)); // restore a permissive default for other suites

describe('sandbox concurrency', () => {
  it('blocks a third acquire when the limit is 2 until one is released', async () => {
    setSandboxLimit(2);
    const a = fake('a');
    const b = fake('b');
    const c = fake('c');
    await acquireSandboxSlot(a);
    await acquireSandboxSlot(b);

    let cAcquired = false;
    const pending = acquireSandboxSlot(c).then(() => {
      cAcquired = true;
    });
    await tick();
    expect(cAcquired).toBe(false); // at capacity

    releaseSandboxSlot(a);
    await pending;
    expect(cAcquired).toBe(true); // freed slot handed to c

    releaseSandboxSlot(b);
    releaseSandboxSlot(c);
  });

  it('never exceeds the limit even with a burst of acquires', async () => {
    setSandboxLimit(1);
    const order: string[] = [];
    const ids = ['x', 'y', 'z'].map(fake);
    const runs = ids.map((sb, i) =>
      acquireSandboxSlot(sb).then(async () => {
        order.push(`start-${i}`);
        await tick();
        order.push(`end-${i}`);
        releaseSandboxSlot(sb);
      }),
    );
    await Promise.all(runs);
    // limit 1 -> strictly serialized: each ends before the next starts
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('release is idempotent and unknown sandboxes are a no-op', () => {
    setSandboxLimit(1);
    expect(() => releaseSandboxSlot(fake('never'))).not.toThrow();
    expect(sandboxLimit()).toBe(1);
  });
});
