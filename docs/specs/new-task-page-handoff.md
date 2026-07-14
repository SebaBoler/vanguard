# New Task page — design handoff

Status: v3 — APPROVED FOR IMPLEMENTATION (driver answered all open questions, 2026-07-14).
Supersedes the S10 three-column layout of `TaskDraftScreen`. Persistence layer (`draftStore.ts`
write machinery, `drafts.rs`) is untouched — this is a presentation restructure plus two additive
draft fields.

Reference mockups (checked in): `docs/design/screens/new-task-editor.png` (drawer closed),
`new-task-editor-sidebar.png` (drawer open, conversation tab), `new-task-editor-created.png`
(filed/archived state).

## 1. Shape

- **Full-page editor.** Centered column (~max-w-3xl) owning the whole content area when the
  drawer is closed.
- **Page header:** active conversation's title + relative time (left); `[Create task]` primary +
  `[Chat]` toggle (right). Filed drafts swap in a `filed as #<id>` chip and
  `[Open board] [Duplicate]`.
- **Right drawer (~380px, push panel)** with a browser-style **tab strip**:
  - Tab #1: **History** — pinned, icon-only (clock), never scrolls out, not closable.
  - Tabs #2…n: **open conversations** — truncated label + close ×, region horizontally
    scrollable, `[+]` at the end starts a fresh conversation.
- Below the strip: History tab ⇒ full drafts list; conversation tab ⇒ transcript + composer
  (textarea, model selector bottom-left, Send bottom-right).

One conversation == one draft (S10 model unchanged: one JSON = `{body, chat, meta}`). **Tabs are
the open set; History is the full set.** History row click opens/focuses that draft's tab; closing
a tab never touches the file.

## 2. Tab semantics

- **Editor binding:** editor always shows the ACTIVE conversation's body. Activating History does
  NOT change the editor. Zero open tabs ⇒ fresh unsaved draft (`activeId === null`).
- **Fresh tab:** the unsaved draft renders as an active "New task…" tab. It exists only while
  active and joins `openTabs` when the first edit/send mints its id (lazy mint preserved: N `[+]`
  clicks write zero files). `[+]` while already fresh = no-op focus.
- **Open:** History row click → focus existing tab else append + focus. App-level "New Task"
  (board/runs) → navigate here, drawer open, fresh conversation.
- **Close ×:** removes the tab only; flush via `switchTo`. Active close focuses left neighbor,
  else fresh state. A tab with a turn in flight may close — the reply lands id-keyed (S10
  late-reply path).
