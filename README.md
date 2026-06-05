# Vanguard

An autonomous "software factory": take a task, run a Claude Code agent in an isolated sandbox on its own `git worktree`, and produce a reviewable branch and PR. Vanguard is a standalone TypeScript framework, not a wrapper around another tool.

Status: Phase 1 (core engine) and Phase 2 (task sources, pipeline, evals) are implemented and tested.

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
- **Pipeline**: `runStages` chains stages over one shared worktree and session. Built-in stage sets: Implementer/Reviewer/Simplifier and Generate/Evaluate/Repair. `commitStage` and `publishForReview` are the Merger.
- **Evals**: `runEvals` scores cases (control, edge, refusal) with a programmatic or LLM judge.

## Quick start

```bash
pnpm install
pnpm build
docker/build.sh                 # builds vanguard-sandbox (node + git + claude CLI)
```

Run the smoke example against a throwaway repo:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Anthropic/token") pnpm tsx examples/smoke.ts
```

## Task sources (pick one)

`TaskFetcher` abstracts the source, so one deployment uses a single source of truth.

```ts
const fetcher = createLinearTaskFetcher(process.env.LINEAR_API_KEY!);   // Linear
const fetcher = new GitHubTaskFetcher('owner/repo');                    // GitHub Issues
const fetcher = new GitHubProjectFetcher({ owner, projectNumber, repo });// GitHub Projects v2
```

GitHub is also the review surface: `publishForReview` opens a PR, and `linkPullRequest` / `linkLinearIssue` comment the PR link back onto the source issue.

## Auth

Subscription is the default and draws on your Claude plan credits. The API key is the alternative and bills the Developer Platform. Vanguard injects exactly one secret into the sandbox, so billing is unambiguous.

```bash
claude setup-token            # once, generates the subscription token
CLAUDE_CODE_OAUTH_TOKEN=...    # subscription (default)
ANTHROPIC_API_KEY=...          # API billing instead
```

See `.env.example`. `authFromEnv()` prefers the subscription token; `authSecrets(auth)` maps the choice to the single env var the sandbox receives.

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

## Security

The sandbox is the blast radius, not the host. Secrets reach the sandbox through an in-RAM tmpfs file (POSIX-quoted, never in `docker inspect` or on disk), never via argv. Host subprocesses use argument arrays, never shell strings. `.env` is a template only; no secrets live in the repo.

## Development

```bash
pnpm typecheck
pnpm test
```

Node 24+, pnpm, Vitest, ESM with NodeNext. Tests are co-located as `*.test.ts`. Docker integration tests run when Docker is present and skip otherwise.
