import { afterEach, describe, expect, it, vi } from 'vitest';
import { relTime } from './time';

const NOW = 1_700_000_000_000; // fixed epoch ms so Date.now() is deterministic

// Format the timestamp `deltaMs` in the past relative to a frozen clock.
function ago(deltaMs: number): string {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return relTime(NOW - deltaMs);
}

describe('relTime', () => {
  afterEach(() => vi.useRealTimers());

  it('formats seconds, minutes, hours, days', () => {
    expect(ago(0)).toBe('0s ago');
    expect(ago(30_000)).toBe('30s ago');
    expect(ago(5 * 60_000)).toBe('5m ago');
    expect(ago(3 * 3_600_000)).toBe('3h ago');
    expect(ago(2 * 86_400_000)).toBe('2d ago');
  });

  it('switches unit exactly at each boundary', () => {
    expect(ago(59_000)).toBe('59s ago');
    expect(ago(60_000)).toBe('1m ago');
    expect(ago(3_600_000)).toBe('1h ago');
    expect(ago(86_400_000)).toBe('1d ago');
  });

  it('clamps future timestamps to 0s', () => {
    expect(ago(-10_000)).toBe('0s ago');
  });
});
