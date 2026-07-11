import { describe, expect, it } from 'vitest';
import { beginRun, endRun, cancelCurrent } from './cancel.js';

describe('cancel registry', () => {
  it('aborts the current run signal on cancel', () => {
    const signal = beginRun();
    expect(signal.aborted).toBe(false);
    cancelCurrent();
    expect(signal.aborted).toBe(true);
    endRun();
  });

  it('cancel with no active run is a no-op (does not throw)', () => {
    endRun();
    expect(() => cancelCurrent()).not.toThrow();
  });

  it('a second run gets a fresh, unaborted signal', () => {
    const a = beginRun();
    cancelCurrent();
    endRun();
    const b = beginRun();
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    endRun();
  });
});
