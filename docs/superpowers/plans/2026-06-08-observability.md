# Observability + cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-agent token/time stats (durationMs + an end-of-run summary), consistent structured run-lifecycle logging, and a set of small cleanups — all built on a single shared metric shape so the metrics file, the summary, and the logs never drift.

**Architecture:** One `stageMetric(result, stageName)` builder is the single source of truth, consumed by (a) the `metrics.jsonl` writer, (b) a pure `summarizeOutcomes()` formatter printed after each run, and (c) structured `ctx.log` lines at run/stage boundaries. `runAgent` is instrumented with a wall-clock timer feeding `RunResult.durationMs`. Separately, the sidecar `.mjs` scripts stop duplicating logic and import a copied-in shared module.

**Tech Stack:** TypeScript (ESM, NodeNext, strict, exactOptionalPropertyTypes), Vitest, Pino, zero-dep sidecar `.mjs`.

**Conventions:** Polish commits, short, NO co-author, English code/comments, `.js` import extensions, no `any`, explicit return types.

---

## Task 1: durationMs + single-source `stageMetric`

**Files:** Modify `src/core/types.ts`, `src/core/vanguard.ts`, `src/core/run-record.ts`; Create `src/core/run-metric.ts` + `src/core/run-metric.test.ts`.

- [ ] **Step 1:** `RunResult` (types.ts) gains `durationMs?: number`.
- [ ] **Step 2:** Instrument `runAgent` (vanguard.ts): capture `const startedAt = Date.now()` at the top of the function body; compute `const durationMs = Date.now() - startedAt` just before building the `result` object; add `durationMs` to the returned `RunResult` (unconditional number). The forkAndSelect path already calls runAgent per variant, so each variant's RunResult carries its own durationMs automatically — no change needed there.
- [ ] **Step 3 (TDD):** Create `src/core/run-metric.ts` exporting `stageMetric(result: RunResult, stageName?: string): StageMetric` where `StageMetric` = `{ taskId, stage?, exitReason, completed, turns, costUsd, cacheEfficiency, inputTokens, outputTokens, cacheReadInputTokens, durationMs }` (numbers default 0 when absent, like the current metrics object). Write `run-metric.test.ts` first: a RunResult with usage/cost/duration → expected flat metric; a RunResult missing usage/cost/duration → zeros; stageName omitted → no `stage` key. Red→green.
- [ ] **Step 4:** Refactor `persistRunRecord` (run-record.ts) to build its `metric` object via `stageMetric(result, opts.label)` plus `{ evt: 'run_complete', ts: timestamp, ...(prUrl) }` — replacing the hand-rolled field list (lines ~48-62). Behavior identical EXCEPT the metric now also includes `durationMs`. Keep the JSON record (`record`) unchanged.
- [ ] **Step 5:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: durationMs per bieg + wspólny stageMetric"`.

---

## Task 2: End-of-run summary

**Files:** Create `src/core/run-summary.ts` + `src/core/run-summary.test.ts`; Modify `src/runners/linear.ts`, `src/runners/github.ts` (+ fan-out paths).

- [ ] **Step 1 (TDD):** `src/core/run-summary.ts` exports pure `summarizeOutcomes(outcomes: ReadonlyArray<{ name: string; result: RunResult }>): string` — a compact aligned table, one row per stage (stage · exit · turns · in/out/cacheRead tokens · cache% · $costUsd · durationMs as seconds) + a TOTAL row summing cost, tokens, duration. Use `stageMetric` per row (single source). Write `run-summary.test.ts` first: two outcomes with known usage/cost/duration → assert the string contains each stage row's numbers and a TOTAL with the sums. Red→green. Keep it dependency-free (no table lib; pad columns manually).
- [ ] **Step 2:** In `runLinearIssue` and `runGithubIssue`, after `runStages` returns `outcomes` (before/after persisting), print the summary for human visibility: `console.log(summarizeOutcomes(outcomes))`. Place it so it prints even when no PR opened (the run still did work). Do NOT change the existing report lines.
- [ ] **Step 3:** Fan-out (`runLinearParent`, `runGithubProject`): each child already runs runLinearIssue/runGithubIssue (which now prints its own summary) — no aggregate needed for v1; leave fan-out as is. (YAGNI: per-run summaries suffice.)
- [ ] **Step 4:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: podsumowanie biegu (koszt/tokeny/czas per etap + total)"`.

---

## Task 3: Structured run-lifecycle logging

**Files:** Modify `src/core/vanguard.ts` (runAgent + prepareContext), and ensure `ctx.log` carries through.

