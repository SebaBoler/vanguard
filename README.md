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

## Contents

- [Design philosophy](#design-philosophy)
- [How it works](#how-it-works)
- [Layers](#layers)
- [Quick start](#quick-start)
- [Task sources](#task-sources-pick-one)
- [Auth](#auth) · [Local secrets](#local-secrets-two-ways)
- [End to end](#end-to-end)
- [Skills](#skills) · [Custom skills (bring your own)](#custom-skills-bring-your-own)
- [Models](#models)
- [Providers](#providers) — Claude / Codex / Cursor / z.ai, cross-provider, Codex subscription, custom endpoint
- [Fork-and-select](#fork-and-select)
- [Security](#security) · [Host LLM proxy](#host-llm-proxy)
- [Development](#development)
- [Autonomous loop](#autonomous-loop) · [Loop v1 (two-pass)](#loop-v1--two-pass-autonomous-pipeline) · [External PR review](#external-pr-review) · [Implement issues via GitHub Actions](#implement-issues-via-github-actions)
- [Cost & limits](#cost--limits)
- [Retrospective memory](#retrospective-memory)
- [Proof of work](#proof-of-work)
- [Visual proof](#visual-proof)

New repo onboarding: [GitHub Actions](docs/onboarding-another-repo.md) · [Linear](docs/onboarding-linear.md) · [always-on host (Synology / Hetzner)](docs/deploy.md)

## Design philosophy

Vanguard treats autonomous coding as an engineering system, not a prompt-and-pray script. Five principles separate it from "run an agent in a loop":

- **Harness over code.** Every agent failure is a *harness* failure. Instead of hand-fixing the agent's output, you fix the instruction, skill, tool, or sandbox limit so the system is immune to that failure class next time. Real cases this codebase hardened against: a macOS worktree-path mismatch, a dangling-symlink copy-back crash, and a Synology kernel with no CPU CFS scheduler — each became a permanent fix, not a one-off patch.
- **Trade-off reasoning.** System prompts state the *business cost* of decisions — a wrong or sloppy change costs reviewer trust and rework far more than the seconds a typecheck or test run takes — so the model spends "effort" (adaptive thinking) where it matters and escalates when it should, via the `<tradeoffs>` section of the default system prompt.
- **Token-efficiency by construction.** Sessions are captured to the host and resumed/forked to reuse cached context instead of paying twice for it; `cacheReadInputTokens` and a derived `cacheEfficiency` are first-class on every `RunResult` and tracked per stage. Real runs sit at 97–99% cache, which is what makes always-on AFK economical.
- **Evals-first.** A judge-scored eval suite over control (ambiguous), edge, and refusal/hand-off cases guards against regressions when a model or prompt changes — pass rate and verdict score, not subjective vibes.
- **Verifiable run artifacts.** Every run leaves an auditable trail under `.vanguard/runs/`: a per-stage transcript, a **git bundle of the exact changes**, the diff, one `run_complete` metric line (cost, tokens, cache efficiency, duration, exit reason), and optional host-driven Proof of Work with a SHA-256 over verification output. `vanguard stats` rolls it up across the fleet. This is what makes an AFK-generated PR trustworthy. The run also carries an optional host-driven Visual Proof for UI artifacts (see Visual proof below). *(Retrospective memory is also implemented: a deterministic host-side digest of prior failures and reviewer notes, fed back into later runs as advisory context.)*

## How it works

```
task source ──> [Spec loop] ──> [Agent loop] ──> commit ──> publish PR ──> dispose
 (Linear /      Planner          Implementer        Merger    (GitHub)       cleanup
  GitHub)       (read-only,      -> Reviewer
                posts spec,      -> Simplifier
                advances state)
```

**Loop v1 adds a layered two-pass flow before each implementation run:**

1. **Spec pass (Planner)** — Polls the spec-trigger (label or state). Runs triage: rejects vague tickets to needs-info before spending any model budget. If the ticket passes, runs `techSpecStage` (read-only: no code is written), posts the result as a `<tech_spec>` comment, then advances the ticket to the agent-trigger. A freshly-specced ticket is implemented on the **next poll** — the human has a window to review the spec before the agent runs.
2. **Agent pass (Implementer → Reviewer → Simplifier)** — Polls the agent-trigger. Runs triage again in `agent` mode: rejects tickets that lack acceptance criteria or a spec comment before spending implement budget. If the ticket passes, runs the full stage pipeline and opens a draft PR.

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

Subscription is the default and draws on your Claude plan's usage allowance (no per-token charge — the same pool as interactive Claude Code). The API key is the alternative and bills the Developer Platform per token. Vanguard injects exactly one secret into the sandbox, so billing is unambiguous.

Vanguard runs Claude headless via `claude -p` (`claude --print --output-format stream-json`, see `src/agents/claude-code.ts`). Billing is decided purely by which auth env var is set, not by the CLI mode — `claude -p` consumes the same plan usage as the interactive CLI.

```bash
claude setup-token            # once, generates the subscription token
CLAUDE_CODE_OAUTH_TOKEN=...    # subscription (default)
ANTHROPIC_API_KEY=...          # API billing instead
```

See `.env.example`. `authFromEnv()` prefers the subscription token; `authSecrets(auth)` maps the choice to the single env var the sandbox receives.

**Two modes, no third.** Subscription (`CLAUDE_CODE_OAUTH_TOKEN`) draws on your plan's usage; API key (`ANTHROPIC_API_KEY`) bills per token on platform.claude.com. There is no separate credit pool for `claude -p` / Agent SDK usage — Anthropic announced one for 2026-06-15 but postponed it (the 2026-05 announcement was reversed), so headless runs keep consuming normal plan usage exactly like interactive Claude Code.

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

The repo bundles five skills in `skills/`: `code-review` and `simplify` (used by the loop's review pass), `tech-spec` (specs for under-specified tasks), `caveman` (cut tokens on long runs), and `ponytail` (avoid over-engineering: climb the laziness ladder, stop at the first rung that works).

### Custom skills (bring your own)

A skill is a directory with a `SKILL.md` (frontmatter `name` + `description`, then the body), the standard Claude Code format. `--skills <dir>` injects every subdirectory in that dir, and the agent picks the right one per task by matching each skill's `description`. A Docker task pulls in `docker-expert`, a UI task `frontend-design`, and `ponytail` fires on everything. You curate the set, the model chooses per task. There is no per-issue flag.

Keep your domain skills in the target repo under `.github/vanguard-skills/`:

```
.github/vanguard-skills/
  docker-expert/SKILL.md
  frontend-design/SKILL.md
  python-expert/SKILL.md
```

Copy them into the bundled set before the run so the agent keeps `ponytail`/`code-review`/`simplify` and gains yours. Add one step to the workflow above:

```yaml
      - name: Add custom skills
        run: cp -r .github/vanguard-skills/* .vanguard-src/skills/
```

The run step already passes `--skills .vanguard-src/skills`, so it now injects both. Pointing `--skills` straight at `.github/vanguard-skills` would drop the bundled skills the loop needs, so merge, do not replace.

Skills are injected per-provider in the format each CLI auto-discovers:

| Provider | Target | Format |
|---|---|---|
| `claude-code`, `zai` | `~/.claude/skills/<id>/` | Full skill directory (current behaviour) |
| `codex` | `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | Pointer index: name + description + path to `.vanguard/skills/<id>/SKILL.md` |
| `cursor` | `.cursor/rules/<id>.mdc` | One `.mdc` per skill with `description`/`globs` frontmatter + pointer |

Codex receives only a pointer index (not the full skill bodies) in its always-on `AGENTS.md` to avoid inflating every turn with N full skill texts; the model reads the body from `.vanguard/skills/<id>/SKILL.md` when the description matches the task. Cursor rules use `alwaysApply: false` so they are description-attached, not always-on, for the same reason. Neither `.cursor/rules/` nor `.vanguard/skills/` is copied back into the PR diff.

**Cross-provider limitation:** when `--provider` and `--review-provider` differ (e.g. `--provider claude --review-provider codex`), skills are injected for the implementer's family only. The Codex reviewer runs without the skill index in that configuration. Inject for both families is a planned extension.

Two checks before a skill goes in. It must be self-contained: `SKILL.md` plus plain text, no MCP or browser, since the sandbox has neither. It must allow model invocation: skip any with `disable-model-invocation: true`, because the agent never triggers those itself. Only the `description`s load up front, so curate about a dozen, not a whole collection.

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

The canonical pipeline is implement → review → simplify. The reviewer reviews for correctness **and** over-engineering (the ponytail minimalism lens — would less code do the job?), so the third simplify pass is often redundant. Pass `--no-simplify` (on `run`/`watch`) for a lean implement → review run that skips it.

## Providers

The agent behind each stage is a swappable `AgentProvider`: `claude` (Claude Code CLI, default), `codex` (OpenAI Codex CLI), `cursor` (Cursor CLI), or `zai` (z.ai GLM Coding Plan). Selection is **by provider, not by model** — each provider runs on its own default model. Two modes:

**One provider does everything** (default)

```bash
vanguard run --linear TES-1                 # Claude implements + reviews + simplifies
vanguard run --linear TES-1 --provider codex # Codex runs every stage
vanguard run --linear TES-1 --provider zai   # z.ai GLM runs every stage (ZAI_API_KEY)
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

`--provider` / `--review-provider` / `--provider-model` / `--review-model` work the same on `run` and `watch`. The simplifier stays on the main provider. Each non-Claude provider brings its own key, forwarded into the sandbox **only when that provider is selected**: `CODEX_API_KEY` for codex, `CURSOR_API_KEY` for cursor, `ZAI_API_KEY` for zai (a missing key fails fast at dispatch, not mid-run). Under `--llm-proxy` the Codex/OpenAI key **and** the z.ai key are held by a trusted sidecar instead of the sandbox (see [Host LLM proxy](#host-llm-proxy) below); Cursor's key is still injected directly (not yet proxied). Claude auth is the baseline (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). The sandbox image ships the `claude` and `codex` CLIs; selecting `cursor` also needs its CLI added to the image (`curl https://cursor.com/install -fsS | bash`).

Codex does not read its key straight from the environment: `CodexProvider` runs `codex login --with-api-key` (the key piped from `OPENAI_API_KEY` inside the sandbox, never on the command line) before `codex exec`. Under `--llm-proxy` Codex is instead configured (via `~/.codex/config.toml`) to use a custom OpenAI-compatible provider pointed at the trusted sidecar, reading only the per-run nonce from `OPENAI_API_KEY` (no `codex login`, and the real key never enters the sandbox). Either way, the OpenAI account behind the key must have active billing — without it `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.

**Codex on a ChatGPT subscription (no API key).** Set `CODEX_AUTH_JSON` to the contents of a `~/.codex/auth.json` produced by `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`, OAuth tokens, no API key). The runner forwards it verbatim into the sandbox, where `CodexProvider` writes it to `~/.codex/auth.json` (0600) and skips login — `codex exec` then runs on the subscription and self-refreshes the access token via the embedded refresh token. This works like Claude's `CLAUDE_CODE_OAUTH_TOKEN`: the credential lives in the sandbox, so `--llm-proxy` does not apply to it (and `CODEX_AUTH_JSON` takes precedence over `CODEX_API_KEY`/`OPENAI_API_KEY` when both are set). Solid for local and long-running (Synology) use; on ephemeral CI the stored token must carry a valid refresh token, and an API key is the sturdier choice there. Example: `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)" vanguard run --linear TES-1 --provider codex`.

**Custom OpenAI-compatible endpoint.** To run Codex against any endpoint that speaks the OpenAI **Responses** API (a self-hosted vLLM, OpenRouter, Together, a gateway, …) instead of `api.openai.com`, set `OPENAI_BASE_URL` on the host. The runner forwards it into the sandbox as `VANGUARD_OPENAI_BASE_URL`, and `CodexProvider` writes a `~/.codex/config.toml` provider pointed at it (`wire_api = "responses"`), sending your key from `OPENAI_API_KEY`/`CODEX_API_KEY` as the bearer token:

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1   # must include the /v1 path (OpenRouter's Responses API is in beta)
export OPENAI_API_KEY=sk-...                           # the key your endpoint expects
vanguard run --linear TES-1 --provider codex --provider-model <model-the-endpoint-serves>
```

Constraints: (1) the endpoint must implement the OpenAI **Responses** API (`/v1/responses`) — Codex no longer speaks `/chat/completions`; (2) this is **direct mode only** — it is ignored under `--llm-proxy`, whose sidecar always targets `api.openai.com` (point the sidecar elsewhere by changing the proxy upstream, not this var); (3) with `--egress` the endpoint's host must be in the allowlist, otherwise run without `--egress` so the sandbox can reach it directly. `CODEX_AUTH_JSON` (subscription) takes precedence — set `OPENAI_BASE_URL` only in the API-key path.

**z.ai (GLM Coding Plan).** `--provider zai` reuses the in-sandbox Claude Code CLI, pointed at z.ai's Anthropic-Messages-compatible coding endpoint (`https://api.z.ai/api/coding/paas/v4`) with the GLM model family (default `glm-5.2`). It needs **no Anthropic token** — set `ZAI_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the z.ai key is held by the primary trusted sidecar (forwarding to `api.z.ai` as a bearer key) and the sandbox gets only the per-run nonce. (z.ai's endpoint is OpenAI-compatible too, but the Codex CLI dropped `wire_api = "chat"` support, so the Claude-CLI route is the supported one.)

## Fork-and-select

`run --fork <n>` runs the implementer stage `n` times (each variant forks the same base, on a worktree reset between runs), scores each variant's diff, and keeps the best one before the review/simplify stages continue. Scoring is an LLM verdict produced by a one-shot run of the same provider in a throwaway `/tmp` cwd (the diff is supplied in the prompt, so the scorer never touches the worktree). Use it to trade tokens for quality on hard tasks:

```bash
vanguard run --linear TES-1 --fork 3
```

## Security

The sandbox is the blast radius, not the host. Secrets reach the sandbox through an in-RAM tmpfs file (POSIX-quoted, never in `docker inspect` or on disk), never via argv. Host subprocesses use argument arrays, never shell strings. `.env` is a template only; no secrets live in the repo. The base image is pinned by digest; SIGINT/SIGTERM destroy live sandboxes and a host concurrency limit caps how many run at once. Generate an image SBOM with `pnpm sbom` (needs syft). `vanguard run --egress` confines the sandbox to an internal docker network whose only route out is a proxy sidecar that tunnels just the allowlist (anthropic/github/linear/registries), so even a process that ignores the proxy has no route out.

### Host LLM proxy

`vanguard run --llm-proxy` (also on `watch`) keeps the real Anthropic credential out of the sandbox entirely. A trusted reverse-proxy sidecar holds the credential; the sandbox is handed only a random **per-run nonce** as `ANTHROPIC_AUTH_TOKEN` and points `ANTHROPIC_BASE_URL` at the sidecar. The sidecar validates the nonce, swaps in the real credential (OAuth `Authorization: Bearer` or `x-api-key`), and is the only thing that talks to `api.anthropic.com`.

Just add the flag; the key lives in the host env (never the sandbox) and Docker must be running:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...                       # host key, stays in the sidecar
vanguard run --linear TES-1 --llm-proxy                  # Claude credential held by the sidecar
vanguard watch --label vanguard --llm-proxy              # same, for the watch loop

export ZAI_API_KEY=...                                   # z.ai key, also stays in the sidecar
vanguard run --linear TES-1 --provider zai --llm-proxy   # z.ai credential held by the sidecar
```

The same nonce/sidecar pattern now also covers Codex/OpenAI when Codex is selected with `--llm-proxy`: a separate OpenAI sidecar holds the real OpenAI key, the sandbox gets a nonce as `OPENAI_API_KEY` plus a base URL pointed at that sidecar, and `api.openai.com` is dropped from the sandbox allowlist alongside `api.anthropic.com`. With `--provider zai`, the primary sidecar instead forwards to `api.z.ai` (the z.ai key as a bearer key), `api.z.ai` is dropped from the allowlist, and the sandbox gets the same `ANTHROPIC_BASE_URL`/nonce shape — so the same nonce/sidecar invariant covers z.ai too.

The flag **implies `--egress`** and additionally **removes `api.anthropic.com` from the sandbox's allowlist**, so the sandbox has no direct route to Anthropic — its only path to the model is through the sidecar. The invariant: the real key never enters the sandbox; a leaked nonce is useless beyond the run and never reaches Anthropic. `--llm-proxy` now protects the Claude, Codex/OpenAI, and z.ai provider keys. Cursor is not yet proxied — selecting `cursor` with `--llm-proxy` still injects `CURSOR_API_KEY` directly into the sandbox (a stable Cursor base-url proxy is planned).

See [docs/smoke-tests/codex-openai-proxy.md](docs/smoke-tests/codex-openai-proxy.md) for the current verification status, a zero-cost negative preflight check, and a controlled live runbook that walks through the Codex/OpenAI proxy preflight and a read-only `review-pr` smoke run when active OpenAI billing is available.

## Development

```bash
pnpm typecheck
pnpm test
```

Node 24+, pnpm, Vitest, ESM with NodeNext. Tests are co-located as `*.test.ts`. Docker integration tests run when Docker is present and skip otherwise.

## Autonomous loop

`vanguard watch` polls a source for ready items and runs each one by itself (claim → run → PR → move to review): `--source linear` (trigger = state type + label) or `--source github` (open issues with labels). Each run implements, then **reviews and simplifies its own diff in a fresh, independent context** using the bundled `skills/` (code-review + simplify) injected into the sandbox. Loop v1.1 adds safe defaults so GitHub can be started with `vanguard watch --source github --github-repo owner/repo`, and Linear with `vanguard watch --loop-v1 --label vanguard`. To run it always-on in Docker on Synology / Hetzner / any host, see [docs/deploy.md](docs/deploy.md).

### Loop v1 — two-pass autonomous pipeline

Loop v1 adds a deterministic Spec pass before every Agent pass. Routing differs by source:

**GitHub (routes by LABELS):**

`--label` (e.g. `vanguard`) is an optional **ownership** label for GitHub: when supplied, an issue is only picked up if it carries it *in addition to* the routing label below. The short GitHub command does not require it because the repo plus `ready for spec` / `ready for agent` already define the loop lane.

| Routing label | What happens |
|---|---|
| `ready for spec` | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + relabelled `needs info` (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue relabelled `ready for agent`. If `--label` is supplied, the issue must also carry that ownership label. |
| `ready for agent` | Agent pass triggers (next poll after spec, or immediately for directly-labelled issues). Triage runs again — no spec or acceptance criteria → `needs info`. Valid tickets: full Implementer → Reviewer → Simplifier pipeline → draft PR. If `--label` is supplied, the issue must also carry that ownership label. |
| `needs info` | Parked. Human updates the ticket and moves it back. |

> **Note on the issue template:** The [Vanguard Task template](.github/ISSUE_TEMPLATE/vanguard-task.md) defaults to `ready for agent` only. The spec loop runs when a human downgrades the label to `ready for spec` (for high-level ideas that need a research + planning pass first). Leaving the label as `ready for agent` skips the spec pass and goes straight to implementation — this is intentional, not a bug. Add an ownership label such as `vanguard` only when your watcher is started with `--label vanguard`.

```bash
# GitHub Loop v1.1 defaults
vanguard doctor --source github --github-repo owner/repo
vanguard watch --source github --github-repo owner/repo

# GitHub Loop v1 with custom labels/model
vanguard doctor --source github --github-repo owner/repo --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info"
vanguard watch --source github --github-repo owner/repo \
  --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info" \
  --spec-model haiku
```

**Linear (routes by STATES):**

| State condition | What happens |
|---|---|
| State TYPE matches `--spec-state` (e.g. `triage`) + label | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + moved to Needs Info state (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue moved to the agent-trigger state (`--agent-state`, default `Todo`). |
| State TYPE matches `--trigger-state` (default `unstarted`) + label | Agent pass triggers (next poll after spec, or for any pre-specced issue). Triage runs in `agent` mode — vague tickets moved to `--needs-info-state`. Valid tickets: Implementer → Reviewer → Simplifier → draft PR. |
| Needs Info state | Parked. Human updates the ticket and moves it back. |

The two-flag split is Linear-specific: `--agent-state` sets the **state name** the spec pass moves the ticket to (`Todo`), while `--trigger-state` matches the **state type** the agent pass fires on (`unstarted`). The default `Todo` is of type `unstarted`, so they line up out of the box and `--trigger-state` rarely needs setting (hence its absence from the example below) — unlike GitHub, where a single `--agent-label` is both the move target and the trigger.

```bash
# Linear Loop v1.1 defaults
vanguard doctor --loop-v1 --label vanguard
vanguard watch --loop-v1 --label vanguard

# Linear Loop v1 with custom states/model
vanguard doctor --loop-v1 --label vanguard --spec-state triage --spec-state-name Spec \
  --needs-info-state "Needs Info" --agent-state Todo
vanguard watch --loop-v1 --label vanguard \
  --spec-state triage \
  --spec-state-name Spec \
  --needs-info-state "Needs Info" \
  --agent-state Todo \
  --spec-model haiku
```

**Shared behaviour (both sources):**

- `vanguard doctor` runs the AFK preflight without claiming work. It checks Node 24+, LLM auth, repo remote, Docker daemon, `vanguard-sandbox:latest`, source auth, GitHub routing labels, and Linear env/skills setup. On a GitHub repo it also verifies the "Allow GitHub Actions to create and approve pull requests" setting (best-effort — skipped if the token cannot read it) and, when Codex is selected with a `CODEX_AUTH_JSON` subscription credential, validates its shape before the run.
- Triage is deterministic (`assessTaskReadiness`) and rejects under-specified tickets before spending any model tokens.
- The spec stage is read-only: it posts a `<tech_spec>` comment but never writes code or opens a PR.
- In continuous mode, a freshly-specced ticket is implemented on the **next poll** (human intervention window). In `--once` mode spec and build complete in the same invocation.
- The human role is to write good tickets + approve the final PR. The [issue template](.github/ISSUE_TEMPLATE/vanguard-task.md) is the intended intake path.
- External PR review is available as a one-shot `review-pr` command, an always-on `watch-prs` polling loop, or a GitHub Actions label trigger.

Operator logs stay terse and progress-oriented so always-on runs are scannable:

```text
preflight: node 24 ok
preflight: llm auth ok
preflight: github labels ok
spec: poll -> 1 ready
spec owner/repo#123: claim -> triage
spec owner/repo#123: advanced -> next poll agent
watch: poll -> 1 ready
watch owner/repo#124: claim -> running
watch owner/repo#124: pr opened -> review
```

Normal logs report source, task id, phase, outcome, and next action. Full prompts, diffs, transcripts, and proof details stay in `.vanguard/runs/`.

### External PR review

`vanguard review-pr` runs an adversarial, read-only review over an existing GitHub PR diff and posts a non-blocking GitHub review comment. It does not edit code, open another PR, or move issue labels.

```bash
vanguard review-pr https://github.com/owner/repo/pull/123
vanguard review-pr --github-pr 123 --github-repo owner/repo --provider codex --review-model gpt-5
```

`vanguard watch-prs` turns that reviewer into a small PR loop. It polls only PRs with an explicit trigger label, skips drafts and Vanguard/bot-authored PRs, swaps labels while reviewing, and restores the trigger label on failure so the next poll can retry; if the restore itself fails you will see a `restore failed -> manual label check` log line and should verify the PR labels by hand before the next poll. Pass `--author <login>` to restrict the loop to a single author's PRs (self-review-only). Successful reviews include a hidden `headRefOid` marker, so the loop skips the same commit if the trigger label is re-added accidentally.

```bash
vanguard doctor-prs --github-repo owner/repo --label "ready for vanguard review"
vanguard watch-prs --github-repo owner/repo --label "ready for vanguard review"
vanguard doctor-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed"
vanguard watch-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed" \
  --author owner \
  --provider codex \
  --review-model gpt-5
```

| PR label state | What happens |
|---|---|
| `ready for vanguard review` | Picked up on the next poll. The label is removed and `vanguard:reviewing` is added before the review starts. |
| `vanguard:reviewing` | Claimed/in progress. Later polls skip it. |
| `vanguard:reviewed` | Review comment posted successfully. Re-add the trigger label after new commits if you want another review pass; the same commit is deduped by the hidden review marker. |

Operator logs stay compact:

```text
review-pr owner/repo#123: fetch -> diff
review-pr owner/repo#123: agent -> reviewing
review-pr owner/repo#123: posted -> pr review
review-pr owner/repo#123: done
watch-prs: poll -> 1 ready
watch-prs owner/repo#123: claim -> reviewing
watch-prs owner/repo#123: reviewed -> marked
```

#### GitHub Actions trigger

`.github/workflows/vanguard-pr-review.yml` fires on `pull_request_target` when the `ready for vanguard review` label is applied to a PR, and can also be triggered manually via `workflow_dispatch` to sweep all currently-labeled PRs.

**Required secrets:** `CLAUDE_CODE_OAUTH_TOKEN` — the Claude subscription OAuth token. The built-in `GITHUB_TOKEN` provides PR/label write access automatically.

**Security model:** the workflow uses `pull_request_target` because posting reviews requires repo secrets and write permissions. It checks out only the base branch — PR head code is never fetched or executed. The model credential stays inside the `--llm-proxy` sidecar, which also restricts sandbox egress to an allowlist, so the untrusted PR diff cannot exfiltrate the model credential. It is **self-review-only**: the job condition requires `github.event.pull_request.user.login == 'SebaBoler'` and the review pass runs with `--author SebaBoler`, so only the maintainer's own PRs are ever reviewed — another contributor's PR is skipped even if labeled.

**Behavior:** each label event runs `watch-prs --once --author SebaBoler`, which reviews only the maintainer's PRs carrying the trigger label (not another contributor's, and not only the just-labeled one). This is idempotent: already-reviewed commits are skipped via the hidden `headRefOid` marker and the label swap.

**Re-review:** after new commits land, remove and re-add `ready for vanguard review` to trigger a fresh pass.

**Label setup:** the workflow creates the three routing labels idempotently on every run (`gh label create --force`), so no manual label setup is needed in a fresh repo.

**Relationship to always-on `watch-prs`:** both modes watch the same label; dedupe makes running both safe but redundant — pick one per repo.

Run `vanguard gc --remote <owner/repo>` on a timer (cron or systemd) to reap stale sandboxes, worktrees, and merged branches — see [Garbage collection](docs/deploy.md#garbage-collection) for cron and systemd-timer examples.

Each run appends a `run_complete` metric line per stage to `.vanguard/runs/metrics.jsonl` (cost, tokens, cache efficiency, duration, exit reason). `vanguard stats` aggregates that into a rollup — per task, per stage, and a grand total — for fleet cost/time visibility (`--json` for machine output).

### Implement issues via GitHub Actions

Run Loop v1 straight from GitHub Actions — no always-on host. Label an issue and the workflow runs the pipeline in a sandbox, with the routing labels moving live:

- **`ready for spec`** — a rough idea: Vanguard writes a tech spec, advances the ticket to `ready for agent`, **then builds it** and opens a PR — all in one job.
- **`ready for agent`** — a written, ready ticket: Vanguard builds it directly.
- **too vague** — triage parks it at `needs info` (no budget spent); you fill it in and re-label.

Three tiers, each building on the last — for the full copy-paste setup (both workflow files, the one-click doctor validator, secrets, and the triage contract) see **[docs/onboarding-another-repo.md](docs/onboarding-another-repo.md)**:

- **Minimal** — same repo (this section), Claude only, label `ready for agent`. One secret, one setting.
- **Intermediate** — [run it on another repo](#run-it-on-another-repo): cross-repo checkout + `ready for spec` (spec → build in one run) + custom skills.
- **Full** — [cross-provider on a Codex subscription](#cross-provider-on-a-codex-subscription-no-openai-key): Opus plans, Sonnet implements, Codex reviews.

The job runs `vanguard watch --source github --once` **once**: a `ready for spec` ticket is specced and built in the same invocation. The shipped [`.github/workflows/vanguard-implement.yml`](.github/workflows/vanguard-implement.yml) does this for Vanguard's own repo. Each run processes every matching open issue (not only the one just labelled), so labelling one `ready for agent` also picks up any others already waiting — run an always-on `vanguard watch` on a host if you want continuous polling instead ([docs/deploy.md](docs/deploy.md)).

**Required secret:** `CLAUDE_CODE_OAUTH_TOKEN` (repository or org secret). The built-in `GITHUB_TOKEN` covers git push, PR, and label writes.

**Required repo setting:** enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it the agent's `gh pr create` fails with `GitHub Actions is not permitted to create or approve pull requests` after doing all the work. (Set it via API: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.)

**Security:** the job condition restricts triggers to the maintainer's own issues (`github.event.issue.user.login` and `sender.login`), so a stranger labelling an issue cannot start a run. `--llm-proxy` keeps the model credential in a sidecar, out of the sandbox.

#### Run it on another repo

The target repo does not need Vanguard installed — check it out alongside the workspace and build it in the job. Drop this in `.github/workflows/vanguard-implement.yml` in *that* repo, add the `CLAUDE_CODE_OAUTH_TOKEN` secret, enable the PR-creation setting above, and label an issue `ready for spec` or `ready for agent`:

```yaml
name: Vanguard Implement
on:
  issues:
    types: [labeled]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
concurrency:
  group: vanguard-implement-${{ github.repository }}
  cancel-in-progress: false
jobs:
  implement:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.actor == 'YOUR_LOGIN') ||
      (github.event_name == 'issues' &&
      contains(fromJSON('["ready for spec","ready for agent"]'), github.event.label.name) &&
      github.event.issue.user.login == 'YOUR_LOGIN' &&
      github.event.sender.login == 'YOUR_LOGIN')
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v6                 # target repo -> workspace
      - uses: actions/checkout@v6                 # vanguard -> ./.vanguard-src
        with: { repository: SebaBoler/vanguard, path: .vanguard-src }
      - uses: pnpm/action-setup@v6
        with: { package_json_file: .vanguard-src/package.json }
      - uses: actions/setup-node@v6
        with: { node-version: 24 }
      - run: pnpm install --frozen-lockfile --ignore-workspace
        working-directory: .vanguard-src
      - run: pnpm build
        working-directory: .vanguard-src
      - run: docker build -t vanguard-sandbox:latest .vanguard-src/docker/
      - name: Ensure routing labels       # watch edits these; gh requires them to exist
        run: |
          for l in "ready for spec:FBCA04" "ready for agent:5319E7" "needs info:D93F0B" \
                   "vanguard:speccing:FEF2C0" "vanguard:running:C5DEF5" "vanguard:review:0E8A16"; do
            gh label create "${l%:*}" --repo "$GITHUB_REPOSITORY" --color "${l##*:}" --force
          done
      - name: Run Vanguard loop (spec then implement)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node .vanguard-src/dist/cli/index.js watch --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE" --once --skills .vanguard-src/skills --llm-proxy
```

Notes: the repo needs at least one commit (an empty repo has no `main` to open a PR against). The sandbox agent reads the target repo's `CLAUDE.md`, so put design/stack rules there to steer output — Vanguard does not inject your local Claude Code skills. `--skills .vanguard-src/skills` injects Vanguard's bundled skills (`ponytail`, `code-review`, `simplify`). Don't run this **and** an always-on GitHub watcher on the same labels — pick one per repo (a Linear watcher does not clash). `--ignore-workspace` on the Vanguard install matters when the target repo is itself a **pnpm workspace** (monorepo): without it, `pnpm install` in `.vanguard-src` walks up to the target's `pnpm-workspace.yaml`, installs into the wrong place, and the Vanguard build fails. It is a no-op for non-workspace targets, so keep it always.

#### Cross-provider on a Codex subscription (no OpenAI key)

Want Opus to plan, Sonnet to build, and Codex to review, with Codex running on a ChatGPT Plus/Pro subscription instead of a paid OpenAI API key? Two changes to the job above.

**1. Add the subscription credential as a secret.** Run `codex login` once on your machine (a ChatGPT account, `auth_mode: chatgpt`), then push the resulting `auth.json` verbatim — it holds OAuth tokens, not an API key:

```bash
gh secret set CODEX_AUTH_JSON --repo OWNER/REPO < ~/.codex/auth.json
```

**2. Set the providers and drop `--llm-proxy`.** Forward the secret and pick a provider per stage:

```yaml
      - name: Run Vanguard loop (Opus spec / Sonnet impl / Codex review)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
        run: |
          node .vanguard-src/dist/cli/index.js watch --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE" --once --skills .vanguard-src/skills --spec-model opus --provider claude --provider-model sonnet --review-provider codex
```

`--spec-model opus` plans, `--provider claude --provider-model sonnet` implements and simplifies, `--review-provider codex` reviews. Vanguard writes `CODEX_AUTH_JSON` to `~/.codex/auth.json` inside the sandbox (see [Providers](#providers)) and Codex runs on the subscription. `--skills` reaches the Claude implementer stages; the Codex reviewer does not receive a skill index in this cross-provider configuration (see [Skills](#skills)).

`--provider-model` applies only to the Claude stages; it is never handed to the cross-provider reviewer (an Anthropic model name like `sonnet` would be rejected by the ChatGPT backend). The Codex reviewer uses its own default model — pass `--review-model <model>` to pick a specific one.

`--llm-proxy` is gone on purpose: a subscription talks to the ChatGPT backend, which the proxy allowlist does not cover (it routes the `api.openai.com` API-key path only). Without the proxy the Claude token sits in the sandbox directly — acceptable on a repo you own; if you need the proxy isolation, give Codex an `OPENAI_API_KEY` with active billing instead and keep `--llm-proxy`.

One CI caveat: the stored `CODEX_AUTH_JSON` is a snapshot. Codex refreshes the short-lived access token from the embedded `refresh_token` on each run, so the secret must carry a live refresh token; re-run `gh secret set` if a run ever fails to authenticate. For long-running hosts (a `vanguard watch` on a server or NAS) the local file refreshes itself and this does not come up.

## Cost & limits

Two cost dimensions: **GitHub Actions minutes** (only when you run via Actions) and **model usage**.

**GitHub Actions minutes.** A run builds Vanguard + the sandbox image, then runs the pipeline — about **15-20 minutes per run** on `ubuntu-latest`.
- **Public repos: unlimited.** GitHub bills no Actions minutes for public repositories, so the Actions path has no minute ceiling there.
- **Private repos: 2000 min/month** on the Free plan (then paid). At ~15-20 min/run that is roughly **100-130 runs/month**.
- **Avoid Actions minutes entirely:** run an always-on `vanguard watch` on your own hardware (Synology / Hetzner / any Docker host — see [docs/deploy.md](docs/deploy.md)). It uses **zero** GitHub minutes, polls Linear or GitHub itself, and is the right home for a private-repo factory or heavy use. The Linear path has no Actions option anyway and always runs on a host.
- **Cut per-run minutes** (private-repo Actions): the biggest slice is rebuilding the sandbox image every run — prebuild it and push to GHCR, then `docker pull` instead of `docker build` (saves ~2-3 min/run); cache `pnpm` and the build. Keep `runs-on: ubuntu-latest` (1× multiplier; larger runners multiply the minute cost). A single `watch --once` (the default since the spec→build fix) already halved the old double-sweep.

**Model usage.** Billing follows the credential, not the run count: a **subscription** (`CLAUDE_CODE_OAUTH_TOKEN`, or Codex `CODEX_AUTH_JSON`) draws on your plan's usage with no per-token charge; an **API key** bills per token (see [Auth](#auth)). On a subscription the marginal cost of a run is plan usage + time, not dollars. `vanguard stats` rolls up per-run tokens/cost from `.vanguard/runs/metrics.jsonl`.

## Retrospective memory

`vanguard memory` reads `.vanguard/runs` artifacts — failed runs, failed proofs, and reviewer notes (not diffs or transcripts) — and refreshes a short, redacted digest at `.vanguard/memory/retrospective.md`. It is deterministic (no LLM): a host-side rollup, advisory only.

Subsequent `run`, `watch`, and spec runs automatically load that digest into the implementer and tech-spec prompts as advisory context ("use only when relevant"); the digest refreshes best-effort after each run. `.vanguard/` is gitignored — this is operational host state, not committed source.

```bash
vanguard memory                 # refresh + print the digest
vanguard memory --json          # machine-readable report
vanguard memory --limit 20      # keep the 20 most recent entries
```

## Proof of work

After the agent finishes, the host (not the agent) runs a verification command inside the sandbox, captures its stdout and stderr, computes a SHA-256 over the combined output, and stamps a Proof of Work block into the PR body and the run record. The agent cannot fake it.

Command precedence: `--verify "<cmd>"` flag > `VANGUARD_VERIFY_CMD` env > auto-detect from the worktree `package.json` (if a `test` script exists, the host builds `<pm> install --frozen-lockfile [&& <pm> run typecheck] && <pm> test`) > skip (no command resolved means no block, PR body unchanged).

On failure the PR always opens, the body carries a `FAIL` Proof of Work block (command, exit code, SHA-256, and an output tail), and a `vanguard:verify-failed` label is added to the PR (best-effort).

```bash
vanguard run --linear TES-1 --verify "pnpm typecheck && pnpm test"
# or set for all runs:
VANGUARD_VERIFY_CMD="pnpm typecheck && pnpm test" vanguard watch --label vanguard
```

## Visual proof

After the agent finishes, the host (not the agent) optionally runs a user-supplied visual proof command inside the sandbox — for UI changes that produce screenshots or visual artifacts (e.g. Playwright). It captures stdout and stderr, computes a SHA-256 over the combined output, lists the artifacts the command wrote under `/workspace/.vanguard/visual-proof`, hashes each one (a manifest of path + SHA-256 + byte size — artifacts are not copied out in this version), and stamps a Visual Proof block into the PR body and the run record.

Command precedence: `--visual-proof "<cmd>"` flag > `VANGUARD_VISUAL_PROOF_CMD` env > skip. Unlike Proof of work, there is no auto-detect — if no command is resolved, there is no visual proof and the PR body is unchanged.

Allowed artifact extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`, `.html`, `.json`.

Visual proof failure never blocks the PR: the PR always opens, and on a non-zero exit — or if a configured command can't be executed at all (sandbox crash, cancel, timeout) — the body carries a `FAIL` Visual proof block (a crash is recorded with exit code `-1`) and a `vanguard:visual-proof-failed` label is added to the PR (best-effort). A requested proof is never silently dropped; only when no command is configured is there no block.

```bash
vanguard run --github 123 --visual-proof "pnpm exec playwright test --project=chromium"
# or set for all runs:
VANGUARD_VISUAL_PROOF_CMD="pnpm exec playwright test --project=chromium" vanguard watch --label vanguard
```
