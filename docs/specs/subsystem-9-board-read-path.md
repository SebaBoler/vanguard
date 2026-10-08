# Subsystem 9 — Board Read Path → Core (one brain, finally)

**Status:** v2, review-converged (one adversarial round, 9 findings — adjudication §7)
**Kills:** `apps/desktop/src-tauri/src/tasks.rs` (396 lines — the 2nd implementation of all three
transports) and `spec.rs` (80 lines — the 3rd, for fetch). The S4 spec §Deferred enumerated the
cost; two spec reviews rejected doing it casually; this is the deliberate version, updated against
today's code (several §Deferred claims are stale — noted inline).

---

## 1. Target shape

Two new sidecar methods on `Pipe::Query`, `Bound::Timed` (remote reads, idempotent; a killed list
retried converges):

- **`listTasks { repoPath }` → `{ tasks: BoardTask[], capped: boolean }`** where
  `BoardTask = { id, title, column, state }` (a wire type — S7's `src/wire.ts` is its home, and
  the TS↔Rust `Task` mirror in vanguard-output.d.ts dies with tasks.rs).
- **`fetchSpec { repoPath, taskId }` → `{ spec: string }`** (`# title\n\nbody` exactly as today;
  richer later if the UI wants comments — core `fetch()` already returns them).

Rust: `api_list_tasks` / `api_fetch_spec` replace the transport code with `flow_request`-style
exchanges. Source/team/label are read from app.json **in the sidecar dep from `params.repoPath`**
(core already reads the same file for customProviders — the "core never reads app.json" claim
died in S6; the loader gains sibling readers `boardSource(repoPath)` etc., same lenient rules).
The Tauri command passes only `repoPath` — the renderer chooses nothing (createTask precedent).

## 2. The §Deferred costs, resolved one by one

1. **`AppConfig.project` (GitLab slug):** NOT added. Stale premise — core now has detectors:
   `detectRepoSlug` (runners/github.ts:98) and `parseGitlabProjectFromRemote` (gitlab.ts:128-137).
   The sidecar dep infers from `repoPath`'s origin remote, exactly like the Rust board and
   `create.ts` behave today. Settings UI unchanged.
