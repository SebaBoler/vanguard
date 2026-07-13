# Subsystem 4 — Task write-side (`createTask`)

**Status:** spec (rescoped after two spec reviews — see *History* at the bottom; it matters)
**Predecessor:** S3 (doc editor). **Blocks:** nothing. **Unblocks:** S5 (query pipe).

Ships as **three PRs**, each standing alone:

| PR | What | Why separable |
|---|---|---|
| **4.1** | Fix `vanguard watch --linear` (a live production bug) | Core only. No app changes. Independently valuable. |
| **4.2** | Sidecar **query pipe** + the cancel fix it forces | Self-contained plumbing. Unblocks 4.3 *and* S5. |
| **4.3** | `createTask` in core + the docs-screen "Create task" button | The feature. Needs 4.2's pipe. |

---

## PR 4.1 — `vanguard watch --linear` is broken; fix it

### The bug

Verified by exit code against the installed `linear` CLI (schpet, **v1.11.1**):

```
linear issue query --json --limit 0   → exit 2   (no such command)
linear issue view  --json             → exit 0   (works)
linear auth token                     → exit 0   (works; undocumented)
```

`LinearCliTaskFetcher.list()` (`src/tasks/linear-cli.ts:101`) shells `linear issue query`. It does
not exist. The call chain `src/cli/watch.ts:97` → `src/runners/watch.ts:236,365` → `fetcher.list()`
means **every `vanguard watch --linear` run dies on its first poll.**

It is green in CI because the tests inject a fake `LinearCliRunner` — the fake cheerfully answers a
command that does not exist. **The test proves the parsing and nothing about the contract.** That is
the actual defect; the missing command is a symptom.

`tasks.rs:236` already knew: *"The schpet `linear` CLI dropped a JSON issue list — `issue list` is
human-only."* The desktop board worked around it with GraphQL. Core never got the memo.

### The fix

`list()` issues Linear's GraphQL API. `fetch()` is **unchanged** (`issue view --json` works).

**The port is not a copy of the board's query.** The board's query has no state filter and a hard
`first: 50`. `watch` needs both, and porting as-is would replace an honest crash with a silent
misbehaviour: the watcher would poll **every issue in the team regardless of workflow state**, then
claim and run any carrying the trigger label — *including already-completed ones* — capped at 50.
AC would pass while the watcher did the wrong thing. This is the trap; do not fall in it.

Required query (all of it verified live against a real workspace):

```graphql
query($f: IssueFilter, $after: String) {
  issues(first: 100, after: $after, filter: $f) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description state { name type } labels { nodes { name } } }
  }
}
```

- **State filter.** `TaskFilter.state` is already documented as a Linear state *type*
  (`triage|backlog|unstarted|started|completed|canceled` — `linear-cli.ts:97`). It maps directly to
  `filter.state.type.eq`. `watch` passes `unstarted` (or `triage` for the spec watcher,
  `runners/watch.ts:362`). **Verified:** returns only `unstarted` issues.
- **Unbounded.** Today's `--limit 0` means *all matching*. Paginate on
  `pageInfo{hasNextPage,endCursor}` until exhausted. **Verified:** `hasNextPage`/`endCursor` work.
  A watcher that silently caps its work queue is a bug.
- **Team scope.** `options.team` → `filter.team.key.eq`. Absent ⇒ no team filter (today's
  `--all-teams`).
- **Labels.** Keep the existing client-side filter (`linear-cli.ts:103`) — same behaviour, no new
  surface.

### Auth

**Not** a new `linear auth token` shell-out. `watch --linear` **already requires `LINEAR_API_KEY`**
and hard-throws without it (`src/cli/watch.ts:68`, `src/sidecar/deps.ts:27`). Core already has a
Linear token in-process on the exact command being fixed.

```
token = process.env.LINEAR_API_KEY ?? (await linear auth token)   // CLI fallback for the desktop
```

Header is the **bare token**, not `Bearer` — `linear auth login` mints a personal API key, which
Linear authorizes bare. (If the CLI moves to OAuth this must become `Bearer`. Comment it.)
**Verified live.** The token is never logged and never returned.

No new dependency: Node 24, global `fetch`, already used in core (`src/core/openrouter-pricing-check.ts:149`).

### Tests

- **T1** GraphQL list, injected transport: maps nodes; `state.type` filter reaches the query;
  pagination follows `endCursor` to exhaustion; label filter applied; team scope applied.
