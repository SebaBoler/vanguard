# V1.2 Doctor Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a `vanguard doctor` command and run the same preflight before `watch` can claim work.

**Architecture:** Keep the checks in a small `src/cli/preflight.ts` module with injectable command/env dependencies so tests do not call real Docker or GitHub. `doctor` prints the check lines and exits non-zero on failure. `watch` runs preflight before auth, sandbox startup, polling, or issue claim.

**Tech Stack:** TypeScript, Vitest, Node `parseArgs`, `execa`, existing Vanguard CLI modules.

---

### Task 1: CLI Shape

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/args.test.ts`

- [x] Add a `doctor` command kind that reuses watch-like source/routing options.
- [x] Add parser tests proving `vanguard doctor --source github --github-repo o/r` gets GitHub Loop v1 defaults.
- [x] Add parser tests proving `vanguard doctor --loop-v1 --label vanguard` gets Linear Loop v1 defaults.
- [x] Add usage text for the doctor command.

### Task 2: Preflight Module

**Files:**
- Create: `src/cli/preflight.ts`
- Create: `src/cli/preflight.test.ts`

- [x] Write failing tests for missing LLM auth.
- [x] Write failing tests for GitHub Loop v1 required labels.
- [x] Write failing tests for successful compact output.
- [x] Implement injectable checks for Node version, auth env, repo remote, Docker daemon, sandbox image, GitHub auth, GitHub labels, Linear API key, and Linear skills path.

### Task 3: Command Wiring

**Files:**
- Create: `src/cli/doctor.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/watch.ts`

- [x] Route `doctor` from the CLI entrypoint.
- [x] Print preflight lines from `doctor`.
- [x] Throw before claim when any check fails.
- [x] Call preflight at the top of `watchCommand`, before auth and sandbox startup.

### Task 4: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/smoke-tests/github-loop-v1-1.md`

- [x] Document `vanguard doctor` as the AFK readiness gate.
- [x] Add doctor as step zero in the GitHub smoke runbook.
- [x] Run focused tests, typecheck, and full tests.
- [ ] Complete PR review, CI, and merge.
