# Vanguard

An autonomous software factory that fetches work items from external task systems, runs an AI agent pipeline to implement them, and opens draft PRs/MRs for human review.

## Language

### Task Layer

**Task Source**:
A pluggable integration that connects Vanguard to an external task system. Each source implements `TaskFetcher` and `WatchPrimitives`.
_Avoid_: Provider, plugin, adapter, integration

**Task**:
The unified internal representation of a work item, regardless of origin (GitHub issue, GitLab issue, Linear issue).
_Avoid_: Issue, ticket, item

**Task Fetcher**:
The contract a Task Source implements to retrieve Tasks — `fetch(id)` for a single Task with full detail, `list(filter)` for bulk discovery without comments.
_Avoid_: Task provider, task reader

**Watch Primitives**:
The five operations a Task Source must supply to participate in the autonomous polling loop: `listReady`, `claim`, `runOne`, `review`, `onFailure`.
_Avoid_: Watch operations, loop hooks

**Claim**:
The act of marking a Task as in-progress so subsequent poll ticks skip it. On GitHub/GitLab this adds a state label; on Linear this moves the state.
_Avoid_: Lock, assign, take

### Pipeline

**Run**:
One end-to-end execution: fetch a Task, implement it in a sandbox, commit, and open a draft PR or MR.
_Avoid_: Job, execution, task run

**Watch Loop**:
The autonomous polling mode that repeatedly lists ready Tasks, claims them, and runs them without human intervention.
_Avoid_: AFK loop, cron, daemon

**Loop v1**:
A two-pass variant of the Watch Loop where a cheap spec-generation pass precedes the full agent pass. The spec pass labels vague tickets as needing info.
_Avoid_: Spec mode, two-pass loop

**Proof of Work**:
A verification command that runs inside the sandbox after the agent finishes. Failure flags the PR/MR but does not block it.
_Avoid_: Verify step, sandbox test

### Platform Surface

**Scoped Label** (GitLab):
A GitLab label whose name contains `::`, making it mutually exclusive with other labels in the same scope. Vanguard uses these for its own state labels (`vanguard::running`, `vanguard::review`, etc.) so transitions don't require manual removal of the prior label.
_Avoid_: Exclusive label, scoped tag

**MR**:
A GitLab Merge Request — the GitLab equivalent of a GitHub Pull Request. Vanguard opens draft MRs after completing a Run on a GitLab-sourced Task.
_Avoid_: Pull Request, PR (when referring to GitLab)

**Runner**:
The CLI tool Vanguard shells out to for platform operations. `gh` for GitHub, `glab` for GitLab, `linear` for Linear.
_Avoid_: CLI, client, SDK
