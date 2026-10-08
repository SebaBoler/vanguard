import { describe, expect, it, vi } from 'vitest';
import { createNavGuardRegistry } from './navGuard';

describe('nav-guard registry (S8, #339)', () => {
  it('confirm passes when nothing is registered', () => {
    expect(createNavGuardRegistry().confirm()).toBe(true);
  });

  it('a registered guard decides; unregister restores pass-through', () => {
    const reg = createNavGuardRegistry();
    const guard = vi.fn(() => false);
    reg.register(guard);
    expect(reg.confirm()).toBe(false);
    expect(reg.guarded()).toBe(true);
    guard.mockReturnValue(true);
    expect(reg.confirm()).toBe(true);
    reg.unregister(guard);
    expect(reg.confirm()).toBe(true);
    expect(reg.guarded()).toBe(false);
  });

  it('last registration wins; a stale unregister does not remove the newer guard', () => {
    const reg = createNavGuardRegistry();
    const older = (): boolean => false;
    const newer = (): boolean => false;
    reg.register(older);
    reg.register(newer);
    reg.unregister(older); // stale cleanup from an unmounting effect must not disarm `newer`
    expect(reg.confirm()).toBe(false);
    reg.unregister(newer);
    expect(reg.confirm()).toBe(true);
  });
});
