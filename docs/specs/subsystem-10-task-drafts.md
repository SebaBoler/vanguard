# Subsystem 10 — Task drafts: kill the Docs page, task-first authoring

**Status:** v2 (post adversarial review — 3 lenses, 20 findings; adjudication in §8)
**Driver feedback (Paweł, 2026-07-14, dogfood round 1):** the Docs page is not what was called
for. "New doc" can be clicked indefinitely, minting `note-N.md` files that cannot be removed from
the UI. The Docs page should not exist. The flow is: task board → button **"New Task"** → a page
scoped to that one new task, with a chat sidebar that (like the VS Code Claude Code Chat
extension) lists multiple chats and lets me pick which one to continue. The Runs page's "New run"
button (with its provider selection) was supposed to BE this "New Task" button — same button on
both pages. Parameterized run-starting is for power users and bots via the CLI, not the desktop.

## 1. Decisions (adjudicated with the user)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Where drafts live | Local, repo-scoped — `<repo>/.vanguard/drafts/`, **self-gitignored**: `drafts.rs::write` drops a `.gitignore` containing `*` into the dir when creating it. The repo's root ignore CANNOT be relied on — S5.1 made `.vanguard/flows/` a committed artifact, so user repos track `.vanguard/`, and chat transcripts (pasted stack traces, config, secrets) must never ride a `git add -A` into a PR. NOT in the task transport: GitHub has no draft-issue concept, Linear drafts are not exposed over its public API, GitLab likewise. |
| D2 | Draft fate after the task is filed | **Auto-archive.** The draft moves to an "Archived" section of the sidebar with a link chip to the created issue. Recoverable, out of the way, nothing vanishes. |
| D3 | How runs start | **Board → TaskDetail → New Run only.** The Runs screen becomes observational; its toolbar "New run" button (and the provider-selection form it opened from the toolbar) is replaced by "New Task". `NewRunForm` remains reachable solely via TaskDetail. |
| D4 | Old `.vanguard/docs/*.md` files | Abandoned in place, not migrated. Nothing reads them after this change; the user deletes them by hand (all 29 in the driving repo verified to be pristine `# note-N` templates). |

## 2. The draft model

One draft = one JSON file: `<repo>/.vanguard/drafts/<id>.json`.

```jsonc
{
  "body": "# Fix the fleet flicker\n\n...",   // the markdown the user edits
  "chat": [ { "role": "user", "content": "..." }, ... ],  // persisted transcript, RAW
  "archived": false,
  "created": { "id": "gh-123", "url": "https://..." },     // present once filed (⇒ archived)
  "updatedAt": "2026-07-14T12:00:00.000Z"
}
```

- **Id:** `draft-<Date.now().toString(36)>-<4 random base36 chars>` — the random suffix kills
  the same-millisecond cross-window collision (review G4). Minted **synchronously in a ref at
  the first persist-triggering event** (first non-empty body edit or first chat send); both the
  debounce path and the immediate chat path read that ref, so one draft can never split across
  two ids (G4). Rust validates written ids against `^[a-z0-9-]+$` and appends `.json` itself.
- **One file, not two.** Body + chat + meta travel together; a filed draft's re-file protection
  and its transcript cannot diverge.
- **`chat` stores the RAW assistant reply, `<doc>` block included** (G9). The
  "(proposed a document revision)" placeholder is derived at render time via `extractDoc`. A
  proposal pending accept/reject is NOT restored as pending on resume — the affordance is
  session-only — but the proposed content is in the transcript, not destroyed.
- **Title** is derived, never stored: first `# ` heading of `body` (existing `titleFromDoc`) —
  the sole source for the filed issue title. Sidebar display falls back to the first user chat
  message (truncated) before "Untitled", so chat-first drafts stay distinguishable (G10); rows
  also show `updatedAt` as relative time (its consumer — ordering itself stays mtime).

### 2.1 Rust storage seam (`drafts.rs`, replacing `docs.rs`)

Rust stays dumb — raw strings in, raw strings out; the webview owns the JSON shape. Same
flat-dir, no-traversal discipline as the deleted `docs.rs`, with four deliberate deviations
(review G2, G3, G11, G12):

```rust
pub fn list(repo: &Path) -> Vec<String>;                       // ids (no extension), mtime desc
pub fn read(repo: &Path, id: &str) -> Result<String, String>;  // raw JSON
pub fn write(repo: &Path, id: &str, content: &str) -> Result<(), String>;
pub fn delete(repo: &Path, id: &str) -> Result<(), String>;    // missing file ⇒ Ok (idempotent)
```

