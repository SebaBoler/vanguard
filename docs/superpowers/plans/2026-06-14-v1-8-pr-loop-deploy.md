# PR Loop Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `doctor-prs`/`watch-prs` PR review loop deployable from the shipped Docker Compose template.

**Architecture:** Keep the default issue loop unchanged. Add an optional Compose profile service named `vanguard-watch-prs` that reuses the runner image, Docker socket, target repo, and auth environment, but runs `watch-prs` with PR review labels. Document a preflight command using the same service with command override.

**Tech Stack:** Docker Compose, Markdown deploy docs, existing Vanguard CLI.

---

### Task 1: Compose Profile

**Files:**
- Modify: `docker/compose.yaml`

- [x] **Step 1: Add service**

Add a `vanguard-watch-prs` service with:

```yaml
profiles: ["pr-review"]
command:
  - watch-prs
  - --github-repo=OWNER/REPO
  - --label=ready for vanguard review
  - --repo=/work/repo
  - --interval=120
  - --llm-proxy
```

- [x] **Step 2: Validate compose**

Run:

```bash
docker compose -f docker/compose.yaml config
```

Expected: config renders successfully.

### Task 2: Deploy Docs

**Files:**
- Modify: `docs/deploy.md`

- [x] **Step 1: Add PR review loop runbook**

Document:

```bash
docker compose run --rm vanguard-watch-prs doctor-prs --github-repo=OWNER/REPO --label "ready for vanguard review" --repo=/work/repo
docker compose --profile pr-review up -d vanguard-watch-prs
```

- [x] **Step 2: Update architecture text**

Mention `vanguard-watch-prs` as an optional controller that reviews external PRs and does not replace `vanguard-watch`.

### Task 3: Verification

**Files:**
- Validate: `docker/compose.yaml`
- Validate: `docs/deploy.md`

- [x] **Step 1: Run compose config**

Run:

```bash
docker compose -f docker/compose.yaml config
```

- [x] **Step 2: Run relevant tests**

Run:

```bash
pnpm exec vitest run src/cli/args.test.ts src/cli/preflight.test.ts src/cli/doctor-prs.test.ts
pnpm typecheck
```