- **T2 — the one that matters.** Opt-in integration (`VANGUARD_LINEAR_IT=1`, skipped otherwise):
  assert the real CLI **has** `auth token` and **lacks** `issue query`. *This is the only test that
  would have caught the original bug.* A faked runner cannot, by construction.

### AC

- **AC1** `list()` never shells a command that does not exist. `watch --linear` polls a real workspace.
- **AC2** A state filter reaches the API — the watcher does not see completed issues.
- **AC3** More than one page of results is returned in full.

---

## PR 4.2 — Sidecar query pipe (+ the cancel bug it exposes)

### Why

`request()` (`sidecar.rs:76`) takes `state.proc.lock()` and holds it until the response lands. For
`api_create_run` the response **is the finished run**. So every sidecar call blocks for minutes.

`ipc.ts:115` already works around it:

> *"capabilities() is pure and never changes in a session — cache it once so a live run's held proc
> mutex (api_create_run) never blocks the New Run form's populate call."*

4.3 needs `createTask` to answer while a run is live. S5 needs live flow discovery, which it deferred
believing this required async protocol surgery. **It does not.**

### The fix: two pipes, not multiplexing

```
Sidecar {
    run_proc:   Mutex<Option<SidecarProc>>,   // api_create_run — held for a whole run
    query_proc: Mutex<Option<SidecarProc>>,   // capabilities, createTask, (S5) flows
    ...
}
```

Same `vanguard __sidecar` child, twice. No protocol change, no async reader, no multiplexing.
`request()` takes the pipe as a parameter.

### The cancel bug this exposes — do not skip this

`request()` publishes the child pid **on whichever pipe it is running** (`sidecar.rs:78-81`):

```rust
if let (Ok(mut pid), Some(proc)) = (state.child_pid.lock(), guard.as_ref()) {
    *pid = Some(proc.child.id());
}
```

With two pipes, **a query overwrites `child_pid` with the query child's pid**, and `api_cancel`
(`sidecar.rs:449`) then SIGUSR2s the *wrong process*. Consequences, all silent:

- The run does not stop. `cancelCurrent()` is a no-op when idle (`cancel.ts:22`), so the query child
  swallows the signal without a word.
- `api_cancel` sets the `cancelled` flag *before* signalling, so when the run later ends on its own,
  `resolve_terminal` mislabels its terminal **`run-cancelled` for a run that was never cancelled**.
- `request()` clears `child_pid` on **any** pipe failure (`sidecar.rs:110`) — a dead query child
  **disarms cancel for a live run**.

This fires on the happy path: a query during a run is the entire point of the split.

**Fix:** pid publication is a property of the *run* pipe, not of `request()`. Move it out of the
shared path (or key it per-pipe and have `api_cancel` read the run pid only).

**Test (blocking):** with a run in flight, issue a query, *then* cancel — and assert the **run**
child got the signal. Without this test the split ships a broken kill button.

### Also

- `list_tasks`/any new command calling `request()` must be a **sync fn with
  `#[tauri::command(async)]`** (like `api_capabilities`, `sidecar.rs:127`) — `request()` holds a
  `std::sync::Mutex` across a blocking read and must never be polled as a future or run on the main
  thread.
- `apiCapabilitiesCached` **stays** (it is load-bearing for startup) but its comment must stop
  claiming it exists to dodge the run mutex.
- Reap both children on shutdown.

**Non-goal:** concurrent queries. One query pipe, one mutex; queries are milliseconds. No pool.

---

## PR 4.3 — `createTask` + the docs-screen button

### Core

`SourceAdapter` / a `TaskCreator` seam gains:

```ts
createTask(input: { title: string; body: string; labels?: string[] }): Promise<{ id: string; url: string }>
```

Per transport — **each needs a different body-delivery mechanism**; this is not incidental:

| | Command | Body | Returns |
|---|---|---|---|
| GitHub | `gh issue create` | **`--body-file -`** (stdin — no argv limit, no escaping) | prints the URL |
| GitLab | `glab issue create` | **`-d` argv** — glab has *no* `--body-file`. `execa` passes an array so there is no shell-escaping risk, but **`ARG_MAX` applies** | prints the URL |
| Linear | **GraphQL `issueCreate`** | in the mutation body | `{ issue { identifier url } }` |