1. **`write` is atomic:** write `<id>.json.tmp`, then rename over `<id>.json`. A torn write
   must not degrade a filed draft (body + transcript + created-link, all in one file) to
   unreadable. `list` excludes `.tmp` files. `write` also ensures `drafts/.gitignore` (D1).
2. **Lenient list/delete, strict write.** `list` returns every `*.json` stem it finds; `read`
   and `delete` accept anything `list` could have returned, gated only by the docs.rs-style
   safe-name rule (non-empty, no `/`, `\`, `..`); only `write` enforces `^[a-z0-9-]+$` (ids we
   mint). A hand-made `My Draft.json` must be visible and deletable, or we've rebuilt the
   un-removable-file bug for a different input class.
3. **Symlink refusal:** if `<repo>/.vanguard/drafts` exists and is a symlink
   (`fs::symlink_metadata`), every operation errors — a cloned repo must not redirect draft
   writes/deletes outside the checkout.
4. `list` orders by mtime descending (rename sets mtime at save — coherent).

Tauri commands `list_drafts` / `read_draft` / `write_draft` / `delete_draft` replace
`list_docs` / `read_doc` / `write_doc`, which are **deleted** along with `docs.rs`. Tauri
commands are app-internal — the frozen public contract is the CLI, which this does not touch.

**Webview-side parsing:** an unparseable draft file appears in the sidebar as
`<id> (unreadable)`, selectable only for deletion — never silently dropped. A parseable draft
whose `created.url` is not `http(s)` (or whose `created.id` is not a short printable string) is
treated the same way: drafts can arrive committed inside a cloned repo, and a `javascript:` URL
must never reach the link chip (G12).

**Watcher:** `watch.rs` stops forwarding events for paths under `.vanguard/drafts/` — autosave
would otherwise drive a `vanguard:changed` → `listRuns`/`listActive` refresh loop at typing
cadence (G13). Nothing on the Runs/board screens derives from draft files.

## 3. Screens and navigation

### 3.1 The Docs page dies

- `'docs'` leaves the `Screen` union, the Rail `NAV` list, and `SCREEN_LABEL`.
- `DocsScreen.tsx` (+ its tests) is deleted. Its parts are reused, not rewritten:
  `DocEditor`, `ChatPane`, `ChatMessage`, `CreateTaskDialog`, `docTask.ts`, `useDocChat.ts`
  move from `features/docs/` to `features/task/` (git mv; imports updated).

### 3.2 The New Task screen (`features/task/TaskDraftScreen.tsx`)

A new `Screen` value `'task'` (breadcrumb label "New Task"). Deliberately **not** in the Rail:
it is reached by intent (the button), and existing drafts are reached from inside it; the
breadcrumb is the location anchor. Layout is the DocsScreen skeleton with the doc list replaced
by the drafts sidebar:

```
┌ drafts sidebar ─┬── editor (DocEditor) ──┬─ chat (ChatPane) ─┐
│ [+ New draft]   │                        │ [Create task]     │
│ ● current…      │  # Fix fleet flicker   │ …transcript…      │
│   older-draft   │  …                     │ [input] [send]    │
│ ── Archived ──  │                        │                   │
│   gh-123 ↗      │                        │                   │
└─────────────────┴────────────────────────┴───────────────────┘
```

- **Entry semantics (G8):** an explicit New Task click (either button) always lands on a fresh,
  unsaved draft — empty editor, empty chat, no file on disk. The screen remembers its last
  selection for the session, so returning to it by any other means (e.g. after a Settings
  detour) restores the draft the user was on. Only the button forces fresh.
- **Sidebar** lists drafts newest-first (title → first chat message → "Untitled", plus relative
  time), with an Archived section below (collapsed when empty). Clicking one loads its body +
  chat and continues — the multiple-chats model of the VS Code Claude Code Chat extension.
- **Archived drafts are fully read-only** (G6): editor read-only, chat input disabled, Create
  task blocked (the issue exists — refiling is the duplicate-issue bug S4 defended against).
  They keep the link chip plus two affordances: **Duplicate as new draft** (copies body +
  transcript into a fresh unarchived draft with no `created` field — the "now the follow-up
  task" workflow, without weakening the re-file guard) and delete.
- **Delete** (per-draft, small confirm popover): removes the JSON file. Deleting the open draft
  falls back to a fresh one, and that fallback does **not** flush (G2): delete cancels the
  draft's pending debounce timer and is queued behind any in-flight write of that id (§3.3's
  per-draft queue), so the delete always wins and the file cannot resurrect.

### 3.3 Persistence protocol (the 29-notes fix, hardened)

No file exists until there is something to save: the first non-empty `body` edit or the first
chat send mints the id (§2) and writes the file. The `note-N` scheme, `newDoc()`, and
mint-on-click are deleted outright. From then on:

- **Debounce coalesces body keystrokes ONLY** (800 ms, flush on blur and on draft-switch).
  **Everything else — chat turns, accepted proposals, the archive flip, the created-link
  write — is written immediately and awaited** (G5): those are the writes whose loss crosses a
  process boundary (a crash after createTask succeeded must not leave a re-filable draft, G7).
- **Writes carry data snapshots taken at the triggering event, are serialized per-draft through
  a promise chain, and an immediate write supersedes the armed debounce for its id** (G14,
  revised by PR review r2): the original "read state at fire time" rule aliased live component
  state — a draft switch inside the debounce window repointed the shared ref before the flushed
  write's microtask ran, serializing the incoming draft's state into the outgoing draft's file.
  Snapshots cannot alias (re-arming on every keystroke keeps them current); the supersede rule
  keeps an older body snapshot from landing after a newer immediate write. Inversions stay
  impossible: the whole-JSON model makes any inversion total (it would flip `archived` back to
  `false` and erase `created`). The writer instance captures `repoPath`, so a flush after a
  project switch still targets the old repo.
- **Persistence is keyed by draft id, not by selection.** The generation guard (carried from
  DocsScreen) governs what RENDERS, never what persists (G1 — the review's central finding,
  found independently by all three lenses): a create or completion resolving after a draft
  switch still writes to the draft it was issued for, via a read-modify-write of that id
  through its queue. Concretely: a late chat reply is appended to the originating draft's file
  (no dangling user turn on resume, G15) while the on-screen dispatch is still dropped; a
  create success writes `created` + `archived: true` to the captured id regardless of current
  selection, screen, or unmount.
- **Every switch path runs the same routine** (G16): sidebar click, delete-fallback, AND the
  New Task nonce reset all flush the pending save (delete-fallback excepted), bump the
  generation, zero `inFlight`/`createInFlight`, and clear create-UI state — the nonce path must
  not become a second, unguarded switch mechanism.
- The remaining DocsScreen guards carry over as-is: `inFlight` ref on send, `createInFlight`
  ref + confirm dialog on Create task, read-only editor while a proposal is pending.

**Close/quit protocol (G3):** the nav guard's synchronous `confirm()` cannot await a flush.
TaskDraftScreen registers an async flush hook for the lifetime of the screen (the flush is a
no-op when nothing is pending — cheaper and less racy than register/unregister churn per
keystroke); on `onCloseRequested` App prevents the close, awaits the flush (bounded, 2 s), then
closes programmatically. Chat turns and archive writes are already awaited at write time, so the only
state at risk is ≤800 ms of body keystrokes. **Accepted limitation:** macOS Cmd+Q does not
reliably emit close-requested; the maximum loss there is those same ≤800 ms of keystrokes —
never a chat turn, never an archive flip. AC4/AC8 are worded to match this mechanism.

### 3.4 The buttons

- **Task board toolbar:** new header row with primary button **"New Task"** → `onNewTask()`.
- **Runs toolbar:** the "New run" button (Play icon, provider form) is **replaced** by the same
  **"New Task"** button. `showNewRun` and its idle-check gating remain, but only TaskDetail's
  `onNewRun` can set it — the toolbar path is gone.
- Both buttons call the same App-provided `onNewTask`, which routes through `navigate()` (nav
  guard) to `setScreen('task')` and bumps a nonce; the nonce reset runs the full switch routine
  (§3.3) before selecting a fresh draft.

### 3.5 Create task from a draft

Mechanically unchanged (S4 seam: `apiCreateTask` → sidecar `createTask`): same title/body byte
caps enforced before the click, same source-unknown blocking, same confirm dialog, same
ambiguous-failure wording. New:

- On success, `created` + `archived: true` is written **immediately, awaited, keyed to the
  draft id captured at click time, outside the generation guard** (G1/G7). Only the chip/dialog
  UI follows the guard.
- If the issue was created but the archive write fails, the UI says so explicitly — "the issue
  WAS created (<id>); the draft could not be archived — do not re-file" — and the in-memory
  state stays archived (G7).
- A chat completion in flight when the archive lands is appended to the file once (id-keyed
  write, §3.3), then the draft is frozen (G6).
- Success adds an in-app affordance next to the link chip: **Open board** — navigates to the
  board screen, where the run starts (D3); the filed-task funnel must not dead-end at an
  external URL (G17).

## 4. What does NOT change

- CLI: nothing. Sidecar protocol: nothing (chat still `apiComplete`; create still `createTask`).
- `NewRunForm`, `startTypedRun`, the single-in-flight guards: untouched — only the toolbar
  entry point is removed. TaskDetail's New Run behaves exactly as today.
- Credentials posture: chat model/baseUrl still resolved Rust-side from `app.json`; the webview
  still never sees or picks a credential destination (`CompleteParams` allowlist).
- `MAX_BODY_BYTES` / `MAX_TITLE_BYTES` / `titleFromDoc` / transport gating: reused as-is.

## 5. Acceptance criteria

1. No Docs entry in the Rail; `'docs'` is not a `Screen`; `DocsScreen` and `docs.rs` are gone.
2. Board and Runs toolbars each show "New Task"; the Runs toolbar has no "New run"; the provider
   form is unreachable except via TaskDetail.
3. Clicking New Task N times writes **zero** files; typing one character (or sending one chat
   message) writes exactly one draft file; typing then sending within the debounce window still
   writes exactly one file (one id).
4. Quit-and-relaunch mid-conversation loses at most the last ≤800 ms of body keystrokes — never
   a chat turn: the draft is in the sidebar with its full transcript (raw replies, `<doc>`
   content included), and picking it continues the chat.
5. Create task on a draft ⇒ issue filed once (existing guards); `created`+`archived` reach the
   draft's file even if the user switched drafts/screens mid-create; archived drafts cannot be
   re-filed, their chat is disabled, and Duplicate-as-new-draft yields a filable copy.
6. Every draft — unreadable, bad-`created.url`, or hand-named — is visible in the sidebar and
   deletable from it.
7. Deleting a draft removes its file **permanently**: a pending debounce or in-flight write for
   it cannot resurrect it; deleting the open draft lands on a fresh draft; delete of a missing
   file succeeds.
8. A stale write can never regress a draft: after edit→create→archive, a late debounced body
   snapshot does not flip `archived` or drop `created`.
9. Draft autosaves do not trigger the `.vanguard` watcher refresh loop.
10. `cargo test` covers drafts.rs: traversal/name rejection on write, lenient list/delete,
    atomicity (no partial file at `<id>.json`; `.tmp` not listed), `.gitignore` self-seeding,
    symlink refusal, list order, roundtrip, idempotent delete, missing dir.

## 6. Test plan

- **Rust (`drafts.rs`):** everything in AC10.
- **Desktop (Vitest):** TaskDraftScreen — lazy creation (N clicks ⇒ no writes; first edit ⇒ one
  write; edit+send in one window ⇒ one id); delete cancels pending debounce (type → delete →
  advance timers ⇒ no write); create → switch draft mid-flight ⇒ file archived with `created`
  (G1's test); stale-snapshot ordering (G14's test); raw reply persisted, placeholder derived
  (reload restores `<doc>` content); archived: chat disabled, re-file blocked, duplicate works;
  unreadable + bad-url drafts listed delete-only; generation guard on fast draft switch and on
  the New Task nonce (ports of the DocsScreen tests); sidebar title fallback. Board/Runs
  toolbar: New Task present, New run absent, TaskDetail path still opens the form.
- **Reality check (dogfood):** create draft → chat → file to this repo's real board → archived
  chip + Open board; relaunch → transcript survives; window close mid-type → flushed.

## 7. Non-goals / recorded follow-ups

- **Collapsing NewRunForm to defaults-from-app.json** (one-click run from TaskDetail, params
  behind an Advanced expander) — the "params are for power users" half of the driving feedback.
  Deliberately not folded into S10 (run semantics, not authoring); queued as the S11 candidate,
  **pending driver sign-off**, asked in the dogfood thread.
- Multi-window editing of the SAME draft is out of model: last-writer-wins per save. The id
  entropy prevents cross-window id collisions; concurrent same-draft sessions are not defended.
- Draft search/rename, cross-repo drafts, transport-side drafts (D1), migration of old docs (D4).
- Editing an archived draft's body in place (read-only is deliberate; Duplicate covers reuse).

## 8. Review adjudication (v1 → v2)

Three review lenses (correctness/concurrency, UX-intent, security/data-loss), 20 findings, no
relitigation of D1–D4. All accepted except where noted:

| G | Finding (deduped across lenses) | Disposition |
|---|--------------------------------|-------------|
| G1 | Gen-guarded create drops the archive write on draft switch → re-filable filed draft (found by all 3 lenses; 2× blocking) | Accepted — §3.3/§3.5: persistence id-keyed, guard renders-only |
| G2 | Delete + flush-on-switch resurrects the deleted file (blocking) | Accepted — §3.2: cancel timer, no fallback flush, delete queued last |
| G3 | Sync nav guard can't await a flush; Cmd+Q bypasses close-requested (blocking) | Accepted — §3.3 close protocol; loss bound documented; ACs reworded |
| G4 | Id mint unanchored (two paths → two ids); ms-granularity collision | Accepted — §2: synchronous mint ref + entropy suffix |
| G5 | Chat turns must not share the keystroke debounce | Accepted — §3.3: immediate + awaited for non-keystroke writes |
| G6 | Archived-draft chat behavior unspecified | Accepted — fully read-only; in-flight reply appended once |
| G7 | Crash between createTask success and archive write → cross-session duplicate path | Accepted — immediate awaited write + explicit failure copy |
| G8 | No way back to a draft except a button that resets to fresh | Accepted — session memory for last selection; button-only fresh |
| G9 | Pending `<doc>` proposal content destroyed on relaunch (placeholder persisted) | Accepted — raw replies persisted, placeholder derived at render |
| G10 | Chat-first drafts all render "Untitled" | Accepted — first-chat-message fallback + relative time |
| G11 | Strict id regex makes hand-named files unlistable or undeletable | Accepted — lenient list/delete, strict write |
| G12 | `created.url` from disk is untrusted (`javascript:`); drafts dir symlink | Accepted — url scheme check; symlink refusal |
| G13 | Autosave feeds the `.vanguard` watcher → refresh churn at typing cadence | Accepted — watcher skips `drafts/` |
| G14 | No write-ordering rule; stale snapshot can un-archive | Accepted — fire-time state + per-draft serial queue |
| G15 | Late reply dropped → persisted transcript ends on a dangling user turn | Accepted — id-keyed append, UI drop stays |
| G16 | Nonce reset bypasses the switch routine's invalidation | Accepted — one switch routine for all paths |
| G17 | Filed-draft flow dead-ends at an external link | Accepted — "Open board" affordance |
| G18 | Atomicity claim contradicted "mirrors docs.rs exactly" (2 lenses) | Accepted — tmp+rename specified (part of G-atomic, §2.1) |
| G19 | `updatedAt` stored but unconsumed (two recency sources) | Accepted — displayed as relative time; ordering stays mtime |
| G20 | Provider form remains the sole desktop run path — feedback half-addressed with no committed next step | Partially accepted — recorded as S11 candidate pending driver sign-off (§7); folding form changes into S10 rejected as scope creep on run semantics |

### PR review (v2 → shipped)

| R | Finding (PR #349) | Disposition |
|---|-------------------|-------------|
| R1-1 | Selection-scoped chat guard bypassed by switch-away-and-back → duplicate persisted assistant turn | Accepted — per-id in-flight set; reopening re-presents busy |
| R1-2 | Unreadable mtime silently hides a draft from list() | Accepted — UNIX_EPOCH fallback, lists last |
| R1-3 | Leaf-only symlink check misses a committed `.vanguard` parent symlink | Accepted — both components checked |
| R2-1 | **Blocking:** debounce thunk aliased the shared draft ref — a switch inside the window wrote the incoming draft's state into the outgoing draft's file | Accepted — data snapshots (call site + defensive copy), immediate writes supersede the armed debounce; G14 wording revised |
| R2-2 | Writer chains map grows unboundedly | Accepted — settled tails pruned |
| R2-3 | Transcript markdown could smuggle `javascript:` links from a committed draft | Verified safe (react-markdown 10 defaultUrlTransform, no rehype-raw) and pinned with a test |
