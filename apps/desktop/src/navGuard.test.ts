import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createNavGuardRegistry, NavGuardContext, useDiscardGuard } from './navGuard';

function Probe({ dirty, confirmDiscard }: { dirty: boolean; confirmDiscard: () => boolean }): null {
  useDiscardGuard(dirty, confirmDiscard);
  return null;
}

function withRegistry(
  registry: ReturnType<typeof createNavGuardRegistry>,
  dirty: boolean,
  confirmDiscard: () => boolean,
): ReactElement {
  return createElement(NavGuardContext.Provider, { value: registry }, createElement(Probe, { dirty, confirmDiscard }));
}

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

describe('useDiscardGuard (#339 follow-up)', () => {
  it('registers while dirty and unregisters when clean', () => {
    const reg = createNavGuardRegistry();
    const confirmDiscard = (): boolean => true;
    const { rerender } = render(withRegistry(reg, false, confirmDiscard));
    expect(reg.guarded()).toBe(false);
    rerender(withRegistry(reg, true, confirmDiscard));
    expect(reg.guarded()).toBe(true);
    rerender(withRegistry(reg, false, confirmDiscard));
    expect(reg.guarded()).toBe(false);
  });

  it('delegates to the latest confirmDiscard without re-registering on every render', () => {
    const reg = createNavGuardRegistry();
    const registerSpy = vi.spyOn(reg, 'register');
    const confirmA = vi.fn(() => true);
    const confirmB = vi.fn(() => true);
    const { rerender } = render(withRegistry(reg, true, confirmA));
    rerender(withRegistry(reg, true, confirmB));
    reg.confirm();
    expect(confirmB).toHaveBeenCalledTimes(1);
    expect(confirmA).not.toHaveBeenCalled();
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('is inert with no provider', () => {
    const confirmDiscard = (): boolean => true;
    expect(() => render(createElement(Probe, { dirty: true, confirmDiscard }))).not.toThrow();
    const reg = createNavGuardRegistry();
    expect(reg.guarded()).toBe(false);
  });

  it('unmounting while dirty releases the slot', () => {
    const reg = createNavGuardRegistry();
    const confirmDiscard = (): boolean => true;
    const { unmount } = render(withRegistry(reg, true, confirmDiscard));
    expect(reg.guarded()).toBe(true);
    unmount();
    expect(reg.guarded()).toBe(false);
  });

  it('screen-switch handoff: the newly mounted dirty screen survives the outgoing one\'s cleanup', () => {
    const reg = createNavGuardRegistry();
    const registerSpy = vi.spyOn(reg, 'register');
    const confirmA = (): boolean => false;
    const confirmB = (): boolean => true;
    function Both({ showA, showB }: { showA: boolean; showB: boolean }): ReactElement {
      return createElement(
        NavGuardContext.Provider,
        { value: reg },
        showA ? createElement(Probe, { dirty: true, confirmDiscard: confirmA }) : null,
        showB ? createElement(Probe, { dirty: true, confirmDiscard: confirmB }) : null,
      );
    }
    const { rerender } = render(createElement(Both, { showA: true, showB: false }));
    expect(reg.guarded()).toBe(true);
    const outgoing = registerSpy.mock.calls[0]![0];
    rerender(createElement(Both, { showA: false, showB: true }));
    // React normally destroys before creating; also exercise a late outgoing cleanup.
    reg.unregister(outgoing);
    expect(reg.guarded()).toBe(true);
    expect(reg.confirm()).toBe(true);
  });
});
