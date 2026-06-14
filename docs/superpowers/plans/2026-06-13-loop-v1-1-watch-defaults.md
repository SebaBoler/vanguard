# Loop v1.1 Watch Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Loop v1 easy to start with short watch commands while preserving routing guardrails under the hood.

**Architecture:** Keep `parseCli` pure and apply built-in Loop v1 defaults during argument normalization. Explicit flags keep winning, legacy single-pass watch remains available, and the runtime `watchCommand` continues to route based on `specLabel` / `specState` presence.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest.

---

### Task 1: Parser Defaults

**Files:**
- Modify: `src/cli/args.ts`
- Test: `src/cli/args.test.ts`

- [x] Add parser tests showing `vanguard watch --source github --github-repo o/r` expands to GitHub Loop v1 defaults with `specLabel: 'ready for spec'`, `agentLabel: 'ready for agent'`, and `needsInfoLabel: 'needs info'` without requiring an ownership label.
- [x] Add parser tests showing `vanguard watch --source github --loop-v1 --label ai --github-repo o/r` uses Loop v1 defaults but preserves the explicit ownership label.
- [x] Add parser tests showing `vanguard watch --loop-v1 --team TES` expands to Linear Loop v1 defaults with `label: 'vanguard'`, `specState: 'triage'`, `specStateName: 'Spec'`, and `needsInfoState: 'Needs Info'`.
- [x] Implement a `--loop-v1` boolean flag plus built-in default constants. Use defaults only when Loop v1 is explicitly requested or when GitHub watch has no label and no routing labels, so old single-pass `watch --label vanguard` stays unchanged.
- [x] Infer `source: 'github'` when `--github-repo` is supplied and `--source` is absent, because that flag is GitHub-specific.

### Task 2: Usage And Docs

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `README.md`

- [x] Document `--loop-v1` in CLI usage.
- [x] Replace the verbose GitHub Loop v1 primary example with the short command and keep the explicit version as the customization path.
- [x] Add the Linear short command using `--loop-v1`.

### Task 3: Verification

**Files:**
- Test: `src/cli/args.test.ts`
- Test: full project

- [x] Run `pnpm exec vitest run src/cli/args.test.ts`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm test`.

### Follow-Up: Caveman-Friendly Operator Logs

**Status:** Implemented in [Operator Logs Implementation Plan](2026-06-14-operator-logs.md).

**Idea:** Vanguard watch logs should read like compact Codex progress updates: short event lines that say what is happening, why it matters, and what happens next. Keep them machine-scannable and terse so `caveman` style output remains useful.

**Candidate format:**

```text
watch github owner/repo: poll ready labels -> 2 found
spec #123: triage pass -> generating tech spec
spec #123: posted <tech_spec> -> next poll can run agent
agent #124: triage fail -> moved needs info
agent #125: pr opened -> draft https://github.com/owner/repo/pull/7
```

**Design note:** Prefer one-line status events over verbose prose. Include source, task id, phase, outcome, and next action. Avoid dumping full prompts or stack traces into normal operator logs; keep details in run records.
