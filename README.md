<p align="center">
  <img src="assets/banner.png" alt="Vanguard - Autonomous Software Factory" width="820" />
</p>

<p align="center">
  <a href="https://github.com/SebaBoler/vanguard/actions/workflows/ci.yml"><img src="https://github.com/SebaBoler/vanguard/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-3c873a" alt="Node >=24" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
</p>

<p align="center">
  A self-improving software factory: take a task (Linear / GitHub), run a Claude Code agent in an
  isolated Docker sandbox on its own <code>git worktree</code>, and get back a reviewed, verifiable
  pull request. When the agent fails, you fix the <em>harness</em> — the prompt, the skill, the tool,
  the limit — not the agent's output, so the same failure can't happen twice. A standalone TypeScript
  framework, not a wrapper around another tool.
</p>

Status: Phase 1 (core engine), Phase 2 (task sources, pipeline, evals), and Phase 3 (adversarial review, human-in-the-loop, budget guardrails, dynamic MCP skills) are implemented and tested. Runs autonomously (AFK) as a `watch` loop; deployed always-on on Docker (Synology / Hetzner / any host).

## Design philosophy

Vanguard treats autonomous coding as an engineering system, not a prompt-and-pray script. Five principles separate it from "run an agent in a loop":

- **Harness over code.** Every agent failure is a *harness* failure. Instead of hand-fixing the agent's output, you fix the instruction, skill, tool, or sandbox limit so the system is immune to that failure class next time. Real cases this codebase hardened against: a macOS worktree-path mismatch, a dangling-symlink copy-back crash, and a Synology kernel with no CPU CFS scheduler — each became a permanent fix, not a one-off patch.
- **Trade-off reasoning.** System prompts state the *business cost* of decisions — a wrong or sloppy change costs reviewer trust and rework far more than the seconds a typecheck or test run takes — so the model spends "effort" (adaptive thinking) where it matters and escalates when it should, via the `<tradeoffs>` section of the default system prompt.
- **Token-efficiency by construction.** Sessions are captured to the host and resumed/forked to reuse cached context instead of paying twice for it; `cacheReadInputTokens` and a derived `cacheEfficiency` are first-class on every `RunResult` and tracked per stage. Real runs sit at 97–99% cache, which is what makes always-on AFK economical.
- **Evals-first.** A judge-scored eval suite over control (ambiguous), edge, and refusal/hand-off cases guards against regressions when a model or prompt changes — pass rate and verdict score, not subjective vibes.
- **Verifiable run artifacts.** Every run leaves an auditable trail under `.vanguard/runs/`: a per-stage transcript, a **git bundle of the exact changes**, the diff, and one `run_complete` metric line (cost, tokens, cache efficiency, duration, exit reason). `vanguard stats` rolls it up across the fleet. This is what makes an AFK-generated PR trustworthy. *(On the roadmap: cryptographic SHA-256 attestation of test logs and visual proofs for UI changes; a retrospective memory that learns across runs.)*

## How it works

```
task source ──> prepareContext ──> runStages (agent loop) ──> commit ──> publish PR ──> dispose
 (Linear /         worktree +        Implementer ->            Merger     (GitHub)       cleanup
  GitHub)          sandbox           Reviewer -> Simplifier
```

The agent runs inside the sandbox. The host owns all file sync (`copyIn` / `copyFileOut`) and secrets. A run stops when the agent emits `<promise>COMPLETE</promise>`.

## Layers

