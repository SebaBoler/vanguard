# GitHub Actions onboarding: tiered docs + first-run validation

**Date:** 2026-06-22
**Status:** approved (design), pending spec review

## Problem

The README's GitHub Actions section lists three setups flat (same-repo, another-repo, cross-provider Codex subscription). A new user cannot tell what the minimal working setup is versus the loaded one, so they over- or under-configure. Separately, the first run on a fresh repo fails in ways that are only discovered mid-run: the "Allow Actions to create PRs" repo setting is off (agent does all the work, then `gh pr create` fails), or `CODEX_AUTH_JSON` is empty/malformed (Codex review dies). `vanguard doctor` already preflights auth/labels/docker but checks neither of these.

## Goal

1. Restructure the README GitHub Actions section into three explicit tiers a user reads top-down.
2. Extend `doctor` with two checks that map to the real first-run failures, so preflight stops before any work when the repo is misconfigured.
3. Ship a one-click `vanguard-doctor.yml` validation workflow, and make new-repo onboarding copy BOTH workflows (implement + doctor).

Non-goal: a Codex token liveness probe or a one-click setup generator. (Deferred; see "Deferred".)

## Part 1 — README tiers

Replace the flat subsections under `### Implement issues via GitHub Actions` with three leveled ones, each self-contained (a user stops at the tier they need):

- **Minimal** — same repo, Claude only, label `ready for agent`, one secret (`CLAUDE_CODE_OAUTH_TOKEN`), one repo setting. Label an issue, get a PR. This is the existing same-repo content, trimmed to the smallest path.
- **Intermediate** — run on another repo (cross-repo checkout), `ready for spec` double-sweep (with the #143 timing caveat), custom skills.
- **Full** — cross-provider Opus spec / Sonnet impl / Codex review on a ChatGPT subscription (`CODEX_AUTH_JSON`, `--spec-model`/`--provider-model`/`--review-provider`, drop `--llm-proxy`). Existing subscription content.

Add a short **"Validate before your first run"** subsection pointing at the doctor workflow (Part 3): click it once on a fresh repo, get red/green before labeling anything. The in-run preflight is the backstop — `doctor` also runs at the start of every `watch` and stops before claiming if a check fails, so a misconfigured repo never does half-work.

Every tier's setup instructions drop in **both** workflow files together (`vanguard-implement.yml` + `vanguard-doctor.yml`); a new repo gets both, and the user runs the doctor workflow once to confirm green, then labels an issue.

## Part 2 — `doctor` checks

Two new checks in `src/cli/preflight.ts`, github-backed runs only:

1. **`pr-create setting`** — read `GET repos/{owner}/{repo}/actions/permissions/workflow` and inspect `can_approve_pull_request_reviews`. `false` → fail with the enable instruction. Unreadable (the in-Action `GITHUB_TOKEN` may lack `administration:read`) → report `unknown` and pass (best-effort; never block on a check we cannot perform). Reuses the existing `gh api` runner pattern.
2. **`codex auth`** — when the implement or review provider is `codex` and `CODEX_AUTH_JSON` is set, parse it and assert it is an object with `auth_mode` and a non-empty `tokens.refresh_token`. Missing/empty/unparseable → fail with "set CODEX_AUTH_JSON to the contents of ~/.codex/auth.json". Shape only, no network. When `CODEX_AUTH_JSON` is unset but an OpenAI key is present, skip (API-key mode is already covered by `provider auth`).

Both follow the existing `check(name, ok, reason?)` shape and join the one-line preflight summary. A failing check returns `ok:false`, which the runner already treats as "stop before claim".

## Part 3 — one-click validation workflow

Ship `.github/workflows/vanguard-doctor.yml` (`on: workflow_dispatch`) with the same setup steps as implement (checkout target + vanguard, pnpm install/build, build sandbox image, ensure labels), then one final step running only `doctor`:

```
node .vanguard-src/dist/cli/index.js doctor --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE" <same provider flags + secrets as implement>
```

It processes no issues. `doctor` prints the `preflight:` lines and exits non-zero when any check fails, so the run goes red/green — clickable from the GitHub mobile app. It carries the same secrets and provider flags as implement so it validates the real configuration; the flags must mirror implement, and the README presents both files together so they are copied and edited as a pair. Ship this file in the Vanguard repo (alongside the existing `vanguard-implement.yml`) and in the README another-repo template.

## Data flow

`runPreflight(cmd)` already collects checks into an array and stops the watch loop when any is `false`. The two checks slot into that array: `pr-create setting` alongside the existing `github labels` check (both github-backed, both via `gh api`); `codex auth` alongside `provider auth` (both key/credential checks, gated on the selected providers). No new control flow.

## Error handling

- `pr-create setting`: any non-200 / parse error → `unknown`, pass. Only an explicit `can_approve_pull_request_reviews:false` fails.
- `codex auth`: parse/shape failure → fail with a fix string. Never throws; a thrown error from `JSON.parse` is caught and converted to a failed check.

## Testing

- `preflight.test.ts`: `codex auth` passes on a well-formed `CODEX_AUTH_JSON`, fails on empty/non-JSON/missing-`refresh_token`, and is skipped when codex is not selected or `CODEX_AUTH_JSON` is unset (API-key mode). `pr-create setting` passes on `can_approve_pull_request_reviews:true`, fails on `false`, and passes (`unknown`) when the API call errors — using the injected `run` stub the suite already uses for `gh` calls.
- `vanguard-doctor.yml` validated with `actionlint`; the `doctor` command path is already covered by `preflight.test.ts`.
- No README test (prose).

## Deferred (YAGNI)

- Codex token **liveness** probe (network call) — shape check covers the common failures; a dead token fails loudly in-run.
- One-shot setup generator (secrets + labels + repo setting) — only if manual setup keeps hurting.
