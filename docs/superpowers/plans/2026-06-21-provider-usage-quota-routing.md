# Provider Usage Tracking + Quota Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-provider usage/quota tracking first-class in vanguard and route stages between providers with sticky fallback when a quota floors, so jobs finish instead of dying mid-pipeline.

**Architecture:** A small data layer (`QuotaSnapshot`, per-bucket file cache, bucket-availability checks) feeds a `QuotaRoutingProvider` that resolves each stage's model against an ordered chain and overlays the chosen model's transport env. z.ai quota is polled host-side from its monitor JSON endpoint; Claude quota is scoured from `anthropic-ratelimit-unified-*` headers at vanguard's own TLS-terminating sidecar (the only host-side place those headers are visible). The header parser + atomic snapshot writer live in the shared zero-dep `llm-proxy-rewrite.mjs` so the sidecar and the TS app use one implementation.

**Tech Stack:** TypeScript (strict, NodeNext ESM), vitest (`vitest run`), Node 24, the existing `llm-proxy-server.mjs` sidecar, the Docker sandbox.

## Global Constraints

- **Test runner is vitest**, not bun. Tests are `*.test.ts` beside the source; run a single file with `npx vitest run <path>` and a single test with `-t "<name>"`. Full suite: `npm test`.
- **ESM, NodeNext**: every relative import ends in `.js` (or `.mjs`) even for `.ts` sources.
- **No new runtime dependencies.** Use `node:fs`, `node:path`, `node:os`, global `fetch` only.
- **Layering**: `src/agents/*` may import from `src/sandbox/*`, never the reverse. `QuotaSnapshot` therefore lives on the sandbox side (`llm-proxy-rewrite.d.mts`) and agents import it.
- **Sidecar is zero-dep plain ESM.** `llm-proxy-rewrite.mjs` and `llm-proxy-server.mjs` import only `node:*`. Anything they share with the TS app goes in `llm-proxy-rewrite.mjs` with a matching declaration in `llm-proxy-rewrite.d.mts`.
- **Security invariant (unchanged):** the sidecar never logs headers/body/secret/nonce; no secret or nonce ever lands in the quota snapshot file. Per-exec `-e KEY=VAL` env is argv-visible (`docker inspect`) — the per-stage overlay carries only `ANTHROPIC_BASE_URL` and the per-run nonce, never a real upstream key. Real keys stay in the tmpfs secrets file.
- **Build copies the sidecar files**: `package.json` `build` already `cp`s `llm-proxy-server.mjs` and `llm-proxy-rewrite.mjs` to `dist/`. No build change needed.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/agents/provider.ts` (modify) | Add `env?` to `AgentRunInput`. |
| `src/agents/claude-stream.ts` (modify) | Forward `input.env` to `sandbox.exec`. |
| `src/sandbox/llm-proxy-rewrite.mjs` (modify) | Add zero-dep `parseUnifiedRatelimit(headers, now?)` + `writeQuotaSnapshot(path, snap)`. |
| `src/sandbox/llm-proxy-rewrite.d.mts` (modify) | Declare `QuotaSnapshot`, `parseUnifiedRatelimit`, `writeQuotaSnapshot`. |
| `src/sandbox/llm-proxy-server.mjs` (modify) | When upstream=anthropic, harvest headers → `writeQuotaSnapshot(LLM_PROXY_QUOTA_FILE, …)`. |
| `src/agents/quota.ts` (create) | `worstWindow`, `readSnapshot`/`writeSnapshot`, `ModelEntry`/`BucketCheck`/`AllBucketsFlooredError`, `resolveModel`, `pctBucketCheck`, `zaiMonitorRefresh`. Re-exports `QuotaSnapshot`, `parseUnifiedRatelimit`. |
| `src/agents/quota-routing.ts` (create) | `QuotaRoutingProvider` + `quotaRoutedAgent()` factory. |
| `src/index.ts` (modify) | Export the new public symbols. |

Tests live beside each source: `quota.test.ts`, `quota-routing.test.ts`, `llm-proxy-rewrite.test.ts` (extend if present, else create), `claude-stream.test.ts` (create if absent).

---

## Task 1: Thread per-stage env through `runClaudeCli`

**Files:**
- Modify: `src/agents/provider.ts`
- Modify: `src/agents/claude-stream.ts:37-42`
- Test: `src/agents/claude-stream.test.ts` (create)

**Interfaces:**
- Produces: `AgentRunInput.env?: Record<string, string>` — per-invocation env overlaid on the sandbox env; consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `src/agents/claude-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runClaudeCli } from './claude-stream.js';
import type { AgentRunInput } from './provider.js';