- **Sandbox** (`IsolatedSandboxProvider`): `DockerSandboxProvider` for local and Linux hosts, `FirecrackerSandboxProvider` for microVMs on a KVM host. Resource limits, tmpfs secrets, streaming exec.
- **Worktree** (`WorktreeManager`): one git worktree per task. Cleanup keeps a worktree that still has uncommitted changes.
- **Agent** (`AgentProvider`): `ClaudeCodeProvider` runs the in-sandbox `claude` CLI (effort levels, stream-json, usage and cost). `PiProvider` is a Phase 2 stub.
- **Context**: a prompt engine (`{{KEY}}` placeholders and `` !`cmd` `` expansion run in the sandbox), `buildXmlPrompt` for XML-tagged prompts, and `SkillRegistry` for injecting tools.
- **Pipeline**: `runStages` chains stages over one shared worktree and session. Built-in stage sets: Implementer/Reviewer/Simplifier, Generate/Evaluate/Repair, and Plan/Implement/Adversary (a red-team reviewer that reports `<findings>` without editing). `commitStage` and `publishForReview` are the Merger.
- **Guardrails**: `runBudgetedStages` enforces a hard cost ceiling and freezes the run (`budget_exceeded`) for resume after a raise; `runJudgedRepair` freezes to `needs_human` after three rejected repairs, leaving the sandbox live for `shellCommand()` entry.
- **Evals**: `runEvals` scores cases (control, edge, refusal) with a programmatic or LLM judge.

## Quick start

```bash
pnpm install
pnpm build
docker/build.sh                 # builds vanguard-sandbox (node + git + claude + linear CLIs)
```

Run the smoke example against a throwaway repo:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Anthropic/token") pnpm tsx examples/smoke.ts
```

## Task sources (pick one)

`TaskFetcher` abstracts the source, so one deployment uses a single source of truth.

```ts
const fetcher = new LinearCliTaskFetcher({ team: 'ENG' });          // Linear (via the linear CLI)
const fetcher = new GitHubTaskFetcher('owner/repo');                    // GitHub Issues
const fetcher = new GitHubProjectFetcher({ owner, projectNumber, repo });// GitHub Projects v2
```

GitHub is also the review surface: `publishForReview` opens a PR, and `linkPullRequest` / `linkLinearIssue` comment the PR link back onto the source issue.

`LinearCliTaskFetcher` drives Linear entirely through the `linear` CLI (from schpet/linear-cli; authenticate with `linear auth login` or set `LINEAR_API_KEY`), covering fetch/list/comment with no SDK dependency. The CLI's skill (SKILL.md in that repo) can be injected via `skillRegistryFromDirectory` so the agent uses it directly. Confirm the `linear issue query --json` field shape against your workspace before relying on it.

## Auth

Subscription is the default and draws on your Claude plan credits. The API key is the alternative and bills the Developer Platform. Vanguard injects exactly one secret into the sandbox, so billing is unambiguous.

```bash
claude setup-token            # once, generates the subscription token
CLAUDE_CODE_OAUTH_TOKEN=...    # subscription (default)
ANTHROPIC_API_KEY=...          # API billing instead
```

See `.env.example`. `authFromEnv()` prefers the subscription token; `authSecrets(auth)` maps the choice to the single env var the sandbox receives.

### Local secrets (two ways)

Vanguard reads everything from env vars (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN`). Locally, populate them however you like:

**Plain env / `.env`:**

```bash
cp .env.example .env && $EDITOR .env       # fill in the keys (gitignored)
set -a; . ./.env; set +a                    # load into the shell
node dist/cli/index.js watch --label vanguard --repo . --skills ./skills
```

**1Password (`op`), no plaintext on disk** — read each secret inline per run, so it never lands in a file or shell history:

```bash
LINEAR_API_KEY=$(op read "op://Personal/Linear API/credential") \
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
  node dist/cli/index.js run --linear TES-1 --repo . --skills ./skills
```