- **Delete (History):** two-step confirm as today; also closes the tab if open. Unreadable drafts
  are delete-only rows — never openable as tabs (the editor's unreadable branch dies).
- **Archived:** open as read-only tabs — composer disabled, header shows the filed chip.
- **Session memory:** per-project module-level `{openTabs, activeId, drawerOpen, panel}`
  (replaces `lastSelection`). Restored on re-entry; not persisted to disk. New Task nonce still
  forces fresh + drawer open.
- No cap on open tabs (strip scrolls).

## 3. Conversation naming (driver decision)

- New additive field `name?: string` on `DraftData`. Label precedence: **name → `# heading` →
  first user message → "Untitled"**. Lenient parse: non-empty string accepted, anything else
  dropped (never a parse failure).
- **Inline rename:** double-click a conversation tab label → input (Enter/blur commits, Esc
  cancels). Empty commit clears `name` (falls back to derived). Disabled on archived tabs.
  Persisted id-keyed via `writer.update`.
- **LLM auto-title:** after the FIRST assistant reply of a conversation (chat was empty at send)
  and only when `name` is unset, fire a cheap follow-up completion ("reply with only a 3–6 word
  title"). Commit via id-keyed `update` whose mutate re-checks `name === undefined` — a user
  rename racing the title generation must win. Failure is silent (derived label stands).

## 4. Model selector (driver decision: config-derived, no hardcoded catalog)

- Composer bottom-left, styled as in the mockup: `default · <model> ⌃`.
- **Options:** `default` (resolves to `cfg.chatModel ?? 'claude-sonnet-5'`) + every distinct
  non-empty model found in the project's vanguard configuration: `cfg.chatModel`,
  `customProviders[].model`. Deduped, stable order.
- **Persistence:** additive `chatModel?: string` on `DraftData` (absent = default; lenient parse
  as with `name`). Selecting persists debounced; selection on a fresh draft rides `draftRef`
  until the first mint (choosing a model alone does not mint a file).
- **Send path:** model snapshotted SYNCHRONOUSLY at send (like `bodyAtSend`):
  `draft.chatModel ?? cfg.chatModel ?? DEFAULT_CHAT_MODEL`. Selector disabled while that
  conversation's turn is in flight and on archived drafts.

## 5. Header & indicator spec

- Title: label precedence above, of the active conversation; fresh shows "New task…".
- Meta: `relTime(updatedAt)`; filed drafts add `· archived` and the chip links `created.url`
  (http(s)-vetted by `parseDraft`).
- `[Create task]`: same gates as S10 (heading present, byte limits, source set, no pending
  proposal, not archived). Validation hints collapse to one muted strip under the header, shown
  only when the button is disabled and the draft is non-empty.
- `[Chat]` toggle: `aria-expanded`; **dot badge when the drawer is closed** and any open
  conversation has a turn in flight or an unseen reply. Inactive tabs with activity show the same
  dot in the strip; focusing the tab clears it.

## 6. Invariants that must survive (review-hardened, do not relitigate)

- Persistence stays **id-keyed, never selection-keyed**: per-id `pendingTurns`, synchronous
  `bodyAtSend`/model snapshot, id-keyed archive `update`, late-reply append. Every tab activation
  goes through `switchTo` (flush outgoing, load incoming from entries cache).
- **Concurrent turns across tabs are legal** (per-id guards already permit it); each reply lands
  in its own file.
- Editor `readOnly` during `confirming || creating || pending proposal || archived`.
- Writer snapshot discipline (`{ ...draftRef.current }` at every hand-off) and navGuard
  flush-on-close protocol untouched.
- Drawer close / History activation is visibility only — chat state lives in `TaskDraftScreen`
  and in-flight turns keep flying.

## 7. Component work plan

| Piece | Change |
|---|---|
| `draftStore.ts` | `DraftData + name?/chatModel?`; lenient parse; `draftLabel` name-first. Writer untouched. |
| `TaskDraftScreen.tsx` | Header + full-page editor + conditional drawer; tab/session state; unseen tracking; auto-title; model plumbing. Old left/right columns die, `unreadable` editor branch dies. |
| `TaskDrawer.tsx` (new) | Presentational: tab strip (pinned History, scrollable tabs, rename-in-place, `[+]`), History panel (today's rows), conversation panel (ChatPane). |
| `ChatPane.tsx` | Composer redesign: textarea + bottom row (model selector left, Send right); placeholder "Plan, scope, or refine this draft…". |
| Rust / CLI / sidecar | No changes. |

## 8. Acceptance criteria

1. Drawer closed ⇒ editor full width; toggling never loses editor state or any in-flight turn.
2. Strip: History pinned icon tab first; conversation tabs scroll; `[+]` lazy-fresh; no cap.
3. History click focuses-or-opens; tab close never deletes; History delete closes the tab.
4. Two tabs can run turns concurrently; replies land in their own files; inactive activity shows
   tab dot; closed drawer shows header badge.
5. Filed draft: header chip `filed as #<id>` (linked) + Open board + Duplicate; read-only tab.
6. Rename: double-click commits/cancels correctly; auto-title lands only when unnamed and never
   overwrites a user rename; both persist across relaunch.
7. Model: options from config only; per-draft persist; absent ⇒ settings default; hostile value
   in a file cannot fail the parse; send uses the model snapshotted at send time.
8. Session restore: open tabs + active tab + drawer state per project; New Task forces fresh.
9. Gates green: root `pnpm lint/typecheck/test`; desktop `tsc --noEmit` + `vitest`.

## 9. Out of scope

Multiple conversations per draft; run launch from this page (TaskDetail only — D3); S11 one-click
run; streaming replies; token/cost display; tab drag-reorder; extra pinned tabs.
