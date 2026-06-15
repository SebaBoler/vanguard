# Codex / OpenAI under Host LLM Proxy Smoke Test

Use this when you want to prove that Codex (or OpenAI) runs correctly under `--llm-proxy` and that the real API key never enters the sandbox. The test exercises the preflight check, then a live `review-pr` run as the lowest-blast-radius read-only path.

## Prerequisites

- `CODEX_API_KEY` or `OPENAI_API_KEY` is exported on the **host** (not inside any container). Vanguard reads it from the host to hand it to the proxy sidecar; it must never be set inside the sandbox.
- The OpenAI account behind the key has active billing. Without it, `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.
- `vanguard-sandbox:latest` exists on the Docker daemon used by the controller (`docker image ls vanguard-sandbox` should list it).
- `GH_TOKEN` is set, or `gh auth login` has been run. The reviewer posts a GitHub review comment, so write access to the target PR is required.
- A real GitHub repository (`OWNER/REPO`) with at least one open PR (`PR`) that is safe to comment on during testing.
- The `--repo /path/to/repo` argument points to a local clone of any git repository; the review-pr path only uses it to anchor the worktree — it does not touch its contents.

## How the proxy keeps the key out of the sandbox

Under `--llm-proxy`, the real `OPENAI_API_KEY` is held by a trusted sidecar started by the host process. The sandbox receives only a short-lived random **nonce** as `OPENAI_API_KEY` and a `base_url` that points at the sidecar. The `codex` CLI is configured (via `~/.codex/config.toml`) to use that sidecar as its OpenAI-compatible provider endpoint instead of `api.openai.com`. The sidecar validates the nonce, swaps in the real key, and forwards the request. Because `--llm-proxy` implies `--egress`, the sandbox has no direct route to `api.openai.com` — its only path to the model is through the sidecar. A leaked nonce is useless outside the run and never reaches OpenAI directly.

## Preflight — issue loop

Before starting a `watch` loop run the readiness check to confirm all dependencies are in order without claiming any work:

```bash
vanguard doctor \
  --source github \
  --github-repo OWNER/REPO \
  --provider codex \
  --llm-proxy \
  --repo /path/to/repo
```

Expected result:

- Every line is `preflight: ... ok`.
- The `provider auth` line specifically reads `preflight: provider auth ok` — this confirms the host key is present and the proxy mode key-routing path accepted it.
- If any line ends with `-> stop before claim`, fix that dependency first (see Troubleshooting below).
- No work is claimed and no labels change.

## Preflight — PR loop

Run the same check for the PR-watch path:

```bash
vanguard doctor-prs \
  --github-repo OWNER/REPO \
  --label "ready for vanguard review" \
  --provider codex \
  --llm-proxy \
  --repo /path/to/repo
```

Expected result: identical to the issue loop preflight above. Both doctor commands go through the same `runPreflight` path, so a passing `provider auth` line here confirms the PR-loop is ready too.

## Live smoke — read-only PR review

`review-pr` is the safest live test: it is read-only on the repository (no labels change, no code is written) and posts exactly one non-blocking GitHub review comment. Use a PR you own and that is safe to annotate.

```bash
vanguard review-pr \
  https://github.com/OWNER/REPO/pull/PR \
  --provider codex \
  --review-model gpt-5 \
  --llm-proxy \
  --repo /path/to/repo
```

### Expected operator log sequence

```text
review-pr OWNER/REPO#PR: fetch -> diff
review-pr OWNER/REPO#PR: agent -> reviewing
review-pr OWNER/REPO#PR: posted -> pr review
review-pr OWNER/REPO#PR: done
```

- `fetch -> diff` — the PR metadata and unified diff were fetched from GitHub.
- `agent -> reviewing` — the sandbox started and Codex is running the adversarial review prompt.
- `posted -> pr review` — the review comment (beginning `## Vanguard Review`) was posted to the PR.
- `done` — the command exited cleanly.

### Verifying that the real key never entered the sandbox

After the run, confirm the invariant by inspecting what the sandbox received. The proxy nonce model ensures that:

1. `OPENAI_API_KEY` inside the sandbox is a short random nonce, not the real key. You can verify this by checking the run transcript under `.vanguard/runs/` — the sandbox env printed there (if debug logging is on) will show a short token, not a live key.
2. `api.openai.com` was removed from the sandbox allowlist (implied by `--egress`). The sandbox had no direct route to OpenAI; all traffic went through the sidecar.
3. The `codex config.toml` written into the sandbox points `baseUrl` at the proxy sidecar URL, not at `api.openai.com`.

A simple additional check: run `docker inspect` on a sandbox container while a run is in progress and confirm `OPENAI_API_KEY` is a short nonce rather than a key starting with `sk-`.

### Expected GitHub outcome

- The target PR gains a new review comment starting with `## Vanguard Review`.
- No labels on the PR or any issue are touched.
- No branch or commit is created.

## Troubleshooting

**`preflight: provider auth Provider "codex" needs CODEX_API_KEY or OPENAI_API_KEY in the environment. -> stop before claim`**

The host key is missing. Export it before running:

```bash
export CODEX_API_KEY=your-key-here
```

Or use `OPENAI_API_KEY` — Vanguard reads both. The key must be set in the shell that runs `vanguard`, not only inside a container.

**`preflight: llm auth missing -> stop before claim`**

Claude auth is still required for the host process itself (it is used for the spec/watch loop even when Codex runs the agent stages). Set `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` (API).

**`preflight: provider auth ok` but `review-pr` fails with "account is not active"**

The key is present and valid, but the OpenAI account behind it has no active billing. Add a payment method or billing credits to the OpenAI account.

**`preflight: docker daemon unavailable -> stop before claim`**

Start Docker Desktop (macOS) or the Docker daemon (`sudo systemctl start docker` on Linux), then rerun.

**`preflight: sandbox image missing vanguard-sandbox:latest -> stop before claim`**

Build the sandbox image first:

```bash
docker/build.sh
```

**Proxy sidecar not reachable (`ECONNREFUSED` or timeout in the sandbox)**

The sidecar is started automatically by `vanguard review-pr --llm-proxy`. If you see a connection error, check that `--egress` and the Docker network were set up correctly. Rerunning the command is usually enough; if not, confirm `docker network ls` shows the expected internal network and that no firewall rule blocks inter-container traffic on it.

**`preflight: github auth missing -> stop before claim`**

Run `gh auth login` or set `GH_TOKEN` in your shell, then rerun the doctor command.

**`preflight: github labels missing ready for vanguard review -> stop before claim`**

The `doctor-prs` preflight checks that the trigger label exists in the repo. Create it:

```bash
gh label create "ready for vanguard review" --repo OWNER/REPO --color 0075ca
```