2. **Flag parity / `TaskFilter.limit`:** `TaskFilter` gains `limit?: number` — **strictly
   conditional**: `limit` unset ⇒ every fetcher's argv/GraphQL variables are byte-identical to
   today (watch never sets it; gh's own 30-default on watch polls is a known, pre-existing,
   untouched cap — noted, not fixed here). When set: gh adds `-L`, glab adds `-P`, Linear caps
   `first:` and stops paginating at `limit` (today it paginates to exhaustion — up to 100 pages
   × 30s, busting the 60s query-pipe watchdog on a big team). The negative case (unset ⇒
   identical argv) is a pinned test per fetcher.
   **Board state per source (review round 1, blocking):** the dep calls `limit: 50` for all
   three, but `state: 'all'` for github/gitlab ONLY — Linear's `filter.state` is a workflow-state
   TYPE compared with `eq`; `'all'` matches nothing and would silently EMPTY the Linear board
   (today's Rust Linear query has no state filter at all). The dep omits `state` for Linear; a
   test pins that the board's Linear GraphQL variables contain no state filter. Returns
   `capped = tasks.length === limit` (FETCH_CAP banner preserved; the constant comes from the
   response, not a synced literal).
3. **Deliberate behavior change — glab state parity:** the Rust board passes `--state all` to gh
   but NOT to glab (opened-only — GitLab's Done column only ever filled via labels on open
   issues). Core's gitlab list already maps `'all'` → `--all`; the new dep passes `all` to BOTH.
   GitLab Done now populates from closed issues. Called out as intended (AC 6).
4. **Id scheme:** core `Task.id` stays `owner/repo#N` / `group/proj#N` / `DEV-639` (the CLI
   contract — untouchable). Core `Task` gains **`ref?: string`** — the provider-native short ref
   (`904`, `42`, `DEV-639`) each fetcher already has in hand. The sidecar dep mints the board id
   (`gh-904` / `gl-42` / `linear-dev-639`) from `source + ref`. **Corrected in review: this is
   NOT "the same mint the run records use"** — runners mint `gh-<sanitized full id>`
   (`gh-owner-repo-904`, runners/github.ts:34), and RunDetail's spec tab passes THAT id to
   fetchSpec. The TS resolver therefore ports `taskid.rs`'s trailing-number semantics 1:1
   (including its test table — `gh-owner-repo-211` → 211; Linear's `linear-dev-639` → DEV-639),
   so both board ids and run-record ids resolve. AC + test: `fetchSpec('gh-owner-repo-904')`
   resolves issue 904. taskid.rs audit done in review: its only consumers are spec.rs and
   tasks.rs's own tests — **taskid.rs dies** with them once the semantics are ported.
5. **State-for-column:** core fetchers start carrying provider state — gh adds `state` to its
   `--json` field list (it already threads `--state` as a filter — the draft conflated the two),
   `GitLabIssue` gains `state`, Linear's `toTask` stops dropping `state.name` (the query already
   fetches it). Core `Task` gains `state?: string`. Additive; nothing existing reads it, and
   review verified new Task fields cannot leak into prompts (taskToVariables maps explicit
   fields only; no wholesale serialization reaches prompt assembly).
6. **`column_for` moves to core TS** (`src/tasks/board.ts`): it encodes Vanguard's label
   vocabulary (`src/github-labels.ts` / `src/gitlab-labels.ts`), which lives in core — leaving it
   in Rust recreates the split-brain this subsystem exists to kill. Port the mapping + its tests
   verbatim (terminal-wins-first ordering, `has_word` whole-word matching, the state-vs-label
   fold including Linear's label-overrides-state case). **The chip ("display state") rule is
   per-provider** (review round 1 — the draft's uniform rule was wrong for Linear): github/gitlab
   show first label else provider state; **Linear always shows the workflow state**, even with
   labels present (tasks.rs:123-124, :141). The ported test table gains a labels-present Linear
   chip assertion — the existing table would not catch a uniform implementation.
7. **Error envelopes:** the four actionable Linear messages must survive. **Review corrected
   the draft's count — only ONE exists in core verbatim** (the team message, create.ts:173).
   Actual work: (a) `linearToken` catches a NON-ZERO `linear auth token` exit (today it
   propagates a raw execa error) and maps it to "Not logged in to Linear — run `linear auth
   login`."; (b) the empty-token case keeps core's wording ("No Linear credential — set
   LINEAR_API_KEY or run `linear auth login`.") — reconciled as the one message for both CLI and
   desktop (it is accurate for both; the Rust wording dies); (c) the team-probe ports into a
   core helper called BY THE BOARD DEP ONLY — **not** into the shared Linear list path (watch
   consumes list(); an unconditional probe would flip watch from idles-on-empty to
   throws-every-poll on a wrong team key — undeclared behavior change, rejected); (d) the
   no-team guard lives in the dep. All surface as in-band error envelopes; the Rust command
   unwraps verbatim (flow_request pattern). "Set a Task Source in Settings" stays the no-source
   behavior (explicit board error — do NOT adopt createTask's github default; a board silently
   reading the wrong tracker is worse than a prompt).
8. **Declared read-path deltas** (review: declare intended or fix — declared intended):
   core's gh list fetches `body` and Linear fetches `description` where the Rust board fetched
   neither — 50-issue board loads carry bodies now; accepted (no fields option added — YAGNI
   until it measures). **Repo targeting:** the Rust board relied on gh/glab cwd inference; core
   fetchers take explicit slugs, so the dep runs `detectRepoSlug` — whose regex is
   github.com-only. A GitHub-Enterprise/ssh-alias origin that works on today's board fails with
   an actionable error naming the remote ("could not detect a github.com repo from origin");
   Enterprise board support is trigger-gated. PR A also fixes the now-stale comment at
   create.ts:46-47 ("no GitLab slug detector anywhere in core" — gitlab.ts:108 exists).
9. **spec.rs rides along** (or the duplication just rotates): `fetchSpec` dep = resolve board id →
   native ref → `fetcher.fetch(ref)` → format `# title\n\nbody`. Core fetch is richer than
   spec.rs (comments, sub-issues) — v1 formats title+body only, byte-compatible with today's
   SpecPane.

## 3. What dies / stays

Dies: tasks.rs transport code + mappers + GraphQL client (~250 non-test lines) and its tests
(ported to TS where they pin vocabulary/mint semantics); spec.rs entirely; the `Task` entry in
vanguard-output.d.ts (BoardTask comes from wire via S7). Stays: TaskBoard.tsx COLUMNS array
(presentation); `list_tasks`/`fetch_spec` Tauri command *names* (renderer-compatible — bodies
become sidecar exchanges); taskid.rs iff other Rust callers exist, else dies.

Sequencing: **after S7** (wire home for BoardTask) and after S8 (independent, but keeps PRs
serial). Requires `vanguard` sidecar ≥ this version on PATH — an old binary answers `listTasks`
with unknown-method bad-request, which the board surfaces as its error state (same skew story as
listProviders; visible error, no silent misroute).

## 4. Acceptance criteria

1. Board renders identically for GitHub/Linear repos (same ids, columns, chips incl. Linear's
   always-workflow-state chip with labels present, cap banner) — pinned by porting the tasks.rs
   test table (extended per §2.6) to the TS column/mint functions. Linear board with >0 issues
   renders non-empty (the state-filter regression class, pinned).
2. GitLab board additionally shows closed issues in Done (the §2.3 deliberate change).
3. Linear on a >50-issue team: exactly one page fetched, `capped: true`, no watchdog kill.
4. `fetchSpec('gh-904')` === today's spec.rs output for the same issue (title+body format);
   `fetchSpec('gh-owner-repo-904')` (a run-record id) resolves the same issue — RunDetail's spec
   tab depends on it.
5. All four Linear error messages + no-source + no-team reach the UI verbatim.
6. `pnpm test` / desktop / cargo green; tasks.rs + spec.rs deleted; no `ureq` GraphQL client left
   in src-tauri (dependency pruned if now unused).
7. Live verification: stdio probes against the built sidecar for listTasks (github via a real
   repo — this one; linear via the real team behind `linear auth token`) and fetchSpec
   round-trip; board driven in the running app against this repo.
8. CLI untouched (no flag changes; `Task.ref`/`Task.state` additive on the core type — existing
   fetch consumers ignore them).

## 5. Test plan

Unit: column mapping table ported 1:1 from tasks.rs tests (terminal-wins, whole-word,
label-overrides-state, + the new labels-present Linear chip case); resolver ported with
taskid.rs's table (incl. sanitized run-record ids); TaskFilter.limit threading per fetcher —
BOTH directions (set ⇒ flag present; **unset ⇒ argv/variables byte-identical to today** — the
assertion that protects watch); board Linear call pins NO state filter in the GraphQL variables;
Linear pagination cap (mock pages, single page at limit); linearToken non-zero-exit mapping;
team-probe scoped to the dep (a watch-path list() never probes — pinned). Sidecar: validator
(absolute repoPath), dep dispatch per source, no-source error. Mutation: swap terminal-wins
ordering; drop the pagination cap; make the board pass state to Linear (the empty-board test
must fail). Live probes per AC 7.

## 6. Delivery note from review: PR A regenerates `apps/desktop/src/wire.ts` (BoardTask lands on
the S7 wire), mildly crossing the "core-only" framing — expected, harmless.

## 6b. Delivery

Two PRs: **A** core+sidecar (fetcher threading, board.ts, wire types, methods, deps, probes) —
merge-safe alone (nothing consumes it yet); **B** Rust swap (commands re-pointed, tasks.rs +
spec.rs deleted, d.ts pruned) + any TaskBoard adjustment (cap from response). B is where the
deletion-heavy lint risk lives — run the full gate set.


## 7. Review adjudication (round 1 — 9 findings)

Adopted: Linear `state:'all'` would silently empty the board (blocking — per-source state rule +
GraphQL-variables pin); run-record vs board mint mismatch (major — resolver ports taskid.rs
trailing-number semantics + run-record-id AC); per-provider chip rule (major — Linear always
workflow state; the ported table alone would not catch it); Linear error-message count corrected
(major — only the team message exists verbatim; linearToken gains the non-zero-exit mapping; the
empty-token wording reconciled to core's); team probe scoped to the board dep, NOT the shared
list path (watch would flip to throw-every-poll — undeclared change, rejected); conditional-limit
negative-case tests (protects watch's fetch size); §2.2 state-threading wording fixed (gh already
threads the filter; the gap is the --json field); read-path deltas declared (bodies fetched;
detectRepoSlug github.com-only limitation with actionable error; stale create.ts comment fixed in
PR A); citations corrected (gitlab.ts:108, src/*-labels.ts). Anti-findings confirmed: bare-string
glab label handling needs no port (per-fetcher shapes already handled); Task.ref/state cannot
leak into prompts; taskid.rs dies clean; old-binary skew story holds.
