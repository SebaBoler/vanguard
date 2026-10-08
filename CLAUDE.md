# CLAUDE.md

Vanguard is a standalone TypeScript framework — an autonomous software factory. Strict TypeScript, ES modules with explicit `.js` import extensions, Node 24+. Tests are co-located as `*.test.ts` (Vitest).

## Hard constraints

- **The factory agent never modifies files under `.github/workflows/`.** The CI `GITHUB_TOKEN` cannot push changes to workflow files — GitHub rejects the push without a `workflow`-scoped token, which fails the run and loses all the work. If a task seems to need a workflow change, make the code/doc change instead and describe the needed workflow edit in the PR body for a human to apply by hand. This binds the autonomous run (implement, revise); a maintainer editing workflows from a local session with a `workflow`-scoped token is the sanctioned path, and reviewers should not flag such a PR for the rule itself. Those PRs must not be labelled `needs revision` (the reviser's push would be rejected).
- Run `pnpm typecheck` and `pnpm test` before signalling completion.

## Style

- Match the surrounding code: comment density, naming, idiom. Keep diffs minimal.
- Explicit return types; prefer `const`; early returns; functional where it fits.
