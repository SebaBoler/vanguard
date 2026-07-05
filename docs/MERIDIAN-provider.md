# Provider note — `meridian`

Adds **`--provider meridian`**. Additive — `claude`/`codex`/`cursor`/`zai`/`openrouter` are unchanged.

Meridian (<https://github.com/rynfar/meridian>) is a self-hosted, Anthropic-Messages-compatible proxy
that bridges to the Claude Code SDK. Run it on one host (e.g. a NAS) that holds the `claude login`
session; every other machine points Vanguard at it and shares the Claude Max subscription **without the
token ever living locally**. Useful when the factory (CLI + Docker sandboxes) must run where the target
files are, but the subscription auth and the outbound Anthropic traffic should originate elsewhere.

## What's new

- **`--provider meridian` / `--review-provider meridian`** on `run` and `watch`. Set
  `MERIDIAN_BASE_URL` to your Meridian address (e.g. `http://192.168.1.10:3456`). The base URL flows
  through the transport as `ANTHROPIC_BASE_URL`; the CLI's required `ANTHROPIC_AUTH_TOKEN` is a
  placeholder — Meridian authenticates on its own host and ignores it. No local Anthropic token needed.
  A missing `MERIDIAN_BASE_URL` fails fast at dispatch, not mid-run.
- Because Meridian relays real Claude via the SDK, **no model is forced**: the CLI default (or
  `--provider-model`) passes straight through. The default plan→implement→review pipeline keeps its
  per-stage models (planner `opus`, implementer/reviewer `sonnet`).
- **Library exports:** `MeridianProvider`, `MERIDIAN_PLACEHOLDER_TOKEN`.

## New constraint (rejected at dispatch with a clear message)

- **`meridian` cannot run under `--llm-proxy`** (`directOnly`): it owns the Anthropic transport but
  exposes no upstream a trusted sidecar could target (it carries only a base URL and authenticates on
  its own host), so `--llm-proxy` would fall the sidecar back to `api.anthropic.com`. Run it in direct
  mode. Under `--egress`, add the Meridian host to the egress allowlist (`src/sandbox/egress-allow.mjs`)
  — it is not a default-allowed domain.

## Setup

On the Meridian host (once):

```bash
npm install -g @rynfar/meridian
claude login
meridian --host 0.0.0.0        # bind 0.0.0.0, not 127.0.0.1, so other machines can reach it
```

The listen port is arbitrary (default `3456`). Use any port, or put Meridian behind a reverse proxy on
`80`/`443` — Vanguard only cares about the value of `MERIDIAN_BASE_URL`.

On the Vanguard host:

```bash
export MERIDIAN_BASE_URL=http://<meridian-host>:3456
vanguard run --provider meridian --repo <path> ...
```

### Split models across providers

The default pipeline already plans with `opus` and implements with `sonnet`. To review with Codex:

```bash
export MERIDIAN_BASE_URL=http://<meridian-host>:3456
export CODEX_AUTH_JSON='<contents of ~/.codex/auth.json>'   # Codex has its own auth (ChatGPT Plus)
vanguard run --provider meridian --review-provider codex --repo <path> ...
```

Do **not** pass `--provider-model` here — it overrides the model on every stage and would flatten the
planner off `opus`. Leave it unset to keep the opus-plan / sonnet-implement default.

## Backwards compatibility

No breaking changes. Every existing provider path is byte-identical — `meridian` is one more entry in
the data-driven `PROVIDERS` table. No env var or flag was removed or renamed.
