# Migration note — `feat/zai-provider` (#128)

Adds **`--provider zai`** (z.ai GLM Coding Plan). Additive — `claude`/`codex`/`cursor` are unchanged.

## Action required

**Rebuild the sandbox image:** `bash docker/build.sh`. The image now also installs `bun`, and the
build's CLI contract check verifies `claude && git && bun`. Existing claude/codex runs work without
rebuilding, but the `vanguard-sandbox:latest` tag is updated; zai and any bun-based task need it.

## What's new

- **`--provider zai` / `--review-provider zai`** on `run` and `watch`. Set `ZAI_API_KEY`. Default
  model `glm-5.2`; override with `--provider-model`. It reuses the in-sandbox Claude Code CLI pointed
  at z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/coding/paas/v4`) — **no Anthropic
  token needed**. A missing key fails fast at dispatch, not mid-run.
- **`--llm-proxy` covers z.ai**: the real z.ai key is held by the primary sidecar, the sandbox gets
  only the per-run nonce, and `api.z.ai` is dropped from the egress allowlist (same invariant as
  Claude/Codex).
- **Library exports:** `ZaiProvider`, `ZAI_BASE_URL`, `ZAI_DEFAULT_MODEL`, `agentAuthFromEnv`.
- **`PipelineStage.resumeUntilComplete?: number`** (default `0` = off, opt-in per stage). Auto-resumes
  a stage that ends with prose instead of a completion signal — handy for GLM, which sometimes
  narrates-then-stops on large tasks. No effect unless you set it.

## New constraints (rejected at dispatch with a clear message)

- **claude + zai can't split implement/review in one run** — both drive the shared `ANTHROPIC_*`
  transport slot, so they can't coexist. Use one of them, or a non-claude reviewer.
- **zai as review-only under `--llm-proxy`** requires zai as the implementer too (it owns the primary
  sidecar, whose upstream follows `--provider`). The error tells you to use `--provider zai` or drop
  `--llm-proxy`.

## Backwards compatibility

No breaking changes. The `claude`/`codex`/`cursor` paths are byte-identical — the new data-driven
provider/upstream tables are a pure refactor of the prior `if (name === …)` chains. `resumeUntilComplete`
defaults off. No env var or flag was removed or renamed.