**Linear must not use `linear issue create`** — it has **no `--json`**, so its output is human prose.
Scraping an id/URL out of it is the same class of mistake as `issue query`. Verified: the
`issueCreate` mutation returns `{ success, issue { id identifier title url } }` with markdown intact.
(Verified by creating a real issue and deleting it.)

**Body size:** reject bodies over a documented cap with a clear error rather than letting GitLab's
`E2BIG` surface as noise.

### Desktop

- Doc body → issue body. First `#` heading → title. Missing heading → **refuse**, do not invent one.
- `source` + `label` from `AppConfig`, read **in Rust** — the renderer does not choose the transport
  (same rule S3 established for `chatBaseUrl`).
- Typed API method → sidecar method (**query pipe**) → Tauri command, following `apiCreateRun`'s shape.

### This is the first irreversible write from the app

- **Confirm before creating.** An explicit dialog naming the transport and the title.
- **Show the resulting URL** after creation.
- **Never create as a side effect** of anything else.
- **Creating a task does NOT start a run.** One irreversible action per button. (Recommended by the
  handoff; adopted.)
- The button is disabled while a create is in flight — guarded by a **ref**, not reducer state, which
  only updates on the next render (S3's double-send bug, `DocsScreen.tsx`).

---

## Deferred — and why (this is debt, recorded deliberately)

**The board's read path stays in Rust.** `apps/desktop/src-tauri/src/tasks.rs` remains a second
implementation of all three transports, and `spec.rs` a third (`fetch_spec` shells
`gh`/`glab`/`linear issue view`). The umbrella's "one brain, two mouths" claim **remains false for
task reads.**

Migrating the board onto core was specced, reviewed, and **rejected as its own subsystem** — not
because it is wrong, but because it is far larger than it looks:

- **`AppConfig` has no repo/project field.** `GitLabTaskFetcher` requires an explicit project; the
  Rust board never needed one (it shells `glab` with `current_dir` and lets it infer the remote).
  There is no GitLab slug detector anywhere in `src/`. This alone means a new config field + Settings UI.
- **Flag parity is a silent regression.** Core's `list()` is `--state open` with **no limit** (CLI
  default 30); the board is `--state all -L 50`. Migrating naively shows ≤30 open issues and
  **empties the Done column**, while `FETCH_CAP=50`'s banner becomes dead code. `TaskFilter` has no
  `limit` field to fix it with.
- **The id schemes differ.** `task_from_*` mint from raw provider JSON (`i.get("number")`); core's
  `Task` has no `number` (its id is `owner/repo#904`). `taskid::resolve` depends on `gh-904` exactly.
- **The board's `state` is not a state.** For gh/glab it is `labels.into_iter().next().unwrap_or(state)`
  — *the first label* (`tasks.rs:100,117`). Mapping core's real state flips every chip from
  `vanguard:running` to `OPEN`.
- **Error mapping.** `request()` returns the sidecar's error envelope as `Ok(non-result)`, not `Err`.
  Written like `api_capabilities`, every `gh`/Linear failure reaches the user as the string `no result`.
  Four actionable messages ("Not logged in to Linear — run `linear auth login`") would have to be
  ported into core.
- **A fourth fetcher.** `GitHubProjectFetcher` also `implements TaskFetcher` and has no state source.
- **It would not even finish the job** while `spec.rs` stands — the duplication would merely move from
  split-by-verb to split-by-verb-the-other-way.

**Prerequisite for anyone picking this up:** it needs `AppConfig.project`, `TaskFilter.{state,limit}`,
an id-scheme decision, an error-envelope contract, and `spec.rs` in the same subsystem. Not a warm-up.

---

## History (kept on purpose)

The first draft of this spec proposed doing the board migration *first*, as a "contained refactor". Two
parallel spec reviews (feasibility + design-gap) found it **unbuildable as written**: it would have
shipped a **broken cancel button** (the `child_pid` bug above, which the draft's "unchanged" list
actively told the implementer not to look at), a **new silent watcher bug** (the state-filter drop),
and a board migration whose true cost is listed under *Deferred*. It also asserted "Linear token
handling already lives in core" — **false**; core never touches a Linear token.

Recorded because the lesson generalises: three separate bugs this session — the `.gitignore` fixture,
`linear issue query`, and this spec — were all *green tests that proved nothing about reality*.
Prefer one test that touches the real contract over ten that touch a fake.
