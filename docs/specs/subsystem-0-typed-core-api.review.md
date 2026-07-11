# Review — Subsystem 0: Typed Core API (Node sidecar)

**Reviews:** [`subsystem-0-typed-core-api.md`](./subsystem-0-typed-core-api.md)
**Reviewer:** coding agent (pi), verified against the current tree
**Date:** 2026-07-11
**Verdict:** Architecturally sound and well-scoped, but contains a few factual errors and real design gaps that will cause rework during implementation. **Ship after fixing the items in sections B and C.**

The core thesis — an optional `onEvent` seam, pure capability functions, a stdio sidecar — is the right shape, and the back-compat invariant is correctly designed. Most line anchors check out. But several claims about the *current* code are wrong, and they undermine specific design decisions.

All findings below were checked against the source.

---

## A. Factual inaccuracies (anchors / claims vs. reality)

### 1. There are five flow builders, not three

The spec says "the three flow builders (`implementReviewSimplifyStages`, `planImplementReviewStages`, `planImplementAdversaryStages`)". Actually exported from `src/pipeline/pipeline.ts`:

| Builder | Reachable from `run`? |
|---|---|
| `implementReviewSimplifyStages` (:452) | ✅ default (`adapter.stages()`) |
| `planImplementReviewStages` (:702) | ✅ via `--plan` |
| `fastStages` (:437) | ❌ library-only |
| `generateEvaluateRepairStages` (:776) | ❌ library-only |
| `planImplementAdversaryStages` (:826) | ❌ only via `review-pr` / `review-mr` |

Registering `default` + `plan` in v0 is correct for *reachable* flows, but the prose mischaracterizes the set. The adversary flow is reachable today only through **different** commands (`vanguard review-pr` / `review-mr`), not `run`. If the flow registry is meant to unify these, say so; if it is run-only, mark `planImplementAdversaryStages` out of scope for v0.

### 2. `--flow` does not exist today

The spec calls the flow registry "the name registry `--flow` and the UI dropdown read from", implying `--flow` is current. It isn't — `grep` for `flow` in `src/cli/` finds nothing. Flow selection today is the **`--plan` boolean**:

```ts
const baseStages = deps.plan === true ? planImplementReviewStages() : adapter.stages();
```

Introducing `--flow` is additive (allowed), but the spec must reconcile `--flow default|plan` with the existing `--plan` flag — do they alias, does `--plan` deprecate, or do they conflict? Unaddressed; this will be the first question at implementation time.

### 3. Minor anchor drift

- `runSourcedIssue` is at **:210** (spec: 213)
- `console.log(summarizeOutcomes)` is at **:290** (spec: ~295)

All the major anchors are correct: `runBudgetedStages:219`, `runStages:389`, `STAGE:17`, `RunOptions:38`, `RunIssueDeps:103`, `RunIssueResult:164`, `PROVIDER_NAMES:159`, and all three named flow-builder lines.

---

## B. Real design gaps

### 4. The cost cap is `Infinity` in the run path — `usdCap` is fiction  ⚠ highest priority

The `cost` event carries `{ usdSpent, usdCap }` and the capability defaults list "cap $5". But `runSourcedIssue` calls **`runStages`**, the unbudgeted wrapper:

```ts
// pipeline.ts:389
export async function runStages(...): Promise<StageOutcome[]> {
  const result = await runBudgetedStages(ctx, stages, { ...opts, maxCostUsd: Number.POSITIVE_INFINITY });
  return result.outcomes;
}
```

So `spentUsd` accrues but `maxCostUsd === Infinity` — there is no $5 cap, and there is **no CLI cost flag at all** (`grep` for cost/budget/cap in `args.ts` is empty). The $5 default lives only inside `runBudgetedStages`'s own fallback, which `runStages` bypasses.

**Fix — pick one:**

- (a) Switch `runSourcedIssue` to call `runBudgetedStages` with a real cap (behavior change; needs a flag/default decision), **or**
- (b) State explicitly that `usdCap` is advisory and may be `Infinity` / omitted in v0, and drop "cap $5" from the defaults table.

The spec currently asserts a cap that does not exist in this code path.

### 5. The repair loop is invisible to the event model

`runSourcedIssue` runs a conformance/verify repair loop (source-adapter.ts ~:300–340) that calls **`runAgent` directly**, not `runStages`. The proposed `stage-start` / `stage-end` events fire only inside `runBudgetedStages`, so every repair iteration — a meaningful, potentially multi-pass lifecycle event — emits nothing. The same applies to the visual-proof and verification steps.

This also weakens acceptance criterion #3 ("a `stage-start`/`stage-end` pair per pipeline stage"): true for the `assembleReviewPipeline` stages, silent on repair. Either:

- Add a `repair` / `replan` event type and emit from the loop, **or**
- Explicitly scope the v0 event set to "assembleReviewPipeline stages only" and note the repair loop is unobservable until a later subsystem.

### 6. `cancelRun` has no plumbing