`op` (1Password CLI) needs `op signin` or the desktop app integration; its sessions can expire between calls, so prefer reading the secrets in the same command that uses them. On a server there is no 1Password — see [docs/deploy.md](docs/deploy.md#secrets-no-1password-on-the-server).

## End to end

```ts
const task = await fetcher.fetch('123');
const ctx = await prepareContext({ taskId: task.id, localRepoPath, sandbox });
try {
  await runStages(ctx, implementReviewSimplifyStages(), { agent, variables: taskToVariables(task) });
  const commit = await commitStage(ctx, { message: `feat: ${task.title}` });
  if (commit.committed) await publishForReview(ctx, { title: task.title });
} finally {
  await disposeContext(ctx);
}
```

`examples/from-github-issue.ts` runs this whole loop from a GitHub issue.

## Skills

Vanguard supports Claude Code skills (the `SKILL.md`-per-directory format used by collections like [obra/superpowers](https://github.com/obra/superpowers), [mattpocock/skills](https://github.com/mattpocock/skills), and [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills)). Point a registry at a directory of skills and Vanguard injects the whole set into the agent's `~/.claude/skills` inside the sandbox. The agent auto-discovers and selects the relevant ones at runtime, so there is no per-run list to maintain.

```ts
import { skillRegistryFromDirectory, run } from 'vanguard';

// Clone a skills collection into ./skills (each subdir with a SKILL.md is one skill).
const skills = await skillRegistryFromDirectory('./skills');
await run(opts, { skills });
```

For targeted injection instead of the whole set, construct `new SkillRegistry({ id: '/host/path' })` and call `inject(['id'], sandbox)`.

### Example: the linear-cli skill

[schpet/linear-cli](https://github.com/schpet/linear-cli) ships a skill at `skills/linear-cli/` that teaches the agent to drive the `linear` CLI directly. The sandbox image already includes the `linear` CLI, so you only inject the skill and forward `LINEAR_API_KEY`:

```bash
git clone --depth 1 https://github.com/schpet/linear-cli /tmp/linear-cli
```
```ts
const skills = await skillRegistryFromDirectory('/tmp/linear-cli/skills'); // registers the linear-cli skill
const sandbox = new DockerSandboxProvider({ secrets: { ...authSecrets(auth), LINEAR_API_KEY: process.env.LINEAR_API_KEY! } });
await run({ ...opts, sandbox }, { skills });
```

The agent then auto-discovers the skill and can read or update Linear from inside the sandbox.

## Models

Choose the model per stage with `model` (`'opus'`, `'sonnet'`, `'haiku'`, or a full id), and reasoning depth with `effort`. Two presets:

- `fastStages()` - a single low-effort `haiku` pass: cheap and quick, still on the subscription via the CLI.
- `planImplementReviewStages()` - plan on `opus` (high effort, emits a `<plan>`), then implement and review on `sonnet`. The capable model plans; the cheaper one executes.

Runs reuse the session and keep a stable prompt prefix to maximize Anthropic prompt caching; `RunResult.cacheEfficiency` reports the cached fraction of input tokens.

## Providers

The agent behind each stage is a swappable `AgentProvider`: `claude` (Claude Code CLI, default), `codex` (OpenAI Codex CLI), or `cursor` (Cursor CLI). Selection is **by provider, not by model** — each provider runs on its own default model. Two modes:

**One provider does everything** (default)

```bash
vanguard run --linear TES-1                 # Claude implements + reviews + simplifies
vanguard run --linear TES-1 --provider codex # Codex runs every stage
```

**Cross-provider review** (opt-in) — the implementer stays on the main provider while only the review stage runs on an independent one, so a different model family catches different classes of bugs:

```bash
vanguard run    --linear TES-1 --provider claude --review-provider codex
vanguard watch  --label vanguard --provider codex --review-provider claude
```

**Per-stage model** (independent of provider) — `--provider-model <m>` sets the model for the implementer/simplifier stages and `--review-model <m>` for the review stage; each defaults to the provider's own default model. Mix freely with provider selection:

```bash
vanguard run --linear TES-1 --provider-model opus --review-model haiku   # plan/implement big, review cheap
```

`--provider` / `--review-provider` / `--provider-model` / `--review-model` work the same on `run` and `watch`. The simplifier stays on the main provider. Each non-Claude provider brings its own key, forwarded into the sandbox **only when that provider is selected**: `CODEX_API_KEY` for codex, `CURSOR_API_KEY` for cursor (a missing key fails fast at dispatch, not mid-run). Claude auth is the baseline (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). The sandbox image ships the `claude` and `codex` CLIs; selecting `cursor` also needs its CLI added to the image (`curl https://cursor.com/install -fsS | bash`).

Codex does not read its key straight from the environment: `CodexProvider` runs `codex login --with-api-key` (the key piped from `OPENAI_API_KEY` inside the sandbox, never on the command line) before `codex exec`. The OpenAI account behind the key must have active billing — without it `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.

## Fork-and-select

`run --fork <n>` runs the implementer stage `n` times (each variant forks the same base, on a worktree reset between runs), scores each variant's diff, and keeps the best one before the review/simplify stages continue. Scoring is an LLM verdict produced by a one-shot run of the same provider in a throwaway `/tmp` cwd (the diff is supplied in the prompt, so the scorer never touches the worktree). Use it to trade tokens for quality on hard tasks:

```bash
vanguard run --linear TES-1 --fork 3
```

## Security

The sandbox is the blast radius, not the host. Secrets reach the sandbox through an in-RAM tmpfs file (POSIX-quoted, never in `docker inspect` or on disk), never via argv. Host subprocesses use argument arrays, never shell strings. `.env` is a template only; no secrets live in the repo. The base image is pinned by digest; SIGINT/SIGTERM destroy live sandboxes and a host concurrency limit caps how many run at once. Generate an image SBOM with `pnpm sbom` (needs syft). `vanguard run --egress` confines the sandbox to an internal docker network whose only route out is a proxy sidecar that tunnels just the allowlist (anthropic/github/linear/registries), so even a process that ignores the proxy has no route out.

### Host LLM proxy

`vanguard run --llm-proxy` (also on `watch`) keeps the real Anthropic credential out of the sandbox entirely. A trusted reverse-proxy sidecar holds the credential; the sandbox is handed only a random **per-run nonce** as `ANTHROPIC_AUTH_TOKEN` and points `ANTHROPIC_BASE_URL` at the sidecar. The sidecar validates the nonce, swaps in the real credential (OAuth `Authorization: Bearer` or `x-api-key`), and is the only thing that talks to `api.anthropic.com`.

The flag **implies `--egress`** and additionally **removes `api.anthropic.com` from the sandbox's allowlist**, so the sandbox has no direct route to Anthropic — its only path to the model is through the sidecar. The invariant: the real key never enters the sandbox; a leaked nonce is useless beyond the run and never reaches Anthropic. v1 covers Claude; Codex/Cursor provider keys are still injected directly (proxying them is planned).

## Development

```bash
pnpm typecheck
pnpm test
```

Node 24+, pnpm, Vitest, ESM with NodeNext. Tests are co-located as `*.test.ts`. Docker integration tests run when Docker is present and skip otherwise.

## Autonomous loop

`vanguard watch --label vanguard` polls a source for ready items and runs each one by itself (claim → run → PR → move to review): `--source linear` (trigger = state type + label) or `--source github` (open issues with the label). Each run implements, then **reviews and simplifies its own diff in a fresh, independent context** using the bundled `skills/` (code-review + simplify) injected into the sandbox. To run it always-on in Docker on Synology / Hetzner / any host, see [docs/deploy.md](docs/deploy.md).

Run `vanguard gc --remote <owner/repo>` on a timer (cron or systemd) to reap stale sandboxes, worktrees, and merged branches — see [Garbage collection](docs/deploy.md#garbage-collection) for cron and systemd-timer examples.

Each run appends a `run_complete` metric line per stage to `.vanguard/runs/metrics.jsonl` (cost, tokens, cache efficiency, duration, exit reason). `vanguard stats` aggregates that into a rollup — per task, per stage, and a grand total — for fleet cost/time visibility (`--json` for machine output).

## Proof of work

After the agent finishes, the host (not the agent) runs a verification command inside the sandbox, captures its stdout and stderr, computes a SHA-256 over the combined output, and stamps a Proof of Work block into the PR body and the run record. The agent cannot fake it.

Command precedence: `--verify "<cmd>"` flag > `VANGUARD_VERIFY_CMD` env > auto-detect from the worktree `package.json` (if a `test` script exists, the host builds `<pm> install --frozen-lockfile [&& <pm> run typecheck] && <pm> test`) > skip (no command resolved means no block, PR body unchanged).

On failure the PR always opens, the body carries a `FAIL` Proof of Work block (command, exit code, SHA-256, and an output tail), and a `vanguard:verify-failed` label is added to the PR (best-effort).

```bash
vanguard run --linear TES-1 --verify "pnpm typecheck && pnpm test"
# or set for all runs:
VANGUARD_VERIFY_CMD="pnpm typecheck && pnpm test" vanguard watch --label vanguard
```