describe('runClaudeCli env forwarding', () => {
  it('forwards input.env to sandbox.exec', async () => {
    let seenEnv: Record<string, string> | undefined;
    const sandbox = {
      exec: async (_cmd: string, opts: { env?: Record<string, string> }) => {
        seenEnv = opts.env;
        return { stdout: '{"type":"result","result":"ok","session_id":"s"}', stderr: '', exitCode: 0 };
      },
    } as unknown as AgentRunInput['sandbox'];

    const input = {
      prompt: 'hi', sandbox, workdir: '/w', home: '/h', env: { ANTHROPIC_BASE_URL: 'http://x' },
    } as AgentRunInput;
    const gen = runClaudeCli(input, () => ['--print']);
    while (!(await gen.next()).done) { /* drain */ }
    expect(seenEnv).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/claude-stream.test.ts -t "forwards input.env"`
Expected: FAIL — `seenEnv` is `undefined` (env not forwarded).

- [ ] **Step 3: Add `env` to `AgentRunInput`**

In `src/agents/provider.ts`, inside `interface AgentRunInput`, after `model?: string;`:

```ts
  /** Per-invocation env overlaid on the sandbox env (e.g. per-stage transport: ANTHROPIC_BASE_URL + nonce). */
  env?: Record<string, string>;
```

- [ ] **Step 4: Forward it in `runClaudeCli`**

In `src/agents/claude-stream.ts`, change the `sandbox.exec` options block (currently lines 38-42):

```ts
  const res = await input.sandbox.exec(command, {
    cwd: input.workdir,
    input: input.prompt,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/agents/claude-stream.test.ts -t "forwards input.env"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/provider.ts src/agents/claude-stream.ts src/agents/claude-stream.test.ts
git commit -m "feat(agents): forward per-invocation env through runClaudeCli for per-stage transport"
```

---

## Task 2: Shared header parser + atomic snapshot writer (zero-dep)

**Files:**
- Modify: `src/sandbox/llm-proxy-rewrite.mjs`
- Modify: `src/sandbox/llm-proxy-rewrite.d.mts`
- Test: `src/sandbox/llm-proxy-rewrite.test.ts` (extend if present, else create)

**Interfaces:**
- Produces (consumed by Tasks 3, 5, 6, 7):
  - `interface QuotaSnapshot { usedPct: number; resetAt: number; fetchedAt: number }`
  - `function parseUnifiedRatelimit(headers: Record<string, string | string[] | undefined>, now?: number): QuotaSnapshot | undefined`
  - `function writeQuotaSnapshot(filePath: string, snap: QuotaSnapshot): void` (atomic: tmp + rename)

- [ ] **Step 1: Write the failing test**

Add to `src/sandbox/llm-proxy-rewrite.test.ts` (create the file with this content if it does not exist; otherwise append the `describe` blocks):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedRatelimit, writeQuotaSnapshot } from './llm-proxy-rewrite.mjs';

describe('parseUnifiedRatelimit', () => {
  it('derives usedPct from remaining/limit and resetAt from epoch-seconds reset', () => {
    const snap = parseUnifiedRatelimit({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-remaining': '200',
      'anthropic-ratelimit-unified-limit': '1000',
      'anthropic-ratelimit-unified-reset': '1750000000',
    }, 1_700_000_000_000);
    expect(snap).toEqual({ usedPct: 80, resetAt: 1_750_000_000_000, fetchedAt: 1_700_000_000_000 });
  });

  it('falls back to status when no remaining/limit (rejected => 100)', () => {
    const snap = parseUnifiedRatelimit({ 'anthropic-ratelimit-unified-status': 'rejected' }, 5);
    expect(snap).toEqual({ usedPct: 100, resetAt: 0, fetchedAt: 5 });
  });

  it('returns undefined when no unified headers present', () => {
    expect(parseUnifiedRatelimit({ 'content-type': 'application/json' }, 5)).toBeUndefined();
  });

  it('handles array-valued headers and ISO reset', () => {
    const snap = parseUnifiedRatelimit({
      'anthropic-ratelimit-unified-remaining': ['0'],
      'anthropic-ratelimit-unified-limit': ['100'],
      'anthropic-ratelimit-unified-reset': '2025-01-01T00:00:00Z',
    }, 5);
    expect(snap?.usedPct).toBe(100);
    expect(snap?.resetAt).toBe(Date.parse('2025-01-01T00:00:00Z'));
  });
});

describe('writeQuotaSnapshot', () => {
  it('writes parseable JSON atomically and leaves no .tmp', () => {
    const path = join(tmpdir(), `vg-quota-${process.pid}.json`);
    rmSync(path, { force: true });
    writeQuotaSnapshot(path, { usedPct: 42, resetAt: 0, fetchedAt: 9 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ usedPct: 42, resetAt: 0, fetchedAt: 9 });
    const leftovers = readdirSync(tmpdir()).filter((f) => f.startsWith(`vg-quota-${process.pid}.json`) && f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    rmSync(path, { force: true });
    expect(existsSync(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/llm-proxy-rewrite.test.ts -t "parseUnifiedRatelimit"`
Expected: FAIL — `parseUnifiedRatelimit` is not exported.

- [ ] **Step 3: Implement in `llm-proxy-rewrite.mjs`**

Append to `src/sandbox/llm-proxy-rewrite.mjs`:

```js
import { writeFileSync, renameSync } from 'node:fs';

/** First value of a possibly-array header. */
function headerValue(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Reset value -> epoch ms. Accepts epoch-seconds, epoch-ms, or an ISO string; 0 when absent/unparseable. */
function parseResetMs(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const iso = Date.parse(raw);
  return Number.isNaN(iso) ? 0 : iso;
}

/**
 * Parse Anthropic unified rate-limit headers into a QuotaSnapshot. Prefers remaining/limit (exact
 * percent); falls back to the status string (rejected=100, allowed_warning=95, allowed=0). Returns
 * undefined when no unified header is present (so callers can ignore non-Anthropic responses).
 * NOTE: confirm the exact header names against a real Claude response (Task 7 Step 6) and adjust the
 * three name constants if they differ — the parse logic is name-agnostic beyond these.
 */
export function parseUnifiedRatelimit(headers, now = Date.now()) {
  const status = headerValue(headers, 'anthropic-ratelimit-unified-status');
  const remaining = Number(headerValue(headers, 'anthropic-ratelimit-unified-remaining'));
  const limit = Number(headerValue(headers, 'anthropic-ratelimit-unified-limit'));
  const reset = headerValue(headers, 'anthropic-ratelimit-unified-reset');
  if (status === undefined && !Number.isFinite(remaining)) return undefined;
  let usedPct;
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    usedPct = Math.round(100 * (1 - remaining / limit));
  } else if (status === 'rejected') {
    usedPct = 100;
  } else if (status === 'allowed_warning') {
    usedPct = 95;
  } else {
    usedPct = 0;
  }
  return { usedPct, resetAt: parseResetMs(reset), fetchedAt: now };
}

/** Atomically write a QuotaSnapshot as JSON (tmp file + rename). */
export function writeQuotaSnapshot(filePath, snap) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, filePath);
}
```

- [ ] **Step 4: Declare the types**

Append to `src/sandbox/llm-proxy-rewrite.d.mts`:

```ts
export interface QuotaSnapshot {
  /** Percent of the most-constrained window consumed, 0..100. */
  usedPct: number;
  /** Epoch ms when the window resets; 0 if unknown. */
  resetAt: number;
  /** Epoch ms the snapshot was taken. */
  fetchedAt: number;
}

/** Parse Anthropic unified rate-limit headers into a snapshot; undefined if none present. */
export declare function parseUnifiedRatelimit(
  headers: Record<string, string | string[] | undefined>,
  now?: number,
): QuotaSnapshot | undefined;

/** Atomically write a snapshot as JSON (tmp + rename). */
export declare function writeQuotaSnapshot(filePath: string, snap: QuotaSnapshot): void;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/sandbox/llm-proxy-rewrite.test.ts -t "parseUnifiedRatelimit"` then `-t "writeQuotaSnapshot"`
Expected: PASS for both.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/llm-proxy-rewrite.mjs src/sandbox/llm-proxy-rewrite.d.mts src/sandbox/llm-proxy-rewrite.test.ts
git commit -m "feat(sandbox): zero-dep unified-ratelimit parser + atomic quota snapshot writer"
```

---

## Task 3: Per-bucket snapshot cache

**Files:**
- Create: `src/agents/quota.ts`
- Test: `src/agents/quota.test.ts` (create)

**Interfaces:**
- Consumes: `QuotaSnapshot`, `writeQuotaSnapshot` (Task 2).
- Produces (consumed by Tasks 4, 6):
  - `type BucketId = string`
  - `function readSnapshot(cacheDir: string, bucket: BucketId): QuotaSnapshot | undefined`
  - `function writeSnapshot(cacheDir: string, bucket: BucketId, snap: QuotaSnapshot): void`
  - re-export `type QuotaSnapshot`

- [ ] **Step 1: Write the failing test**

Create `src/agents/quota.test.ts`:

```ts
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
      // eslint-disable-next-line no-sync
      require('node:fs').writeFileSync(join(dir, 'zai.json'), 'not json');
      expect(readSnapshot(dir, 'zai')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/quota.test.ts -t "snapshot cache"`
Expected: FAIL — module `./quota.js` not found.

- [ ] **Step 3: Implement the cache in `quota.ts`**

Create `src/agents/quota.ts`:

```ts
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeQuotaSnapshot, type QuotaSnapshot } from '../sandbox/llm-proxy-rewrite.mjs';

export type { QuotaSnapshot };

/** A quota pool. Many models may draw from one bucket. */
export type BucketId = string;

function bucketPath(cacheDir: string, bucket: BucketId): string {
  return join(cacheDir, `${bucket}.json`);
}

/** Read a bucket's last snapshot; undefined when absent or unparseable. */
export function readSnapshot(cacheDir: string, bucket: BucketId): QuotaSnapshot | undefined {
  const path = bucketPath(cacheDir, bucket);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as QuotaSnapshot;
  } catch {
    return undefined;
  }
}

/** Write a bucket's snapshot (one file per bucket → single writer, no lock). */
export function writeSnapshot(cacheDir: string, bucket: BucketId, snap: QuotaSnapshot): void {
  mkdirSync(cacheDir, { recursive: true });
  writeQuotaSnapshot(bucketPath(cacheDir, bucket), snap);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/quota.test.ts -t "snapshot cache"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/quota.ts src/agents/quota.test.ts
git commit -m "feat(agents): per-bucket quota snapshot cache (one file per bucket, no lock)"
```

---

## Task 4: Matrix, resolver, and bucket checks

**Files:**
- Modify: `src/agents/quota.ts`
- Test: `src/agents/quota.test.ts`

**Interfaces:**
- Consumes: `readSnapshot`, `writeSnapshot`, `QuotaSnapshot`, `BucketId` (Task 3).
- Produces (consumed by Task 6):
  - `interface ModelEntry { key: string; bucket: BucketId; effort?: ReasoningEffort; env: Record<string, string> }`
  - `interface BucketCheck { available(): Promise<boolean> }`
  - `class AllBucketsFlooredError extends Error`
  - `function resolveModel(preferred: string, chain: string[], models: ModelEntry[], checks: Record<BucketId, BucketCheck>): Promise<ModelEntry>`
  - `function pctBucketCheck(cacheDir: string, bucket: BucketId, opts: { bailPct: number; ttlMs: number; refresh?: () => Promise<QuotaSnapshot> }): BucketCheck`

- [ ] **Step 1: Write the failing test**

Append to `src/agents/quota.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/quota.test.ts -t "resolveModel"`
Expected: FAIL — `resolveModel` not exported.

- [ ] **Step 3: Implement matrix + resolver + checks**

Append to `src/agents/quota.ts` (add `ReasoningEffort` to the imports at the top):

```ts
import type { ReasoningEffort } from '../core/types.js';

/** A model and the bucket + transport env it uses. */
export interface ModelEntry {
  /** Exact model id passed as --model. */
  key: string;
  /** Quota pool this model draws from. */
  bucket: BucketId;
  /** Default reasoning effort (a stage's own effort overrides this). */
  effort?: ReasoningEffort;
  /** Per-stage env overlay selecting this model's transport/auth. */
  env: Record<string, string>;
}

/** True when a bucket has quota headroom right now (implementations cache/refresh internally). */
export interface BucketCheck {
  available(): Promise<boolean>;
}

export class AllBucketsFlooredError extends Error {
  constructor(preferred: string) {
    super(`All buckets floored for chain starting at '${preferred}'`);
    this.name = 'AllBucketsFlooredError';
  }
}

/** First entry in `chain` (from `preferred` onward) whose bucket is available; throws if none. */
export async function resolveModel(
  preferred: string,
  chain: string[],
  models: ModelEntry[],
  checks: Record<BucketId, BucketCheck>,
): Promise<ModelEntry> {
  const start = chain.indexOf(preferred);
  const ordered = start >= 0 ? chain.slice(start) : chain;
  for (const key of ordered) {
    const entry = models.find((m) => m.key === key);
    if (entry === undefined) continue;
    const check = checks[entry.bucket];
    if (check === undefined || (await check.available())) return entry;
  }
  throw new AllBucketsFlooredError(preferred);
}

export interface PctCheckOptions {
  /** usedPct at/above which the bucket is considered floored. */
  bailPct: number;
  /** Refresh when the cached snapshot is older than this (ms). */
  ttlMs: number;
  /** Optional active refresh (z.ai monitor poll). Omit for header-fed buckets (Claude). */
  refresh?: () => Promise<QuotaSnapshot>;
}

const warnedMissing = new Set<BucketId>();

/**
 * Bucket check from a percent-used snapshot in the cache. Refreshes when stale (if a refresh fn is
 * given). On refresh failure, falls back to the last snapshot. With no usable snapshot it returns
 * available (best-effort terminal fallback) and, for a header-fed bucket, warns once that no quota
 * data exists — a sign the bucket is not routed through vanguard's sidecar (e.g. Claude via LiteLLM,
 * which strips the headers).
 */
export function pctBucketCheck(cacheDir: string, bucket: BucketId, opts: PctCheckOptions): BucketCheck {
  return {
    available: async () => {
      let snap = readSnapshot(cacheDir, bucket);
      const stale = snap === undefined || Date.now() - snap.fetchedAt > opts.ttlMs;
      if (stale && opts.refresh !== undefined) {
        try {
          snap = await opts.refresh();
          writeSnapshot(cacheDir, bucket, snap);
        } catch {
          // keep last snapshot; a refresh/usage-endpoint error must never read as "floored"
        }
      }
      if (snap === undefined) {
        if (opts.refresh === undefined && !warnedMissing.has(bucket)) {
          warnedMissing.add(bucket);
          console.warn(
            `[quota] no snapshots for header-fed bucket '${bucket}'. ` +
              `Usage tracking needs it routed through vanguard's sidecar; LiteLLM strips the rate-limit headers.`,
          );
        }
        return true;
      }
      return snap.usedPct < opts.bailPct;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/quota.test.ts`
Expected: PASS (all `resolveModel` + `pctBucketCheck` + cache tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/quota.ts src/agents/quota.test.ts
git commit -m "feat(agents): bucket matrix, ordered resolver, stale-tolerant pct checks"
```

---

## Task 5: z.ai monitor refresh (moved out of kotor)

**Files:**
- Modify: `src/agents/quota.ts`
- Test: `src/agents/quota.test.ts`

**Interfaces:**
- Consumes: `QuotaSnapshot` (Task 2).
- Produces (consumed by Task 6):
  - `function worstWindow(windows: Array<{ usedPct: number; resetAt: number }>, now?: number): QuotaSnapshot`
  - `function zaiMonitorRefresh(env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<QuotaSnapshot>`

- [ ] **Step 1: Write the failing test**

Append to `src/agents/quota.test.ts`:

```ts
import { worstWindow, zaiMonitorRefresh } from './quota.js';

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
    await expect(zaiMonitorRefresh({} as NodeJS.ProcessEnv, (async () => ({ json: async () => ({}) })) as unknown as typeof fetch))
      .rejects.toThrow(/ZAI_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/quota.test.ts -t "zaiMonitorRefresh"`
Expected: FAIL — `zaiMonitorRefresh` not exported.

- [ ] **Step 3: Implement worstWindow + zaiMonitorRefresh**

Append to `src/agents/quota.ts`:

```ts
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

/** Most-depleted window wins (matches z.ai's rolling 5h + weekly token windows). */
export function worstWindow(windows: Array<{ usedPct: number; resetAt: number }>, now = Date.now()): QuotaSnapshot {
  const worst = windows.reduce(
    (a, b) => (b.usedPct > a.usedPct ? b : a),
    { usedPct: 0, resetAt: 0 },
  );
  return { usedPct: worst.usedPct, resetAt: worst.resetAt, fetchedAt: now };
}

/**
 * Read the z.ai monitor endpoint host-side (the z.ai key is the host's, never the sandbox's) and map
 * the TOKENS_LIMIT windows to the worst snapshot. The `refresh` fn for the z.ai pctBucketCheck.
 */
export async function zaiMonitorRefresh(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
  const key = env['ZAI_API_KEY'];
  if (key === undefined || key === '') throw new Error('zaiMonitorRefresh needs ZAI_API_KEY in the environment.');
  const res = await fetchImpl(ZAI_QUOTA_URL, { headers: { Authorization: `Bearer ${key}` } });
  const json = (await res.json()) as {
    data?: { limits?: Array<{ type: string; percentage?: number; nextResetTime?: number }> };
  };
  const windows = (json.data?.limits ?? [])
    .filter((l) => l.type === 'TOKENS_LIMIT')
    .map((l) => ({ usedPct: l.percentage ?? 0, resetAt: l.nextResetTime ?? 0 }));
  return worstWindow(windows);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/quota.test.ts -t "worstWindow"` then `-t "zaiMonitorRefresh"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/quota.ts src/agents/quota.test.ts
git commit -m "feat(agents): zai monitor refresh + worst-window mapper (moved from kotor)"
```

---

## Task 6: `QuotaRoutingProvider` + `quotaRoutedAgent` factory

**Files:**
- Create: `src/agents/quota-routing.ts`
- Test: `src/agents/quota-routing.test.ts` (create)

**Interfaces:**
- Consumes: `resolveModel`, `pctBucketCheck`, `readSnapshot`, `ModelEntry`, `BucketCheck`, `BucketId`, `QuotaSnapshot`, `zaiMonitorRefresh` (Tasks 3-5); `AgentProvider`, `AgentRunInput`, `AgentTurn`, `AgentRunOutput` (`provider.ts`); `ZaiProvider` (`zai.ts`).
- Produces (consumed by Task 8 export + kotor):
  - `class QuotaRoutingProvider implements AgentProvider` — ctor `({ delegate, models, checks, chain, cacheDir, debug? })`; sticky on floor; overlays each model's `env`/`effort`; emits a burn line per turn when `debug` is set.
  - `function quotaRoutedAgent(opts: QuotaRoutedOptions): QuotaRoutingProvider`
  - `interface QuotaRoutedOptions { buckets: Record<BucketId, { bailPct: number; ttlMs: number; refresh?: () => Promise<QuotaSnapshot> }>; models: ModelEntry[]; chain: string[]; cacheDir: string; delegate?: AgentProvider; debug?: (line: string) => void }`

- [ ] **Step 1: Write the failing test**

Create `src/agents/quota-routing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { QuotaRoutingProvider } from './quota-routing.js';
import type { ModelEntry, BucketCheck } from './quota.js';
import type { AgentProvider, AgentRunInput } from './provider.js';

const MODELS: ModelEntry[] = [
  { key: 'glm', bucket: 'zai', env: { A: 'z' } },
  { key: 'sonnet', bucket: 'claude', env: { A: 'c' } },
];

function fakeDelegate() {
  const calls: Array<{ model?: string; env?: Record<string, string> }> = [];
  const provider: AgentProvider = {
    name: 'fake',
    async *run(input: AgentRunInput) {
      calls.push({ model: input.model, env: input.env });
      yield { text: 't' };
      return { finalText: 'ok', turns: 1 };
    },
  };
  return { provider, calls };
}

const up: BucketCheck = { available: async () => true };

describe('QuotaRoutingProvider', () => {
  it('routes to the primary and overlays its env', async () => {
    const { provider, calls } = fakeDelegate();
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: up, claude: up },
    });
    const g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* drain */ }
    expect(calls[0]).toEqual({ model: 'glm', env: { A: 'z' } });
  });

  it('is sticky: once zai floors, later stages stay on claude even if zai recovers', async () => {
    const { provider, calls } = fakeDelegate();
    let zaiUp = false;
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: { available: async () => zaiUp }, claude: up },
    });
    let g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* stage 1: zai down -> claude */ }
    zaiUp = true; // "recovers"
    g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* stage 2: still claude */ }
    expect(calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
  });

  it('emits a burn line per turn to the debug sink', async () => {
    const { provider } = fakeDelegate();
    const lines: string[] = [];
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: up, claude: up }, debug: (l) => lines.push(l),
    });
    const g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* drain */ }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[quota]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/quota-routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider + factory**

Create `src/agents/quota-routing.ts`:

```ts
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from './provider.js';
import {
  resolveModel, pctBucketCheck, readSnapshot,
  type BucketId, type BucketCheck, type ModelEntry, type QuotaSnapshot,
} from './quota.js';
import { ZaiProvider } from './zai.js';

export interface QuotaRoutingOptions {
  delegate: AgentProvider;
  models: ModelEntry[];
  checks: Record<BucketId, BucketCheck>;
  chain: string[];
  cacheDir: string;
  /** Optional sink for a per-turn live-burn line; omit to disable. */
  debug?: (line: string) => void;
}

/**
 * AgentProvider wrapper that picks a stage's model from a bucket-availability matrix at run() time (the
 * per-stage boundary), overlays that model's transport env + effort, then delegates. Sticky within the
 * wrapper's lifetime: a bucket that floors once stays floored (no flip-back), so "z.ai did the early
 * stages, Claude finishes" — keeping work moving when a window empties rather than stalling.
 */
export class QuotaRoutingProvider implements AgentProvider {
  readonly name = 'quota-routing';
  private readonly floored = new Set<BucketId>();

  constructor(private readonly opts: QuotaRoutingOptions) {}

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const checks = this.stickyChecks();
    const preferred = input.model ?? this.opts.chain[0];
    const entry = await resolveModel(preferred, this.opts.chain, this.opts.models, checks);
    const next: AgentRunInput = {
      ...input,
      model: entry.key,
      env: { ...(input.env ?? {}), ...entry.env },
      ...(input.effort === undefined && entry.effort !== undefined ? { effort: entry.effort } : {}),
    };

    const it = this.opts.delegate.run(next);
    let r = await it.next();
    while (r.done !== true) {
      if (this.opts.debug !== undefined) this.opts.debug(this.burnLine());
      yield r.value;
      r = await it.next();
    }
    return r.value;
  }

  /** Wrap each check so a bucket that floors once is treated floored for the rest of this run. */
  private stickyChecks(): Record<BucketId, BucketCheck> {
    const out: Record<BucketId, BucketCheck> = {};
    for (const [bucket, check] of Object.entries(this.opts.checks)) {
      out[bucket] = {
        available: async () => {
          if (this.floored.has(bucket)) return false;
          const ok = await check.available();
          if (!ok) this.floored.add(bucket);
          return ok;
        },
      };
    }
    return out;
  }

  /** One-line live-burn summary across buckets, read from the cache. */
  private burnLine(): string {
    const parts = Object.keys(this.opts.checks).map((bucket) => {
      const snap = readSnapshot(this.opts.cacheDir, bucket);
      if (snap === undefined) return `${bucket} ?`;
      const resetMin = snap.resetAt > 0 ? Math.round((snap.resetAt - Date.now()) / 60_000) : 0;
      return resetMin > 0 ? `${bucket} ${snap.usedPct}% (resets ${resetMin}m)` : `${bucket} ${snap.usedPct}%`;
    });
    return `[quota] ${parts.join(' · ')}`;
  }
}

export interface QuotaBucketConfig {
  bailPct: number;
  ttlMs: number;
  /** z.ai: zaiMonitorRefresh. Claude/header-fed: omit. */
  refresh?: () => Promise<QuotaSnapshot>;
}

export interface QuotaRoutedOptions {
  buckets: Record<BucketId, QuotaBucketConfig>;
  models: ModelEntry[];
  chain: string[];
  cacheDir: string;
  /** Defaults to a ZaiProvider (runClaudeCli with GLM args); the wrapper overrides model + env per stage. */
  delegate?: AgentProvider;
  debug?: (line: string) => void;
}

/** Build a QuotaRoutingProvider from bucket thresholds — the one-call consumer entry point. */
export function quotaRoutedAgent(opts: QuotaRoutedOptions): QuotaRoutingProvider {
  const checks: Record<BucketId, BucketCheck> = {};
  for (const [bucket, cfg] of Object.entries(opts.buckets)) {
    checks[bucket] = pctBucketCheck(opts.cacheDir, bucket, {
      bailPct: cfg.bailPct,
      ttlMs: cfg.ttlMs,
      ...(cfg.refresh !== undefined ? { refresh: cfg.refresh } : {}),
    });
  }
  return new QuotaRoutingProvider({
    delegate: opts.delegate ?? new ZaiProvider(),
    models: opts.models,
    checks,
    chain: opts.chain,
    cacheDir: opts.cacheDir,
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/quota-routing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/quota-routing.ts src/agents/quota-routing.test.ts
git commit -m "feat(agents): QuotaRoutingProvider (sticky per-stage routing) + quotaRoutedAgent factory"
```

---

## Task 7: Harvest Claude headers in the sidecar

**Files:**
- Modify: `src/sandbox/llm-proxy-server.mjs`
- Test: manual smoke (the parser/writer are unit-tested in Task 2; this wires them)

**Interfaces:**
- Consumes: `parseUnifiedRatelimit`, `writeQuotaSnapshot` (Task 2).
- Produces: when upstream=anthropic and `LLM_PROXY_QUOTA_FILE` is set, each upstream response writes a `QuotaSnapshot` to that path.

- [ ] **Step 1: Import the harvest helpers**

In `src/sandbox/llm-proxy-server.mjs`, extend the existing import from `./llm-proxy-rewrite.mjs` to add the two new names:

```js
import { upstreamAuthHeaders, openaiAuthHeaders, zaiAuthHeaders, isAllowedLlmPath, constantTimeEqual, parseUnifiedRatelimit, writeQuotaSnapshot } from './llm-proxy-rewrite.mjs';
```

- [ ] **Step 2: Read the quota file path from env (once, at boot)**

After the line `const PORT = Number(process.env.PORT ?? '8088');`, add:

```js
// Optional: when set (anthropic upstream only), harvest rate-limit headers off each response.
const QUOTA_FILE = upstreamKind === 'anthropic' ? (process.env.LLM_PROXY_QUOTA_FILE ?? '') : '';
```

- [ ] **Step 3: Harvest on the upstream response**

In `forward()`, inside the upstream response callback (`(upRes) => { … }`), after the existing
`outHeaders` loop and before `res.writeHead(...)`, add:

```js
      if (QUOTA_FILE !== '') {
        try {
          const snap = parseUnifiedRatelimit(upRes.headers);
          if (snap !== undefined) writeQuotaSnapshot(QUOTA_FILE, snap);
        } catch {
          // never let quota bookkeeping break proxying; never log header contents
        }
      }
```

- [ ] **Step 4: Build to confirm the sidecar copies + the TS still compiles**

Run: `npm run build`
Expected: `tsc` clean and `dist/sandbox/llm-proxy-server.mjs` + `dist/sandbox/llm-proxy-rewrite.mjs` present.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all green, including the Task 2 parser/writer tests.

- [ ] **Step 6: Confirm the real header names (verification gate)**

With a real OAuth token, capture one Claude response's headers through the sidecar (or a direct
`curl -D -` to `https://api.anthropic.com/v1/messages`) and confirm the three
`anthropic-ratelimit-unified-status|remaining|limit|reset` names exist as used in
`parseUnifiedRatelimit`. If a name differs, update the constant string(s) in `llm-proxy-rewrite.mjs`
and the Task 2 fixtures, then re-run `npx vitest run src/sandbox/llm-proxy-rewrite.test.ts`. Record
the captured header block in the PR description.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox/llm-proxy-server.mjs
git commit -m "feat(sandbox): harvest Claude unified-ratelimit headers into the quota snapshot file"
```

---

## Task 8: Export the public surface

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts` (create — a thin re-export smoke test)

**Interfaces:**
- Consumes: everything public from Tasks 3-6.
- Produces: the package's public quota API.

- [ ] **Step 1: Write the failing test**

Create `src/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as api from './index.js';

describe('public quota exports', () => {
  it('exposes the quota routing surface', () => {
    expect(typeof api.quotaRoutedAgent).toBe('function');
    expect(typeof api.QuotaRoutingProvider).toBe('function');
    expect(typeof api.resolveModel).toBe('function');
    expect(typeof api.pctBucketCheck).toBe('function');
    expect(typeof api.zaiMonitorRefresh).toBe('function');
    expect(typeof api.worstWindow).toBe('function');
    expect(typeof api.readSnapshot).toBe('function');
    expect(typeof api.writeSnapshot).toBe('function');
    expect(typeof api.AllBucketsFlooredError).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — exports undefined.

- [ ] **Step 3: Add the exports**

In `src/index.ts`, after the `ZaiProvider` export line (line 22):

```ts
export {
  readSnapshot, writeSnapshot, worstWindow, resolveModel, pctBucketCheck, zaiMonitorRefresh,
  AllBucketsFlooredError,
} from './agents/quota.js';
export type { QuotaSnapshot, BucketId, ModelEntry, BucketCheck, PctCheckOptions } from './agents/quota.js';
export { QuotaRoutingProvider, quotaRoutedAgent } from './agents/quota-routing.js';
export type { QuotaRoutingOptions, QuotaRoutedOptions, QuotaBucketConfig } from './agents/quota-routing.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate**

Run: `npm run build && npm test`
Expected: `tsc` clean, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: export provider usage tracking + quota routing public API"
```

---

## Self-Review

**Spec coverage:**
- Two-transport split (GLM→LiteLLM, Claude→sidecar) → Tasks 6 (env overlay) + 7 (harvest). ✓
- `QuotaSnapshot` + pure mappers (`worstWindow`, `parseUnifiedRatelimit`) → Tasks 2, 5. ✓
- Per-bucket file cache, no lock → Task 3. ✓
- Matrix/resolver/checks, stale-tolerant, usage-error ≠ floored → Task 4. ✓
- `zaiMonitorRefresh` moved from kotor → Task 5. ✓
- `QuotaRoutingProvider` sticky + env overlay + per-turn `debug` → Task 6. ✓
- Header harvest at the sidecar via `LLM_PROXY_QUOTA_FILE` → Task 7. ✓
- `quotaRoutedAgent` factory + building-block exports → Tasks 6, 8. ✓
- Known limitation warning (Claude via LiteLLM = no tracking) → Task 4 `pctBucketCheck` one-time warn. ✓
- Per-stage env threading (docker already renders `-e`) → Task 1. ✓
- Security: nonce/base-URL only in `-e` overlay, no secret in snapshot file, sidecar log invariant → Global Constraints + Task 7 try/catch. ✓

**Out of scope (unchanged from spec):** LiteLLM config / virtual keys / `[proxy]` repo; kotor wiring beyond calling the factory; OpenRouter/DeepSeek same-model fallback.

**Placeholder scan:** none — every code step has full code; the one open item (exact header names) is a real verification gate (Task 7 Step 6) with a working tolerant default, not a placeholder.

**Type consistency:** `QuotaSnapshot` (sandbox layer) re-exported by `quota.ts`; `ModelEntry`/`BucketCheck`/`BucketId` defined in `quota.ts` and consumed identically in `quota-routing.ts` + index; `resolveModel`/`pctBucketCheck`/`worstWindow`/`zaiMonitorRefresh` signatures match across tasks. ✓

**Open verification (carried from spec):** exact `anthropic-ratelimit-unified-*` header names — gated in Task 7 Step 6, parser is tolerant and name-localized.
