# Operator Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `vanguard watch` emit terse, caveman-friendly operator progress lines.

**Architecture:** Add optional log hooks to pure watch orchestrators instead of per-source wrappers. `watchOnce` and `specOnce` will log poll count plus per-item outcomes; `runWatchLoop` and `runLoopV1` pass their logger through and keep existing summary lines.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest.

---

### Task 1: Watch Event Tests

**Files:**
- Modify: `src/runners/watch.test.ts`
- Modify: `src/runners/watch.ts`

- [x] Add test coverage for `watchOnce(..., { log })` showing compact lines for poll count, PR opened, no-change, failed, and skipped outcomes.
- [x] Add test coverage for `specOnce(..., { log })` showing compact lines for poll count, advanced, needs-info, failed, and skipped outcomes.
- [x] Add test coverage for `runLoopV1(..., log)` showing spec pass logs are followed by agent pass logs and fresh spec advances are still deferred.

### Task 2: Implementation

**Files:**
- Modify: `src/runners/watch.ts`

- [x] Introduce a small `WatchLogOptions` type with `log?: (msg: string) => void` and `phase?: string`.
- [x] Add `operatorLog` helper that no-ops when no logger is supplied.
- [x] Emit terse lines:

```text
watch: poll -> 4 ready
watch A: pr opened -> review
watch B: no change -> idle
watch C: failed -> failure noted
watch D: skipped -> already claimed
spec: poll -> 4 ready
spec A: advanced -> next poll agent
spec B: needs info -> waiting human
spec C: failed -> retry later
spec D: skipped -> already claimed
```

### Task 3: Docs And Verification

**Files:**
- Modify: `README.md`
- Test: full project

- [x] Document the operator log style in the Autonomous loop section.
- [x] Run `pnpm exec vitest run src/runners/watch.test.ts`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm test`.
