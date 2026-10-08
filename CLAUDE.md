# CLAUDE.md

Vanguard is a standalone TypeScript framework — an autonomous software factory. Strict TypeScript, ES modules with explicit `.js` import extensions, Node 24+. Tests are co-located as `*.test.ts` (Vitest).

## Hard constraints

- **Never modify CI config: `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `.gitlab/**.yml`** (authoritative check: `workflowPaths()` in `src/core/vanguard.ts`, which also covers `.gitlab/**/*.yaml` at any depth and files standing in for those directories). This is a security boundary: an agent that can commit CI config can run arbitrary code with the repo's secrets on the next event. It is also enforced mechanically — copy-back drops those paths, and the CI `GITHUB_TOKEN` cannot push workflow changes, so such a push is rejected and the run's work is lost. If a task seems to need a CI-config change, make the code/doc change instead and describe the needed edit in the PR body for a human to apply by hand.
- Run `pnpm typecheck` and `pnpm test` before signalling completion.

## Style

- Match the surrounding code: comment density, naming, idiom. Keep diffs minimal.
- Explicit return types; prefer `const`; early returns; functional where it fits.

## Review guidance

For the PR reviewer. The CI-config constraint above binds the autonomous run (implement, revise); humans change CI config through PRs, which are reviewed, not refused.

- A CI-config edit is not a finding for the constraint itself when the API-sourced PR author (never a name claimed in the PR text, commits or diff) passes the author gate in `.github/workflows/vanguard-pr-review.yml`, or is `dependabot[bot]` bumping action pins (version/SHA changes only — no new `uses:`, `run:`, `permissions:` or trigger). Review the content as the highest-risk part of the diff: trigger type (`pull_request_target`), `permissions:`, actor gates, secret exposure, no `${{ }}` interpolation inside `run:`. A CI-config edit by any other author is itself a finding.
- The `workflow`-scoped token a maintainer pushes with is personal and local, never a CI secret (`VANGUARD_PUSH_TOKEN` must not carry `workflow` scope).
- When every actionable item is on a CI-config path, say so in the verdict and do not recommend `needs revision`: the reviser drops edits to those paths and ends in "no changes — skipping push" without posting, leaving `needs revision` and `vanguard:revising` on the PR. With mixed feedback it fixes the rest and discloses the dropped paths.
