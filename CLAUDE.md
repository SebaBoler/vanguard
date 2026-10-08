# CLAUDE.md

Vanguard is a standalone TypeScript framework — an autonomous software factory. Strict TypeScript, ES modules with explicit `.js` import extensions, Node 24+. Tests are co-located as `*.test.ts` (Vitest).

## Hard constraints

- **Never modify files under `.github/workflows/`.** The CI `GITHUB_TOKEN` cannot push changes to workflow files — GitHub rejects the push without a `workflow`-scoped token, which fails the run and loses all the work. If a task seems to need a workflow change, make the code/doc change instead and describe the needed workflow edit in the PR body for a human to apply by hand.
- Run `pnpm typecheck` and `pnpm test` before signalling completion.

## Style

- Match the surrounding code: comment density, naming, idiom. Keep diffs minimal.
- Explicit return types; prefer `const`; early returns; functional where it fits.

## Review guidance

- The CI-config constraint above (`.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `.gitlab/**.yml` — the paths copy-back drops, see `src/core/vanguard.ts`) is a security boundary, not a token limitation: an agent that can commit a workflow file can run arbitrary code with the repo's secrets on the next event. It binds the autonomous run (implement, revise). A CI-config edit in a PR authored by a repo maintainer (the same logins as the `allowed-actors` gate in the PR-review workflow) is the human path the constraint points to: do not flag it for the rule itself, but review the CI-config content as the highest-risk part of the diff — trigger type (`pull_request_target`), `permissions:`, actor gates, secret exposure, no `${{ }}` interpolation inside `run:`. A CI-config edit by any other author is itself a finding. The `workflow`-scoped token such a maintainer pushes with is personal and local; it is never a CI secret (`VANGUARD_PUSH_TOKEN` must not carry `workflow` scope).
- Do not label a PR `needs revision` when every actionable item is on a CI-config path: the reviser's edits to those paths are dropped by copy-back, so it cannot address that feedback and ends in "no changes — skipping push" without posting anything to the PR. With mixed feedback the reviser fixes the rest and discloses the dropped paths in its summary.
