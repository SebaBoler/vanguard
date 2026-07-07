# Task ID Parsers — resolving `<taskId>` → (Task Source, ref)

> **Status:** Draft for discussion. Author: Paweł (via Claude). Scope: Vanguard Desktop.
> **Fixes:** Spec/Board/Launch fail on real GitHub task ids — `gh-211` shows *"Couldn't infer a Task
> Source from task id `gh-211`"*. The current inference only understands `linear-*` and bare numbers.

---

## 1. Problem

Vanguard Desktop stores each Run under `.vanguard/runs/<taskId>/`. Several features must turn that
`taskId` back into a **Task Source** + a **ref** the provider runner understands:

- **Spec pane** — `gh issue view <ref>` / `linear issue view <ref>` / `glab issue view <ref>`.
- **Task board** — a card's task → source + ref → open detail / spec.
- **Launch (New run)** — derive `vanguard run --<source> <ref>`.
- **Remote / PR linking** (future).

Today `apps/desktop/src-tauri/src/spec.rs` guesses: `linear-*` → Linear, all-digits → GitHub. That is
wrong — Vanguard's real GitHub ids are `gh-…`, GitLab `gl-…`. So GitHub/GitLab specs never resolve.

## 2. Ground truth — how Vanguard mints taskIds

From the runners (authoritative):

| Source | taskId (`src/runners/*.ts`) | Underlying `task.id` | Ref to pass the CLI |
|---|---|---|---|
| GitHub | `` gh-${task.id.replace(/[^a-zA-Z0-9]/g,'-')} `` | `<owner/repo>#<number>` | **issue number** = trailing digits |
| GitLab | `` gl-${task.id.replace(/[^a-zA-Z0-9]/g,'-')} `` | `<project>#<iid>` | **iid** = trailing digits |
| Linear | `` linear-${task.id.toLowerCase()} `` | `<TEAM>-<n>` e.g. `DEV-639` | **identifier** = uppercase the part after `linear-` → `DEV-639` |
| (spec pass) | `` spec-${task.id.replace(/[^a-zA-Z0-9]/g,'-').toLowerCase()} `` | any of the above | **source lost** — see §7 |

Observations that shape the design:

- The **prefix** (`gh-` / `gl-` / `linear-`) is the source discriminator.
- The sanitiser is **lossy** (`/` and `#` → `-`), so `owner/repo#211` → `gh-owner-repo-211`, and a
  bare-ref run → `gh-211`. **Do not try to reconstruct the slug** — the repo is detected from the
  project's cwd anyway. Extract the **trailing numeric ref** for GH/GL.
- Linear is lowercased on the way in, so **re-uppercase** to recover the identifier.

## 3. Goals

- Correctly resolve GH / GL / Linear task ids to `(source, ref)`.
- **Extensible**: built-in provider parsers **plus** optional, per-project, user-defined patterns.
- **One resolver** used by every consumer — no duplicated inference scattered across features.
- Fail clearly (and actionably) when nothing matches.

## 4. Design

### 4.1 The resolver

```
resolve(taskId, projectPatterns) -> ResolvedTask | null
ResolvedTask { source: "github" | "gitlab" | "linear", ref: string }
```

Ordered, **first-match-wins**:

1. **Per-project patterns** (from `.vanguard/app.json`, §4.3) — highest priority, so a project with a
   non-standard or mixed convention can override.
2. **Built-in provider parsers** (§4.2) — the defaults above.

No match → `null` → the UI shows an actionable error (see §6).

### 4.2 Built-in parser registry (defaults)

| Source | Match (anchored regex) | Ref |
|---|---|---|
| linear | `^linear-(.+)$` | group 1, **upper-cased** (`dev-639` → `DEV-639`) |
| github | `^gh-(?:.*-)?(\d+)$` | trailing digits |
| gitlab | `^gl-(?:.*-)?(\d+)$` | trailing digits |

(No bare-number fallback — bare numbers are ambiguous across GH/GL and were the original bug. If a
project uses bare numbers, it declares a pattern in §4.3.)

### 4.3 Per-project patterns (config)

