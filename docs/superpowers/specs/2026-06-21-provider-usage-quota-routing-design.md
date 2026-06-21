# Provider Usage Tracking + Quota Routing — Design

**Date:** 2026-06-21
**Repo:** `~/GitHub/vanguard`
**Status:** Approved for planning

## Goal

Make per-provider **usage/quota tracking** a first-class vanguard capability, and let a run fall
back between providers per-stage when a provider's quota floors — so jobs finish instead of dying
mid-pipeline. Pull the quota machinery out of consumer code (`kotor-kit/scripts/vanguard/_shared.ts`)
into vanguard so consumers shrink to "pick providers + thresholds."

This serves a concrete measurement: **is GLM pay-per-token actually cheaper than the Claude Max
subscription?** GLM runs through the LiteLLM proxy for cost accounting; Claude runs on the
subscription with quota read from rate-limit headers. Clean per-provider attribution is required.

## The split (architecture)

Two transports, chosen per stage by purpose:

| Provider          | Transport                              | Quota signal                                    | Why                                   |
| ----------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| GLM (z.ai)        | → LiteLLM proxy                        | z.ai **monitor JSON** endpoint, host-side poll  | cost tracking / pay-per-token measure |
| Claude (+ subs)   | → **vanguard sidecar** → api.anthropic | `anthropic-ratelimit-unified-*` scoured at sidecar | subscription, no per-token cost     |

One uniform abstraction (`UsageProbe` + `SharedQuotaCache` + `BucketCheck`) sits over both. vanguard
owns polling, caching, gating, and routing. The consumer picks providers and thresholds.

### Why this shape

- The in-sandbox `claude` CLI stream-json carries token `usage` + `total_cost_usd` but **not** the
  `anthropic-ratelimit-unified-*` reset/status headers (`src/agents/claude-stream.ts:5-13`). The only
  host-side place that sees Anthropic's raw response headers is a **TLS-terminating proxy vanguard
  owns** — the existing `llm-proxy-server.mjs` sidecar (upstream=anthropic). It already pipes those
  headers back to the CLI; we additionally read + record them. Zero extra upstream calls.
- The egress proxy only sees encrypted CONNECT bytes (cannot read headers). So harvest must be at the
  sidecar, not the egress layer.
- z.ai needs no header harvest — its monitor endpoint returns quota JSON directly, polled host-side
  with the z.ai key (already implemented as `zaiTokenQuota()` in kotor; moves into vanguard).

### Known limitation (enforced, not silent)

Claude routed through **LiteLLM** → LiteLLM strips the rate-limit headers → **no usage tracking**.
vanguard emits a loud warning at wiring time if a Claude/subscription bucket is configured against a
LiteLLM-style transport instead of the vanguard sidecar. Tracking only works on the sidecar path.

## Components

All new code under `src/agents/quota/`.

### `snapshot.ts` — types + pure mappers

```ts
export interface QuotaSnapshot {
  usedPct: number;     // 0..100
  resetAt: number;     // epoch ms; 0 if unknown
  fetchedAt: number;   // epoch ms
  source: 'monitor' | 'header' | 'stale';
}

// z.ai: worst (most-depleted) window wins.
export function worstWindow(windows: Array<{ usedPct: number; resetAt: number }>, now: number): QuotaSnapshot;

// Claude: parse anthropic-ratelimit-unified-* into a snapshot.
export function parseUnifiedRatelimit(headers: Record<string, string | string[] | undefined>, now: number): QuotaSnapshot | undefined;
```

Pure functions → tested with literal fixtures (the exact header names captured from a real Claude
response; the z.ai `data.limits[]` shape already known from `zaiTokenQuota`).

### `cache.ts` — `SharedQuotaCache`

- **One file per bucket**: `<cacheDir>/<bucket>.json` (e.g. `~/.cache/vanguard/quota/zai.json`,
  `.../claude.json`). Different writers never touch the same file (z.ai writer = vanguard host;
  Claude writer = the sidecar), so **no lockfile** and no read-modify-write race.
- Atomic write: write `<file>.tmp` then `rename` (POSIX atomic).
- API: `read(bucket): QuotaSnapshot | undefined`, `write(bucket, snap)`,
  `recordHeader(bucket, snap)` (writes only when `snap.fetchedAt >= current.fetchedAt`).
- Shared cross-project: kotor-kit and ModelBox point at the same `cacheDir`.

### `bucket.ts` — matrix, resolver, checks

```ts
export type BucketId = string;
export interface ModelEntry { key: string; bucket: BucketId; effort?: ReasoningEffort; env: Record<string, string>; }
export interface BucketCheck { available(): Promise<boolean>; }
export class AllBucketsFlooredError extends Error {}

// First entry in `chain` (ordered model keys, starting at/after preferred) whose bucket is available.
export function resolveModel(preferred: string, chain: string[], models: ModelEntry[], checks: Record<BucketId, BucketCheck>): Promise<ModelEntry>;

// Available when fresh snapshot usedPct < bailPct; refreshes when stale; stale-tolerant on refresh error.
export function pctBucketCheck(cache: SharedQuotaCache, bucket: BucketId, opts: { bailPct: number; ttlMs: number; refresh: () => Promise<QuotaSnapshot> }): BucketCheck;
```

Stale-tolerance rule: a refresh error (or the hostile usage endpoint 429ing) never trips the gate to
"floored" — fall back to the last snapshot; with no snapshot at all, return available (Claude is the
best-effort terminal fallback).

