import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot, writeSnapshot } from './quota.js';
import { resolveModel, pctBucketCheck, AllBucketsFlooredError, type ModelEntry, type BucketCheck } from './quota.js';

const MODELS: ModelEntry[] = [
  { key: 'glm', bucket: 'zai', env: { A: 'z' } },
  { key: 'sonnet', bucket: 'claude', env: { A: 'c' } },
];
const up: BucketCheck = { available: async () => true };
const down: BucketCheck = { available: async () => false };

describe('resolveModel', () => {
  it('prefers the primary when its bucket is up', async () => {
    const r = await resolveModel('glm', ['glm', 'sonnet'], MODELS, { zai: up, claude: up });
    expect(r.key).toBe('glm');
  });
  it('spills to the next chain entry when the primary bucket is floored', async () => {
    const r = await resolveModel('glm', ['glm', 'sonnet'], MODELS, { zai: down, claude: up });
    expect(r.key).toBe('sonnet');
  });
  it('throws AllBucketsFlooredError when every bucket is floored', async () => {
    await expect(resolveModel('glm', ['glm', 'sonnet'], MODELS, { zai: down, claude: down }))
      .rejects.toBeInstanceOf(AllBucketsFlooredError);
  });
});

describe('pctBucketCheck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vg-check-'));
  it('available when a fresh snapshot is under bail', async () => {
    writeSnapshot(dir, 'zai', { usedPct: 50, resetAt: 0, fetchedAt: Date.now() });
    const c = pctBucketCheck(dir, 'zai', { bailPct: 97, ttlMs: 1e9, refresh: async () => { throw new Error('no'); } });
    expect(await c.available()).toBe(true);
  });
  it('floored when a fresh snapshot is at/over bail', async () => {
    writeSnapshot(dir, 'zai', { usedPct: 98, resetAt: 0, fetchedAt: Date.now() });
    const c = pctBucketCheck(dir, 'zai', { bailPct: 97, ttlMs: 1e9, refresh: async () => { throw new Error('no'); } });
    expect(await c.available()).toBe(false);
  });
  it('refreshes when stale and writes the new snapshot', async () => {
    writeSnapshot(dir, 'zai', { usedPct: 99, resetAt: 0, fetchedAt: 1 }); // ancient
    const c = pctBucketCheck(dir, 'zai', { bailPct: 97, ttlMs: 0, refresh: async () => ({ usedPct: 10, resetAt: 0, fetchedAt: Date.now() }) });
    expect(await c.available()).toBe(true);
    expect(readSnapshot(dir, 'zai')?.usedPct).toBe(10);
  });
  it('stale-tolerant: refresh error with no fresh data => available', async () => {
    const c = pctBucketCheck(dir, 'claude', { bailPct: 90, ttlMs: 0, refresh: async () => { throw new Error('429'); } });
    expect(await c.available()).toBe(true);
  });
  it('header-fed (no refresh): missing snapshot => available', async () => {
    const c = pctBucketCheck(dir, 'never-written', { bailPct: 90, ttlMs: 0 });
    expect(await c.available()).toBe(true);
  });
});

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
