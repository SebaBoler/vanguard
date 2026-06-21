import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot, writeSnapshot } from './quota.js';

describe('snapshot cache', () => {
  it('round-trips a per-bucket snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-cache-'));
    try {
      expect(readSnapshot(dir, 'zai')).toBeUndefined();
      writeSnapshot(dir, 'zai', { usedPct: 70, resetAt: 123, fetchedAt: 456 });
      expect(readSnapshot(dir, 'zai')).toEqual({ usedPct: 70, resetAt: 123, fetchedAt: 456 });
      expect(readSnapshot(dir, 'claude')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a corrupt file instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-cache-'));
    try {
      writeSnapshot(dir, 'zai', { usedPct: 1, resetAt: 0, fetchedAt: 0 });
      // overwrite with garbage
      writeFileSync(join(dir, 'zai.json'), 'not json');
      expect(readSnapshot(dir, 'zai')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
