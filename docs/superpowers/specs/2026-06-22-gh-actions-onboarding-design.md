# GitHub Actions onboarding: tiered docs + first-run validation

**Date:** 2026-06-22
**Status:** approved (design), pending spec review

## Problem

The README's GitHub Actions section lists three setups flat (same-repo, another-repo, cross-provider Codex subscription). A new user cannot tell what the minimal working setup is versus the loaded one, so they over- or under-configure. Separately, the first run on a fresh repo fails in ways that are only discovered mid-run: the "Allow Actions to create PRs" repo setting is off (agent does all the work, then `gh pr create` fails), or `CODEX_AUTH_JSON` is empty/malformed (Codex review dies). `vanguard doctor` already preflights auth/labels/docker but checks neither of these.

## Goal

1. Restructure the README GitHub Actions section into three explicit tiers a user reads top-down.
2. Extend `doctor` with two checks that map to the real first-run failures, so preflight stops before any work when the repo is misconfigured.

Non-goal: a separate validation workflow, a Codex token liveness probe, or a one-click setup generator. (Deferred; see "Deferred".)

## Part 1 — README tiers

Replace the flat subsections under `### Implement issues via GitHub Actions` with three leveled ones, each self-contained (a user stops at the tier they need):

- **Minimal** — same repo, Claude only, label `ready for agent`, one secret (`CLAUDE_CODE_OAUTH_TOKEN`), one repo setting. Label an issue, get a PR. This is the existing same-repo content, trimmed to the smallest path.
- **Intermediate** — run on another repo (cross-repo checkout), `ready for spec` double-sweep (with the #143 timing caveat), custom skills.
- **Full** — cross-provider Opus spec / Sonnet impl / Codex review on a ChatGPT subscription (`CODEX_AUTH_JSON`, `--spec-model`/`--provider-model`/`--review-provider`, drop `--llm-proxy`). Existing subscription content.

Add a short **"Validate before your first run"** subsection: `doctor` runs at the start of every `watch` and stops before claiming any issue if a check fails, so a misconfigured repo never does half-work. A `workflow_dispatch` run with no labeled issues is a safe dry run — the `preflight: …` lines show what passed.

## Part 2 — `doctor` checks

Two new checks in `src/cli/preflight.ts`, github-backed runs only:

1. **`pr-create setting`** — read `GET repos/{owner}/{repo}/actions/permissions/workflow` and inspect `can_approve_pull_request_reviews`. `false` → fail with the enable instruction. Unreadable (the in-Action `GITHUB_TOKEN` may lack `administration:read`) → report `unknown` and pass (best-effort; never block on a check we cannot perform). Reuses the existing `gh api` runner pattern.
2. **`codex auth`** — when the implement or review provider is `codex` and `CODEX_AUTH_JSON` is set, parse it and assert it is an object with `auth_mode` and a non-empty `tokens.refresh_token`. Missing/empty/unparseable → fail with "set CODEX_AUTH_JSON to the contents of ~/.codex/auth.json". Shape only, no network. When `CODEX_AUTH_JSON` is unset but an OpenAI key is present, skip (API-key mode is already covered by `provider auth`).

Both follow the existing `check(name, ok, reason?)` shape and join the one-line preflight summary. A failing check returns `ok:false`, which the runner already treats as "stop before claim".

## Data flow

`runPreflight(cmd)` already collects checks into an array and stops the watch loop when any is `false`. The two checks slot into that array: `pr-create setting` alongside the existing `github labels` check (both github-backed, both via `gh api`); `codex auth` alongside `provider auth` (both key/credential checks, gated on the selected providers). No new control flow.

## Error handling

- `pr-create setting`: any non-200 / parse error → `unknown`, pass. Only an explicit `can_approve_pull_request_reviews:false` fails.
- `codex auth`: parse/shape failure → fail with a fix string. Never throws; a thrown error from `JSON.parse` is caught and converted to a failed check.

## Testing

- `preflight.test.ts`: `codex auth` passes on a well-formed `CODEX_AUTH_JSON`, fails on empty/non-JSON/missing-`refresh_token`, and is skipped when codex is not selected or `CODEX_AUTH_JSON` is unset (API-key mode). `pr-create setting` passes on `can_approve_pull_request_reviews:true`, fails on `false`, and passes (`unknown`) when the API call errors — using the injected `run` stub the suite already uses for `gh` calls.
- No README test (prose).

## Deferred (YAGNI)

- Codex token **liveness** probe (network call) — shape check covers the common failures; a dead token fails loudly in-run.
- Separate `vanguard-doctor.yml` for a one-click phone pre-check — the in-run preflight already fail-fasts; add if the dry-run-via-dispatch story proves insufficient.
- One-shot setup generator (secrets + labels + repo setting) — only if manual setup keeps hurting.