Add `taskParsers` to `AppConfig` (`.vanguard/app.json`, spec §6 config store):

```jsonc
"taskParsers": [
  // custom tracker → GitHub issue number
  { "pattern": "^JIRA-(\\d+)$", "source": "github", "ref": "$1" },
  // bare number → GitLab iid for a GL-only project
  { "pattern": "^(\\d+)$", "source": "gitlab", "ref": "$1" }
]
```

- `pattern` — a regex (anchoring recommended; the app anchors if the author omits `^`/`$`? **decision:
  do NOT auto-anchor** — authors control it, keeps behaviour predictable).
- `source` — `github | gitlab | linear`.
- `ref` — a template with `$1`…`$n` capture substitutions, plus optional case transforms
  `${1:upper}` / `${1:lower}` (Linear-style identifiers).

Evaluated in array order, **before** the built-ins. Multiple patterns per project are allowed (a repo
that mixes sources, or migrated ids).

### 4.4 Consumers (rewire to the resolver)

- `spec.rs::fetch_spec(repo, taskId)` → `resolve(taskId, cfg.taskParsers)` → dispatch by `source` to the
  matching CLI with `ref`. **Deletes the current ad-hoc inference.**
- `tasks.rs` board cards / detail — carry the resolved `(source, ref)`.
- Launch default — `vanguard run --<source> <ref>`.

### 4.5 Rust shape

New `apps/desktop/src-tauri/src/taskid.rs`:

```rust
pub struct ResolvedTask { pub source: String, pub reference: String }
pub struct TaskParser { pub pattern: String, pub source: String, pub reference: String } // from AppConfig
pub fn resolve(task_id: &str, patterns: &[TaskParser]) -> Option<ResolvedTask>;
```

`regex` crate (add dep). Built-ins compiled once (`once_cell`/`LazyLock`); project patterns compiled per
call (few, short). Unit-test the table in §2 + a couple of custom patterns.

## 5. Config schema change

`AppConfig` (Rust `appconfig.rs` + TS `vanguard-output.d.ts`) gains:

```rust
pub task_parsers: Option<Vec<TaskParser>>,   // serde: taskParsers
```

Surfaced in **Settings** as a small editable list (pattern · source · ref), plus a live "test a task id"
box that shows the resolved `(source, ref)` — so authors can validate a pattern without a round-trip.

## 6. Failure & UX

- Unresolved id → error names the id and links to Settings → *"Add a task-id pattern for this project."*
  (Replaces today's misleading *"Supported: linear-* and numeric GitHub issue ids."*)
- Invalid regex in config → **skip that entry + surface a warning**, never crash the resolver.

## 7. Edge cases

- **Sanitised GH/GL ids** (`gh-owner-repo-211`) → trailing-digit ref (`211`); repo from cwd.
- **Linear teams with digits** (`X2-15` → `linear-x2-15`) → uppercase whole → `X2-15`. Fine.
- **`spec-*` (Loop-v1 spec pass)** loses the source prefix. Options (decide): (a) treat `spec-` as a
  non-fetchable variant (no spec pane), (b) let a project pattern map it, or (c) Vanguard-side change to
  keep the source in the spec-pass id. **Recommend (a)** for now (rare, and the spec pass has no issue of
  its own), document it.
- **Regex safety**: cap pattern count (e.g. ≤ 16) and length; the `regex` crate is linear-time (no
  catastrophic backtracking), so ReDoS is not a concern.

## 8. Non-goals

- Fetching from an unconfigured/unknown source.
- Reconstructing the full `owner/repo` slug from the id (cwd resolves the repo).
- Editing Vanguard's taskId minting (that's a Vanguard-core change; out of scope unless we pick §7-c).

## 9. Phasing

1. **`taskid.rs` + built-in parsers; rewire `fetch_spec`.** Fixes `gh-211` / `gl-*` immediately. (Small.)
2. **`taskParsers` in AppConfig + Settings editor** (with the test box).
3. **Use the resolver in board + launch** (source/ref everywhere).

Phase 1 alone closes the reported bug.
