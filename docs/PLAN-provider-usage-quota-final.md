# Final landing plan — `feat/provider-usage-quota` (#130, on top of #128)

Everything below lands on **this branch** (no new branch). #130 stays stacked on #128.
This doc is the definition of "done" for the branch.

## Scope = three things, in one coherent PR

### 1. Quota routing  — ✅ shipped
`quotaRoutedAgent(opts)` + matrix (`ModelEntry`, `resolveModel`), bucket checks
(`pctBucketCheck`, `zaiMonitorRefresh`, `parseUnifiedRatelimit`, snapshot cache), sticky-on-floor
`QuotaRoutingProvider`. Per-stage `model`/`env`/`secrets`/`effort` overlay. Exported from package root.

### 2. Per-stage tmpfs secrets  — ✅ shipped
`AgentRunInput.secrets` / `ExecOptions.secrets` / `ModelEntry.secrets`, delivered via a per-exec
tmpfs file (stdin-written `umask 077`, sourced before the command, `rm -f` after, cleanup-on-throw).
`env-file` mode + per-exec secrets throws. `execStream` rejects per-exec secrets. Real credentials
(e.g. a subscription OAuth token) ride this channel; argv/`docker inspect` never see them.

### 3. Per-exec env precedence fix  — ⬜ THIS CHANGE
**Bug:** in tmpfs mode the wrapped command runs `set -a; . secrets.env; . stage.env; set +a; <cmd>`
*after* docker has applied `-e` (per-exec `env`). Sourcing **overwrites** any per-exec `env` whose key
collides with a run-level/stage secret. So run-level secrets silently beat per-exec `env` — the
opposite of "most-specific wins", and the root of the consumer clobber (a per-stage
`ANTHROPIC_BASE_URL` override getting reverted to a run-level base).

**Fix:** when secrets are sourced (tmpfs mode, run-level or stage secrets present), emit per-exec
`env` as `export K='v'` statements **after** the source block instead of via `docker exec -e`. Then
per-exec `env` deterministically overrides sourced secrets on key collision. When no secrets are
sourced, behaviour is unchanged (`-e` as today). `env` values are non-secret transport vars and were
already argv-visible via `-e`, so moving them into the `sh -lc` string is the same visibility class —
no secret regression. Applies to both `exec` and `execStream`.

**Precedence after the fix (low → high):**
1. container-start `-e` (`config.env`)
2. run-level sourced `secrets.env`
3. stage sourced `stage.env` (per-exec secrets)
4. **per-exec `env`** (transport overrides — always wins)

Rationale: real per-exec credentials live in `secrets` (3), transport selectors live in `env` (4).
They are disjoint by design; if a consumer ever collides a key between per-exec `env` and per-exec
`secrets`, `env` wins — documented.

## Files

- `src/sandbox/docker.ts` — factor an `envAndWrap(command, options, hasStageSecrets)` helper used by
  both `exec` and `execStream`; `wrap()` gains an `envExports` argument appended after `set +a`.
- `src/sandbox/docker.secrets.test.ts` — add a "per-exec env precedence" describe block (mocked execa).
- `docs/MIGRATION-provider-usage-quota.md` — add the secrets-vs-env table, the precedence ladder, and
  a note: consumers select transport per `ModelEntry` (run-level sandbox `secrets` may be empty; a
  direct-provider stage sets its own base URL in `env` and its credential in `secrets`).

## Explicitly out of scope (documented, not fixed here)

- **Claude usage harvest is sidecar-only.** `parseUnifiedRatelimit` runs inside the `--llm-proxy`
  sidecar. A consumer running a provider **direct** (no sidecar) gets **no** proactive Claude gate —
  the `claude` bucket fails open and relies on the reactive 429 backstop. This is acceptable for a
  terminal fallback; bridging direct-CLI response headers into the snapshot is a future follow-up.

## Acceptance

- `pnpm test` green (adds the precedence tests; existing secrets tests unchanged).
- `pnpm typecheck` clean.
- A per-exec `env` key that collides with a run-level secret resolves to the **per-exec** value
  (asserted via the wrapped-command order + absence of a colliding `-e`).
- No behaviour change when no secrets are sourced.
