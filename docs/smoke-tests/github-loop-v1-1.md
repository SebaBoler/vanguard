# GitHub Loop v1.1 Smoke Test

Use this when you want to prove the GitHub Loop v1.1 lane works end-to-end on one safe issue. A single `--once` run completes both the spec and build passes; a second optional run confirms the no-op behaviour.

## Prerequisites

- You can create issues, labels, comments, branches, and pull requests in `OWNER/REPO`.
- `GH_TOKEN` can read and update the repo.
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is available to the watcher.
- `vanguard-sandbox:latest` exists on the Docker daemon used by the controller.
- The repo has these labels: `ready for spec`, `ready for agent`, `needs info`, `vanguard:speccing`, `vanguard:running`, and `vanguard:needs-human-review`.

## Label Flow

| State | Meaning |
|---|---|
| `ready for spec` | Spec pass should claim the issue. |
| `vanguard:speccing` | Spec pass is running. |
| `ready for agent` | Tech spec exists; the next pass can implement. |
| `vanguard:running` | Agent pass is running. |
| `vanguard:needs-human-review` | Draft PR opened for human review. |
| `needs info` | Parked until a human adds missing context and moves it back. |

Expected happy path:

```text
ready for spec -> vanguard:speccing -> ready for agent -> vanguard:running -> vanguard:needs-human-review
```

## Pass 1: Combined spec + build

Create a fresh issue with `ready for spec`. Give it a short goal and measurable acceptance criteria.

Run the AFK readiness check before claiming anything:

```bash
vanguard doctor --loop-v1 --source github --github-repo OWNER/REPO --repo /path/to/repo
```

Expected result:

- Every line is `preflight: ... ok`.
- If any line ends with `-> stop before claim`, fix that dependency first.
- The issue labels do not change.

Run one controlled poll:

```bash
vanguard watch --loop-v1 --source github --github-repo OWNER/REPO --repo /path/to/repo --once --llm-proxy
```

Expected result:

- The issue receives a `Vanguard tech spec:` comment containing `<tech_spec>`.
- The agent claims the issue with `vanguard:running` and opens a draft PR.
- The issue receives a comment with the PR URL.
- Final labels: `vanguard:needs-human-review` (all routing labels removed).

## Pass 2 (optional no-op verification)

Run the same command a second time to confirm it is a clean no-op:

```bash
vanguard watch --loop-v1 --source github --github-repo OWNER/REPO --repo /path/to/repo --once --llm-proxy
```

Expected result:

- `spec: poll -> 0 ready` and `watch: poll -> 0 ready` — nothing to do.
- No labels change. No new comments or PRs.

## Needs Info

If the issue is too vague, Vanguard parks it instead of spending implementation budget.

Expected result:

- `needs info` is added.
- The trigger label is removed.
- A clarification comment tells the human what is missing.

To resume, update the issue with the missing detail, remove `needs info`, and add either `ready for spec` or `ready for agent`.

## Troubleshooting

- No issue is picked up: confirm the repo slug and labels.
- Spec runs but agent does not: confirm the issue has `ready for agent`, then run another `--once` pass.
- Auth fails before claim: set `GH_TOKEN` and one LLM auth env var, then rerun. The issue should still have its trigger label.
- A bad draft PR opens: close the PR, remove `vanguard:needs-human-review`, and put the issue back on the right trigger label after fixing the issue text.