The spec says cancel "maps to sandbox teardown", but `runSourcedIssue` accepts no `AbortSignal` and never threads one. `RunStagesOptions.signal` exists and `runBudgetedStages` honors it — but nothing connects the top. Cancel requires threading `signal` through `RunIssueDeps` → `runBudgetedStages` **and** the repair-loop `runAgent` calls **and** `prepareContext` / `publishForReview`. The spec discusses `onEvent` threading in detail and omits `signal` entirely, yet lists `cancelRun` as a v0 method.

Either add the `signal` thread to the spec, or descope `cancelRun` to a later subsystem.

### 7. `run-end` does not mirror `RunIssueResult`

`RunIssueResult` is `{ task, prUrl?, secretBlocked? }` — no `partial`, no `reason`. The spec's `run-end` adds `partial?` and `reason?`. The `partial` state (`const partial = !gatePassed`) is a **local** in `runSourcedIssue`, baked into the PR body, never returned. To emit it you must either:

- Widen `RunIssueResult` with `partial` (preferred — useful to the CLI too), **or**
- Re-derive `gatePassed` in the event layer.

"Mirrors `RunIssueResult`" is inaccurate as written.

---

## C. Under-specification

### 8. `createRun` params is an unnamed "projection"

`RunOptions` has ~15 fields: `reviewModel`, `noSimplify`, `verifyCmd`, `visualProofCmd`, `conformance`, `conformanceModel`, `commitAuthor` (white-label), `plan`, `baseBranch`, `maxTurns`, `maxRepairIterations`, `specFile`, `reviewGate`, `forkN`, `reuse`. The example shows 4. The wire contract needs an explicit v0 allowlist — otherwise "typed projection" means "whatever the implementer picks." At minimum, state which of {white-label/`commitAuthor`, `conformance`, `specFile`, `reviewGate`, `forkN`} are in v0 vs. deferred.

### 9. Error kinds vs. reality

`error.kind ∈ { budget | secret-block | fetch | internal }`:

- **`budget`** — cannot occur today (Infinity cap; see #4). Either remove or make it contingent on #4's fix.
- **`secret-block`** — exists (`return { task, secretBlocked: true }`), but that is a **successful `result`**, not an error, in the current model. Decide: is a secret block a `result` (current) or an `error` (new)? The `run-end` event includes `secretBlocked?`, implying result; the error-kind list implies error. Pick one.
- **`fetch` / `internal`** — fine.

### 10. `Finding` already exists — anchor it

`src/structured/findings.ts` exports `Finding` (`severity: low|medium|high|critical`, `kind: security|perf|correctness|style`, `title`, `evidence`) and `extractFindings()`, already used by `src/pipeline/review-publish.ts`. The `verdict` event should **reuse** these, not "parse once, emit typed" as if it were net-new. State the reuse explicitly so the implementer doesn't reinvent it.

---

## D. Nits / edge cases

- **11.** `reason?` appears on both `run-end` (success-ish terminal) and `error` (with `kind`). Clarify which carries terminal diagnostics to avoid two overlapping channels.
- **12. Sidecar teardown on ungraceful exit.** "Tauri owns the process lifecycle (kill on exit)" — but a SIGKILL'd sidecar (app crash) skips `runSourcedIssue`'s `finally` blocks, orphaning the Docker sandbox and provider proxies (`startProviderProxies`). Worth one line on best-effort cleanup or a watchdog, since today the CLI's own process exit handles this implicitly.
- **13.** Acceptance #4 ("malformed request yields an error line, not a crash") is good — add: stdin EOF and partial (non-newline-terminated) lines also yield a clean error / ignore, not a hang.
- **14.** Criterion #2 ("byte-identical stdout … regression test around `summarizeOutcomes` path") — make explicit that the sidecar path must **keep** the `console.log(summarizeOutcomes(outcomes))` line. The spec says "stays" in prose; the acceptance test is where the guarantee lives.

---

## What's good

- **Architecture is right.** Same core, two fronts; stdio over HTTP for a single consumer; hidden `__sidecar` keeping the CLI contract frozen — all correct calls with correct rationale.
- **Back-compat invariant is well-formed and testable** (`onEvent === undefined` ⇒ byte-identical). This is the load-bearing claim and it is stated precisely.
- **Capability surface as pure functions** is clean and correctly identified as the Subsystem-1 dependency.
- **Reusing the Docker-sandboxed pipeline** (sidecar as caller, not reimplementation) avoids a new privilege path — good and correctly noted.
- Most anchors are accurate, which means the spec was written against the real code.

---

## Recommended edits before implementation planning

Ordered by impact:

1. **Resolve the cost-cap contradiction (#4):** switch to `runBudgetedStages` with a real cap, or mark `usdCap` advisory. Highest priority — it invalidates a core event field.
2. **Decide repair-loop visibility (#5):** add a `repair` event, or explicitly exclude it from v0.
3. **Add `signal` threading to the spec alongside `onEvent` (#6)**, or descope `cancelRun`.
4. **Widen `RunIssueResult` with `partial`** or stop claiming `run-end` mirrors it (#7).
5. **Enumerate the `createRun` v0 param allowlist (#8)** and fix the secret-block result-vs-error ambiguity (#9).
6. **Fix the "three flow builders" claim (#1)** and reconcile `--flow` (new) with `--plan` (existing boolean) (#2).

Items 1–4 are the ones that will cause rework if left unresolved; the rest are precision fixes.
