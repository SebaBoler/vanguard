# Migration note — openrouter provider (#224)

Adds **`--provider openrouter`** (OpenRouter's Anthropic-Messages "skin"). Additive — `claude`/`codex`/`cursor`/`zai` are unchanged. Modeled on the `zai` provider (see [MIGRATION-zai-provider.md](./MIGRATION-zai-provider.md)).

## What's new

- **`--provider openrouter` / `--review-provider openrouter`** on `run` and `watch`. Set `OPENROUTER_API_KEY`.
  Default model `anthropic/claude-sonnet-4.6` (a dotted OpenRouter slug); override with `--provider-model`.
  It reuses the in-sandbox Claude Code CLI pointed at OpenRouter's Anthropic-Messages-compatible endpoint
  (`https://openrouter.ai/api`) — **no Anthropic token needed**. A missing key fails fast at dispatch, not
  mid-run.
- **`--llm-proxy` covers OpenRouter**: the real OpenRouter key is held by the primary sidecar, the sandbox
  gets only the per-run nonce, and `openrouter.ai` is dropped from the egress allowlist (same invariant as
  Claude/Codex/z.ai).
- **Library exports:** `OpenRouterProvider`, `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`.

## Recommended: pin Anthropic 1P

OpenRouter recommends setting **"Anthropic 1P"** as the top-priority provider for Claude models, so the
Claude Code CLI gets Anthropic-1P behaviour. This is an OpenRouter **account** setting (provider-selection
preferences), not something this provider can set per-request.

## Cost caveat

The claude CLI's `total_cost_usd` (if present) is computed client-side from Anthropic list prices, not
OpenRouter's actual charge. Use the `$or-est` estimate (`src/core/openrouter-pricing.ts`) for an
OpenRouter-priced figure — its dotted-slug keys derive from each row's own `openRouterModel` field, so
they can't drift.

## New constraints (rejected at dispatch with a clear message)

- **openrouter can't share a run with another Anthropic-transport provider** (`claude`, `zai`) — they all
  drive the shared `ANTHROPIC_*` transport slot, so they can't coexist. Use one of them, or a non-Anthropic
  reviewer.
- **openrouter as review-only under `--llm-proxy`** requires openrouter as the implementer too (it owns the
  primary sidecar, whose upstream follows `--provider`).

## Backwards compatibility

No breaking changes. The existing provider paths are untouched; `openrouter` slots into the same
data-driven provider/upstream tables as `zai`. No env var or flag was removed or renamed.
