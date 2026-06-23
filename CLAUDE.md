# CLAUDE.md

Vanguard is a standalone TypeScript framework — an autonomous software factory. Strict TypeScript, ES modules with explicit `.js` import extensions, Node 24+. Tests are co-located as `*.test.ts` (Vitest).

## Hard constraints

- **Never modify files under `.github/workflows/`.** The CI `GITHUB_TOKEN` cannot push changes to workflow files — GitHub rejects the push without a `workflow`-scoped token, which fails the run and loses all the work. If a task seems to need a workflow change, make the code/doc change instead and describe the needed workflow edit in the PR body for a human to apply by hand.
- Run `pnpm typecheck` and `pnpm test` before signalling completion.

## Style

- Match the surrounding code: comment density, naming, idiom. Keep diffs minimal.
- Explicit return types; prefer `const`; early returns; functional where it fits.
