# Deploy Loop v1.1 Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Align production deployment docs and compose template with Loop v1.1 watch defaults.

**Architecture:** Keep runtime code unchanged. Update `docker/compose.yaml` to run Linear Loop v1.1 by default and document how to switch the same template to GitHub repo-scoped Loop v1.1 without requiring a `vanguard` label.

**Tech Stack:** Docker Compose, Markdown.

---

### Task 1: Compose Template

**Files:**
- Modify: `docker/compose.yaml`

- [x] Add `--loop-v1` to the default `vanguard-watch` command.
- [x] Keep `--label=vanguard` for default Linear mode.
- [x] Add comments explaining GitHub mode: set `--source=github`, add `--github-repo=OWNER/REPO`, and remove `--label` unless an extra ownership filter is desired.
- [x] Add commented Linear state override flags for workspaces whose state names differ from the defaults.

### Task 2: Deployment Docs

**Files:**
- Modify: `docs/deploy.md`

- [x] Update prerequisites to say `LINEAR_API_KEY` is required only for Linear source.
- [x] Update compose setup instructions to describe Linear Loop v1.1 defaults and GitHub Loop v1.1 switch.
- [x] Update the smoke-test section to test spec pass first, then next-poll agent pass.
- [x] Mention GitHub uses `ready for spec` / `ready for agent` routing labels and does not require `vanguard` by default.

### Task 3: Verification

**Files:**
- Validate: docs and compose

- [x] Run `git diff --check`.
- [x] Run `docker compose -f docker/compose.yaml config` if Docker Compose is available.
- [x] Inspect diff for stale single-pass wording.