- [ ] **Step 1:** In `runAgent`, at the start (after resolving stage inputs) emit `ctx.log.info({ taskId: ctx.taskId, stage: <stageName?> }, 'stage start')`, and at the end emit `ctx.log.info(stageMetric(result, <stageName?>), 'stage complete')`. NOTE: runAgent's `StageInput` has no stage name today — add an optional `stageName?: string` to `StageInput` and have the pipeline pass `stage.name` (pipeline.ts runBudgetedStages already iterates `stage`, so pass `stageName: stage.name` into the runAgent call and the forkAndSelect StageInput). When absent, omit `stage`.
- [ ] **Step 2:** Run-level start: in `prepareContext`, after the context is built, emit `ctx.log.info({ taskId }, 'run start')`.
- [ ] **Step 3:** SECRET SAFETY: the stage-complete log uses `stageMetric` ONLY (no finalText/diff/transcript/prompt). The existing `agent turn` debug log already logs `text` at debug level — leave it (debug, not info) but add a short comment noting it's debug-only and may contain model output. Do not log prompts or secrets anywhere.
- [ ] **Step 4:** Tests: extend `vanguard.test.ts` (or pipeline.test.ts) with a fake logger capturing calls; assert a 'stage complete' info log is emitted carrying durationMs/costUsd and NOT finalText. (Inject a logger via opts/ctx; if ctx.log isn't easily injectable, add a minimal capture by passing a custom logger through prepareContext options.)
- [ ] **Step 5:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: strukturalne logi cyklu biegu (run/stage start+complete)"`.

---

## Task 4: Cleanups

**Files:** `.gitignore`; `src/sandbox/egress-proxy-server.mjs`, `src/sandbox/egress-network.ts`, `src/sandbox/egress-proxy.ts`; `src/sandbox/llm-proxy-server.mjs`, `src/sandbox/llm-proxy.ts`, `src/sandbox/llm-proxy-rewrite.ts`; `package.json` (build copy).

- [ ] **Step 1 (.gstack):** add `.gstack/` to `.gitignore`. Commit can be folded into the final cleanup commit.
- [ ] **Step 2 (sidecars import shared logic — the bigger one):** Goal: the `.mjs` sidecars stop duplicating logic and instead `import` a shared module that is `docker cp`'d next to them.
  - Author the shared logic as plain ESM `.mjs` modules so both the TS app and the sidecar import the SAME file (no TS-only syntax): rename/convert the pure logic to `src/sandbox/llm-proxy-rewrite.mjs` and `src/sandbox/egress-allow.mjs` (extract the `allowed(host)` semantics from egress-proxy.ts). Provide a sibling `.d.mts` (or JSDoc types) so the strict-TS app keeps types when importing. Verify `tsconfig` resolves `.mjs` imports (NodeNext does; add `allowJs`/`.d.mts` only if needed).
  - `egress-proxy.ts` and `llm-proxy-rewrite` consumers import from the `.mjs` (single definition). Delete the duplicated inline copies in the `.mjs` servers; the servers `import './egress-allow.mjs'` / `import './llm-proxy-rewrite.mjs'`.
  - `startEgressEnclave` (egress-network.ts) and `startLlmProxy` (llm-proxy.ts): `docker cp` BOTH the server `.mjs` AND its shared logic `.mjs` into the container (same /tmp dir so the relative import resolves), then `node /tmp/<server>.mjs`.
  - `package.json` build: copy the new `.mjs` logic modules into `dist/sandbox/` alongside the servers (mirror the existing `.mjs` copy).
  - If converting to `.mjs` + `.d.mts` proves to fight strict TS within the time box, FALL BACK to: cp the compiled `dist/sandbox/<logic>.js` next to the server and `import './<logic>.js'`, and in dev (tsx) ensure the path resolves (resolve via the same dist path). Document whichever approach in a comment. Keep ALL existing unit tests green (the logic tests must still import the canonical module).
- [ ] **Step 3 (server byte-count log):** In `llm-proxy-server.mjs`, drop the per-chunk byte-counting `data` listener used only for the access log; derive the byte count from the upstream `content-length` header when present, else omit the byte figure. Keep the single-line access log format otherwise. (Same idea applies if egress logs bytes — it doesn't; skip.)
- [ ] **Step 4:** `pnpm build` (verify dist has the server + logic `.mjs`), `pnpm typecheck && pnpm test` green. Commit: `git commit -am "refactor: sidecary importują wspólną logikę + sprzątanie (.gstack, log bajtów)"`.

---

## Verification

1. `pnpm typecheck && pnpm test` green.
2. The metrics file now carries `durationMs`; the end-of-run summary prints a per-stage table + TOTAL; `ctx.log` emits 'run start'/'stage start'/'stage complete' (info) with no secret/prompt content.
3. SIDECAR SMOKE (the risky cleanup): rebuild the image is NOT needed (the sidecar runs the vanguard-sandbox image and `node /tmp/...`); instead verify the import-based sidecar works live: run `vanguard run --linear <throwaway> --llm-proxy` with secrets from /tmp/vg-smoke.env on a fresh clone; expect a draft PR (proving the proxy still serves Claude after the import refactor). Also a quick `--egress`-only run to prove the egress CONNECT sidecar still tunnels. Close the throwaway PR + cancel the task after.

## Self-review
- Single source: stageMetric feeds metrics.jsonl, summary, and logs — added in Task 1, consumed in 1/2/3.
- No secret/prompt in info logs (Task 3 Step 3).
- Sidecar refactor has a fallback path + a live smoke gate (Task 4 / Verification 3).