### `probe.ts` — `ZaiMonitorProbe`

The `zaiTokenQuota()` HTTP read (z.ai monitor endpoint, `Authorization: Bearer $ZAI_API_KEY`,
filter `TOKENS_LIMIT`, map windows) **moved out of kotor into vanguard**, exposed as the `refresh`
fn for the z.ai `pctBucketCheck`. Claude needs no probe — the sidecar pushes header snapshots in.

### `routing.ts` — `QuotaRoutingProvider`

`implements AgentProvider`. At `run()` (the per-stage boundary): resolve the model from
`input.model` (preferred key) against the chain, overlay the entry's `env` + `effort`, delegate to
the wrapped provider. **Sticky on floor**: a bucket that floors once during a run stays floored for
the rest of the run (in-instance `Set<BucketId>`) → "z.ai did the early stages, Claude finishes"
behavior, no thrash, no flip-back.

The point of the swap is to **keep work moving smoothly when a limit is hit** — fall over to the next
bucket at the stage boundary rather than stalling or abruptly dying mid-pipeline when a window empties.

**Live usage debug (`debug`):** when enabled, before each yielded turn the provider reads the current
snapshot(s) from the cache and prints a one-line burn summary alongside the existing per-turn log,
e.g. `[quota] zai 84% (resets 42m) · claude 12%`. The numbers are near-live: Claude updates per
response (sidecar writes the header snapshot), z.ai updates per TTL poll. Default off; opt-in per
consumer workflow. Sink defaults to stderr; a custom `log?: (line: string) => void` overrides it.

### High-level factory

```ts
const agent = quotaRoutedAgent({
  buckets: {
    zai:    { bailPct: 97, ttlMs: 60_000,  chainFirst: true,  refresh: zaiMonitorRefresh },
    claude: { bailPct: 90, ttlMs: 300_000, /* header-fed; reactive fallback */ },
  },
  models: MODELS,         // ModelEntry[] (key↔bucket↔env)
  cacheDir: '~/.cache/vanguard/quota',
  debug: true,            // print live burn before each turn (default false)
  log: console.error,     // optional sink override (default stderr)
});
```

Building blocks (`QuotaRoutingProvider`, `SharedQuotaCache`, `pctBucketCheck`, `resolveModel`,
`ZaiMonitorProbe`, `worstWindow`, `parseUnifiedRatelimit`, types) are **also** exported for custom
wiring. The factory removes the bulk of consumer boilerplate; the primitives keep it flexible.

## Infra changes (outside `quota/`)

### Header harvest in the sidecar

`src/sandbox/llm-proxy-server.mjs` (upstream=anthropic only): after reading `upRes.headers`, parse
`anthropic-ratelimit-unified-*` and write a `QuotaSnapshot{source:'header'}` to the path in
`LLM_PROXY_QUOTA_FILE` (atomic rename, zero-dep `node:fs`). No secret/nonce ever touches that file;
SECURITY log invariant unchanged (still never logs headers/body/secret/nonce). The host wires
`LLM_PROXY_QUOTA_FILE` to `<cacheDir>/claude.json` and ensures the path is writable by the sidecar.

### Per-stage transport env threading

The router must swap `ANTHROPIC_BASE_URL` (LiteLLM vs vanguard sidecar) per stage:

- `src/agents/provider.ts` — add `env?: Record<string, string>` to `AgentRunInput` (per-invocation
  env overlaid on the sandbox env).
- `src/agents/claude-stream.ts:38` — forward `input.env` to `sandbox.exec`.
- `src/sandbox/docker.ts` `exec()` — render `ExecOptions.env` as `docker exec -e KEY=VAL`. **Verify
  it isn't silently dropped today**; add rendering + a test if so.

## Consumer impact (boilerplate removed)

`kotor-kit/scripts/vanguard/_shared.ts` loses `zaiTokenQuota` + `preflightQuotaGate` + the
MODELS/checks/cache wiring (~120 lines) → one `quotaRoutedAgent({...})` call plus the `MODELS`
table (consumer-specific model keys + env maps remain consumer data).

## Testing

- Pure mappers (`worstWindow`, `parseUnifiedRatelimit`) — literal fixtures, including a real captured
  Claude header object.
- `resolveModel` — prefers primary; spills on floor; throws `AllBucketsFlooredError` when all floored.
- `pctBucketCheck` — fresh-under-bail available; at/over-bail floored; refresh-error stale-tolerant.
- `QuotaRoutingProvider` — routes to primary + overlays env; sticky once a bucket floors; `debug`
  emits a burn line per turn to the injected `log` sink (assert the sink receives it).
- `SharedQuotaCache` — per-bucket read/write round-trip; `recordHeader` newer-wins.
- Sidecar harvest — unit-test the header parser; smoke that the snapshot file is written + parseable.
- Per-stage env — `runClaudeCli` forwards `input.env`; docker `exec` renders `-e`.

## Out of scope

- Same-model cross-bucket fallback (OpenRouter/DeepSeek GLM) — would pollute the GLM measurement.
- LiteLLM config / virtual keys / proxy `gen-config.py` — that's the `[proxy]` repo, not vanguard.
- kotor wiring beyond the factory call — that's the consumer repo's own plan.

## Open verifications (resolve during implementation, not blockers)

1. Exact `anthropic-ratelimit-unified-*` header names + value shapes (capture from one real response).
2. Whether `src/sandbox/docker.ts` already renders `ExecOptions.env` or silently drops it.
