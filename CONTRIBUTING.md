# Contributing to Vanguard

## Prerequisites

- **Node.js** 24 or later
- **pnpm** (version declared in `package.json` under `packageManager`)
- **Docker** (for building and running the sandbox image)
- **Git** 2.28 or later (the tests use `git init -b`, and `revise-pr` uses `git fetch --end-of-options`, added in 2.24)

## Install and build

```bash
corepack enable  # activate pnpm (one-time)
pnpm install
pnpm build       # compile TypeScript → dist/
```

`pnpm.overrides` in `package.json` forces `@modelcontextprotocol/sdk` (a peer of `@anthropic-ai/claude-agent-sdk`
that pnpm auto-installs; nothing in `src/` imports it) onto a patched release: the vulnerable
`express`/`hono`/`fast-uri`/`ip-address` chain hangs off it, and neither a direct bump nor Dependabot's
grouped updates reach an auto-installed peer. When the agent SDK widens that peer range (e.g. to `^2`),
move the override with it; `pnpm audit` reports the state. `apps/desktop` keeps its own overrides in
`apps/desktop/pnpm-workspace.yaml`, bounded to the advisory's major.

## Sandbox image

Build the sandbox image (Node 24, Git, Claude CLI) with:

```bash
bash docker/build.sh
```

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CLI_VERSION` | `2.1.165` | `@anthropic-ai/claude-code` version to install |
| `TAG` | `vanguard-sandbox:latest` | Docker image tag |

The script builds the image and smoke-tests it (`claude --version`, `git --version`) before returning.

## Typecheck and tests

```bash
pnpm typecheck
pnpm test
```

Both must pass before opening a pull request.

## Workflow

1. Fork the repo (external contributors) or create a branch (collaborators).
2. Branch off `main` with a descriptive name, e.g. `feat/sandbox-timeout` or `fix/pipeline-retry`.
3. Make your changes and ensure `pnpm typecheck` and `pnpm test` pass.
4. Open a pull request against `main`. Describe *what* changed and *why*.
5. Address review comments, then request a re-review once resolved.

Keep pull requests focused — one logical change per PR makes review faster and history cleaner.
