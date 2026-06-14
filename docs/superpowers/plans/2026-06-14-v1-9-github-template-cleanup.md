# GitHub Template Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the GitHub issue template and watch-loop comments with Loop v1.1 routing, where the `vanguard` ownership label is optional.

**Architecture:** Keep behavior unchanged. Update only documentation-facing defaults and stale comments so repo-wide GitHub watch can rely on `ready for spec` / `ready for agent` labels, while deployments that opt into `--label vanguard` can still use that label as an ownership guard.

**Tech Stack:** Markdown, TypeScript comments, Vitest.

---

### Task 1: GitHub Issue Template

**Files:**
- Modify: `.github/ISSUE_TEMPLATE/vanguard-task.md`
- Modify: `README.md`

- [x] **Step 1: Remove ownership label from template default**

Change frontmatter from:

```yaml
labels: vanguard, ready for agent
```

to:

```yaml
labels: ready for agent
```

- [x] **Step 2: Document ownership-label opt-in**

Add template guidance explaining that `vanguard` is only needed when the operator starts GitHub watch with `--label vanguard`.

- [x] **Step 3: Align README template note**

Clarify that the template defaults to `ready for agent` only, and ownership labels are deployment-specific.

### Task 2: Watch Comment Cleanup

**Files:**
- Modify: `src/cli/watch.ts`

- [x] **Step 1: Remove stale TODO comments**

Replace the old TODO comments with comments that point to the existing flags:

```ts
const SPEC_CLAIMED_STATE = 'Speccing'; // Linear default; override with --spec-claimed-state.
const SPEC_CLAIMED_LABEL = 'vanguard:speccing'; // GitHub default; override with --spec-claimed-label.
```

### Task 3: Verification

**Files:**
- Validate: `.github/ISSUE_TEMPLATE/vanguard-task.md`
- Validate: `README.md`
- Validate: `src/cli/watch.ts`

- [x] **Step 1: Run focused tests**

Run:

```bash
pnpm exec vitest run src/cli/args.test.ts src/runners/watch.test.ts
```

- [x] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```
