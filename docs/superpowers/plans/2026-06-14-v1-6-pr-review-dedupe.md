# PR Review Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `vanguard watch-prs` from reviewing the same PR head commit more than once.

**Architecture:** Add a stable hidden marker to every Vanguard PR review comment, then have the PR watch loop inspect existing PR reviews/comments for that marker before claiming a PR. The one-shot `review-pr` command remains useful on its own and also posts the marker for future watch-loop dedupe.

**Tech Stack:** TypeScript, Vitest, GitHub CLI (`gh`), existing `review-pr` and `watch-prs` runners.

---

### Task 1: Add Head SHA Marker To Review Comments

**Files:**
- Modify: `src/runners/pr-review.ts`
- Modify: `src/runners/pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that `buildPullRequestReviewComment('No blocking findings.', 'abc123')` includes:

```markdown
<!-- vanguard-pr-review: abc123 -->
```

and still strips `<promise>COMPLETE</promise>`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run src/runners/pr-review.test.ts
```

Expected: fail because `buildPullRequestReviewComment` does not accept or emit a head SHA marker yet.

- [ ] **Step 3: Implement marker support**

Add an optional `headRefOid` to `PullRequestForReview`, fetch `headRefOid` via `gh pr view`, and pass it into `buildPullRequestReviewComment`. When present, append the hidden marker below the visible review body.

- [ ] **Step 4: Run focused test**

Run:

```bash
pnpm exec vitest run src/runners/pr-review.test.ts
```

Expected: pass.

### Task 2: Skip Already Reviewed PR Head SHAs In Watch Loop

**Files:**
- Modify: `src/runners/pr-watch.ts`
- Modify: `src/runners/pr-watch.test.ts`

- [ ] **Step 1: Write the failing test**

Add a `githubPullRequestWatchPrimitives` test where `gh pr list` returns PR `#12` with `headRefOid: 'abc123'`, and `gh pr view 12 --json comments,reviews` returns a body containing:

```markdown
<!-- vanguard-pr-review: abc123 -->
```

The expected ready list is empty.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run src/runners/pr-watch.test.ts
```

Expected: fail because the watch loop currently lists the PR without checking existing marker bodies.

- [ ] **Step 3: Implement dedupe check**

Add a helper that fetches `comments,reviews` for each candidate and returns true when any body contains the exact marker for that candidate's `headRefOid`. Filter such PRs out before claim.

- [ ] **Step 4: Run focused test**

Run:

```bash
pnpm exec vitest run src/runners/pr-watch.test.ts
```

Expected: pass.

### Task 3: CLI Docs And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `src/cli/args.ts`

- [ ] **Step 1: Document dedupe behavior**

Update the `watch-prs` docs/help to say that a successful Vanguard review writes a hidden `headRefOid` marker and the loop skips that same commit if the trigger label is re-added.

- [ ] **Step 2: Run verification**

Run:

```bash
pnpm exec vitest run src/runners/pr-review.test.ts src/runners/pr-watch.test.ts src/cli/args.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass. `pnpm` may still warn if the local shell is not Node 24.
