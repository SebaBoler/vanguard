# Migration note — `feat/provider-usage-quota` (#130)

Adds per-provider **usage tracking + quota routing**. Purely additive and **opt-in** — nothing changes
unless you call `quotaRoutedAgent(...)` and pass the result as your pipeline agent. Stacked on #128.

## What you get

A provider wrapper that picks each stage's model from an ordered chain, **sticky on floor** (once a
bucket floors it stays floored for the run — "z.ai does the early stages, Claude finishes"), overlaying
that model's transport env per stage. New public exports:

- `quotaRoutedAgent(opts)` → `QuotaRoutingProvider` (an `AgentProvider`)
- building blocks: `QuotaRoutingProvider`, `resolveModel`, `pctBucketCheck`, `readSnapshot`,
  `writeSnapshot`, `zaiMonitorRefresh`, `worstWindow`, `AllBucketsFlooredError`
- types: `QuotaSnapshot`, `BucketId`, `ModelEntry`, `BucketCheck`, `PctCheckOptions`,
  `QuotaRoutedOptions`, `QuotaBucketConfig`, `QuotaRoutingOptions`
- `AgentRunInput.env?` — per-invocation transport overlay (additive; threaded through `runClaudeCli`)
- `AgentRunInput.secrets?` — per-invocation real credentials delivered via tmpfs (not argv); see below
- `ModelEntry.secrets?` — per-stage secrets, overlaid onto `input.secrets` at routing time (entry wins)

## Usage

```ts
import { quotaRoutedAgent, zaiMonitorRefresh, type ModelEntry } from 'vanguard';

const cacheDir = `${process.env.HOME}/.cache/vanguard/quota`;

const models: ModelEntry[] = [
  { key: 'glm-5.2',           bucket: 'zai',    env: ZAI_STAGE_ENV },
  { key: 'claude-sonnet-4-6', bucket: 'claude', effort: 'high', env: CLAUDE_STAGE_ENV },
];

const agent = quotaRoutedAgent({
  models,
  chain: ['glm-5.2', 'claude-sonnet-4-6'],   // ordered priority; resolveModel walks it from the stage's preferred key
  cacheDir,
  buckets: {
    zai:    { bailPct: 97, ttlMs: 60_000,  refresh: zaiMonitorRefresh }, // host-side poll; needs ZAI_API_KEY
    claude: { bailPct: 90, ttlMs: 300_000 },                            // header-fed; see Activation
  },
  debug: console.error, // optional: prints "[quota] zai 84% (resets 42m) · claude 12%" per turn
});

// pass `agent` as your pipeline agent (e.g. runStages({ agent, ... }))
```

`env` maps carry only transport vars (`ANTHROPIC_BASE_URL` + per-run nonce/bearer) — never real upstream
keys (they're rendered as argv-visible `docker exec -e`; real keys stay in tmpfs secrets).

### Per-stage real credentials (`secrets`)

`secrets` delivers actual credentials (e.g. a Claude Max OAuth token) that must never appear in `docker
inspect` or process argv. The threading path is:

```text
ModelEntry.secrets → QuotaRoutingProvider.run() overlay → AgentRunInput.secrets
  → runClaudeCli → sandbox.exec({ secrets }) → DockerSandboxProvider.exec()
    1. writes /run/vanguard/stage.env via stdin (umask 077; never in argv)
    2. wrap() sources it: [ -f /run/vanguard/stage.env ] && . /run/vanguard/stage.env
    3. finally: rm -f /run/vanguard/stage.env (runs even on throw)
```

Key constraints:

- **`secretsMode: 'tmpfs'` required.** Passing `secrets` to `exec()` when the provider was constructed
  with `secretsMode: 'env-file'` throws `SandboxError` immediately — env-file mode would land secrets
  in `docker inspect Config.Env`.
- **Sequential execs only.** `/run/vanguard/stage.env` is a single path per container. Stages run
  sequentially per sandbox (fan-out uses separate sandboxes), so this is safe by construction.
- **Firecracker parity.** `FirecrackerSandboxProvider.exec()` throws `NotImplementedError` for all
  calls — per-exec secrets can never silently leak through it.
- **`env` vs `secrets`.** Use `env` for transport-only vars (ANTHROPIC_BASE_URL, nonce) that can
  tolerate argv visibility. Use `secrets` for real credentials that must stay out of process args,
  docker inspect, and disk entirely.

## What works today vs. needs wiring

- **z.ai routing/gating: works now.** `zaiMonitorRefresh` polls z.ai's monitor endpoint host-side
  (needs `ZAI_API_KEY` in the host env). The `zai` bucket gates on it immediately.
- **Claude quota harvest: dormant until you bridge the snapshot out of the sidecar.** The sidecar
  scours `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}` off successful `/v1/messages`
  responses and writes a snapshot — but only when `LLM_PROXY_QUOTA_FILE` is set, and that file is
  written **inside the sidecar container**. `pctBucketCheck` reads `<cacheDir>/claude.json` on the
  **host**. To connect them you must:
  1. launch the sidecar with `LLM_PROXY_QUOTA_FILE=<path>` set, and
  2. make that path land in the host `cacheDir` (bind-mount the dir into the container, or copy the
     file out) — `startLlmProxy` does **not** do this yet.

  Until wired, the `claude` bucket has no snapshot → **fails safe**: warns once, treated as available,
  so routing still works and Claude relies on the reactive 429 backstop (no proactive gate).

## Semantics worth knowing

- **Per-stage env wins over run-level secrets.** Precedence for a colliding var, low → high:
  (1) container-start `-e` (`SandboxConfig.env`), (2) run-level sourced `secrets.env`
  (`SandboxConfig.secrets`), (3) per-exec stage secrets (`ModelEntry.secrets`), (4) **per-exec `env`**
  (`ModelEntry.env`). In tmpfs mode per-exec `env` is `export`ed *after* the secret source block, so a
  per-stage `ANTHROPIC_BASE_URL` reliably overrides a run-level base instead of being clobbered by it.
  Keep per-exec `env` and per-exec `secrets` keys disjoint (transport vs credential); on a collision,
  `env` wins. Consequence: a consumer's run-level sandbox `secrets` may be empty and each stage selects
  its own transport — a proxy stage and a direct-provider stage coexist in one run without clobbering.
- **Fail-open gate:** a refresh error, missing/corrupt snapshot, or unparseable headers never read as
  "floored" — the bucket stays available. A floored gate only comes from a *fresh* snapshot at/over
  `bailPct`.
- **Sticky is per provider instance, per run lifetime** — a recovered bucket does not un-floor mid-run.
- **Subscription headers only:** the unified headers ride only *successful* `/v1/messages` responses
  (429s and `count_tokens` carry none). They're a Claude-Max/subscription feature — the public API
  rate-limits doc lists per-bucket headers instead, which this does not use.

## Backwards compatibility

No breaking changes. All new surface is opt-in; existing runners are untouched. `AgentRunInput.env` is
optional. `cacheDir` files are per-bucket JSON (`zai.json`, `claude.json`) — no lock, single writer each.
