import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot, writeSnapshot } from './quota.js';
import { resolveModel, pctBucketCheck, AllBucketsFlooredError, type ModelEntry, type BucketCheck } from './quota.js';
import { worstWindow, zaiMonitorRefresh } from './quota.js';

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

describe('worstWindow', () => {
  it('picks the most-depleted window', () => {
    const snap = worstWindow([{ usedPct: 30, resetAt: 1 }, { usedPct: 80, resetAt: 2 }], 999);
    expect(snap).toEqual({ usedPct: 80, resetAt: 2, fetchedAt: 999 });
  });
  it('returns 0% for no windows', () => {
    expect(worstWindow([], 5)).toEqual({ usedPct: 0, resetAt: 0, fetchedAt: 5 });
  });
});

describe('zaiMonitorRefresh', () => {
  it('maps TOKENS_LIMIT windows to the worst snapshot', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        data: { limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: 111 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 73, nextResetTime: 222 },
          { type: 'OTHER', unit: 3, number: 5, percentage: 99, nextResetTime: 333 },
        ] },
      }),
    })) as unknown as typeof fetch;
    const snap = await zaiMonitorRefresh({ ZAI_API_KEY: 'k' } as NodeJS.ProcessEnv, fakeFetch);
    expect(snap.usedPct).toBe(73);
    expect(snap.resetAt).toBe(222);
  });
  it('throws when ZAI_API_KEY is missing', async () => {
    await expect(zaiMonitorRefresh({} as NodeJS.ProcessEnv, (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch))
      .rejects.toThrow(/ZAI_API_KEY/);
  });
  it('throws on non-ok HTTP response', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 401 }),
    })) as unknown as typeof fetch;
    await expect(zaiMonitorRefresh({ ZAI_API_KEY: 'k' } as NodeJS.ProcessEnv, fakeFetch))
      .rejects.toThrow(/401/);
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

  it.each([
    ['null literal', 'null'],
    ['empty object', '{}'],
    ['number', '42'],
    ['array', '[]'],
  ])('returns undefined for structurally-invalid JSON: %s', (_label, raw) => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-cache-'));
    try {
      writeFileSync(join(dir, 'zai.json'), raw);
      expect(readSnapshot(dir, 'zai')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
