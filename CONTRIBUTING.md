# Contributing to Vanguard

## Prerequisites

- **Node.js** 24 or later
- **pnpm** (version declared in `package.json` under `packageManager`)
- **Docker** (for building and running the sandbox image)

## Install and build

```bash
corepack enable  # activate pnpm (one-time)
pnpm install
pnpm build       # compile TypeScript → dist/
```

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
