# Subsystem 3 — Doc Editor + Sidebar Chat (v1)

**Parent:** [`docs/vanguard-app-vision.md`](../vanguard-app-vision.md)
**Status:** spec — revised per two spec reviews (feasibility + design-gap)
**Date:** 2026-07-12
**Depends on:** Subsystem 0 (shipped, sidecar/IPC pattern). **Feeds:** Subsystem 4 (create-task).

---

## Why

The app has no editor — the only free-text surface is one `<Textarea>`
(`apps/desktop/src/features/inspector/NewRunForm.tsx:31`). The vision (S3) wants a place to
**write an idea → refine it into a plan with LLM help → (later) create a task**. This
subsystem ships the **v1 editor**: a CodeMirror doc editor with a **sidebar chat** whose LLM
proposes **whole-doc edits** you accept or reject. It deliberately **stages the editor, not
heavy LLM plumbing** — the chat is one direct model call per turn, no sandbox, no pipeline.

**v1's exit value on its own:** a well-formed markdown file under `.vanguard/docs/` that a
human can paste into any tracker today. **Subsystem 4** automates the last step (push the
plan to gh/glab/linear); this v1 stops at the saved doc and ships **no create-task affordance
at all** (an *absent* button, not a disabled one — S4's job is purely additive).

---

## Locked decisions (from brainstorming)

1. **Editor: CodeMirror 6** (via `@uiw/react-codemirror` + `@codemirror/lang-markdown`).
   Lightweight, markdown-friendly, React-19-clean, grows into v2 inline decorations. Not
   Monaco (heavy, worker/CSP friction under Tauri).
2. **LLM: a direct Anthropic-SDK call, not the sandboxed run pipeline.** The chat is a plain
   `system + messages → text` completion. It reuses none of the Docker/pipeline machinery.
3. **Scope: editor + sidebar chat + plan-mode refine loop.** Create-task → S4.

---

## Constraints (read first — everything below obeys these)

1. **Credentials come from the environment, never the app store, never the webview.** The
   Settings screen states it outright (`apps/desktop/src/features/settings/Settings.tsx:171-174`):
   *"LLM credentials are inherited from your environment / keychain and never stored by the
   app."* Load-bearing. The chat's key is read from `process.env` in a **process that has env
   access** — **not** the React renderer (no env, must never hold a key), **not** `app.json`.
   Only non-secret `chatModel`/`chatBaseUrl` may live in `AppConfig`.

2. **Auth is inherited from the environment — a `CLAUDE_CODE_OAUTH_TOKEN` subscription token is
   enough** (and `ANTHROPIC_API_KEY` works too). `__complete` runs the chat through
   `@anthropic-ai/claude-agent-sdk`'s `query()` — the Claude Code programmatic interface, which
   reads the same credentials from the environment as the `claude` CLI. So it authenticates with
   whatever the app was launched with (the user's `--provider claude` subscription token), no API
   key required, no auth branching in our code. (An earlier draft wrongly reached for the plain
   `@anthropic-ai/sdk` Messages endpoint, which `x-api-key`-only and rejects the subscription
   token — that was the wrong SDK; `claude-agent-sdk` is the one built for this and was already a
   dependency.)

3. **The chat must not queue behind a run.** The run sidecar is one Node process, one pipe, one
   mutex, single-in-flight (S0.5). So the chat completion runs on a **separate one-shot path**,
   never the run sidecar (`api_complete` takes no `State<Sidecar>` — feasibility confirmed).

4. **First non-sandboxed model call in the codebase.** Every existing model call shells a CLI
   inside Docker; `@anthropic-ai/claude-agent-sdk` is declared but unused (and rides the same
   OAuth/CLI auth, so it does not dodge Constraint 2). This introduces the first plain
   Messages-API call — minimal, isolated in one core entrypoint.

5. **CLI is a frozen public contract.** `vanguard __complete` is a **hidden additive
   entrypoint** (like `__sidecar`); no existing flag/command changes.

6. **One React component per file** (`/one-component`). Editor, chat pane, message, doc list
   each get their own file.

---

## Architecture — where the LLM call runs

The key-placement constraint decides it: the webview can't hold the key or read env; the run
sidecar can't be shared. So the completion runs in a **short-lived Node process spawned per
turn**:

```
DocsScreen (React)                 Rust (env access)              one-shot Node (env access)
  apiComplete(req)  ──invoke──►  api_complete command  ──spawn──►  vanguard __complete
   {system,messages,             sh -c 'exec vanguard              sets VANGUARD_SIDECAR gate,
    model?, baseUrl?}             __complete', pipes req,          claude-agent-sdk query()
                                  reads ONE JSON line              (no tools, 1 turn, auth from env),
   ◄── {text} | {error} ◄────────────────────────────────────────  writes {text}|{error}, exits
```

**Why one-shot, not a sidecar method (recommended — reviews concur):**
- **No shared mutex** — a fresh process per turn can't be starved by an in-flight run (C3).
- **Key isolation** — key lives only in that transient process's env, never the webview, never
  persisted (C1). It inherits the app's launch env (dogfood = launch from a terminal; a
  Finder-launched `.app` has no env, same caveat the sidecar already carries — `spawn.rs:62`).
- **Real Anthropic SDK, LLM logic in core TS** (testable, consistent), Rust just spawns + pipes
  (thin; mirrors `sh -c 'exec vanguard __sidecar'`, `sidecar.rs:49`).

**stdout discipline (feasibility #3):** the `__complete` branch must **explicitly** set
`VANGUARD_SIDECAR=1` and redirect `console.log`/`console.info`→stderr *before importing the SDK*
(replicating `src/cli/index.ts:95-97`; the logger only splits when it sees the env var,
`logger.ts:9`). `api_complete` reads **exactly one** stdout line and has none of the run
sidecar's skip-junk tolerance — a stray log corrupts the response, so the gate matters more here.

**Provider scope for v1:** Anthropic **Messages-format** endpoints only — the real Anthropic
API, or an Anthropic-compatible proxy via `chatBaseUrl`. OpenAI-format providers and full
custom-provider routing (the Zai-via-proxy case) are **Subsystem 6**; `__complete` takes
`model` + optional `baseUrl` and reads the key from env, so S6 extends it without a rewrite.

---

## Scope

### In

1. **`vanguard __complete`** — hidden CLI entrypoint. Sets the stdout gate, reads one JSON
   request line on stdin (`{ system?: string; messages: {role:'user'|'assistant'; content:string}[];
   model?: string; baseUrl?: string }`), runs `@anthropic-ai/claude-agent-sdk`'s `query()`
   constrained to **`allowedTools: []`, `settingSources: []`, `maxTurns: 1`** (a completion, not an
   agent — no filesystem/tool access), extracts the `type:'result'` success text, writes one JSON
   line (`{ text }` or `{ error: { message } }`), exits. No sandbox, no run pipeline. Auth is read
   from the environment by the SDK (subscription token or API key) — no auth code of our own.
2. **Rust `api_complete`** — `#[tauri::command]` that spawns `vanguard __complete`, pipes the
   request, reads the one response line, returns it. No `Sidecar` state (sidesteps the run
   mutex). Registered in `lib.rs`.
3. **`apiComplete`** ipc wrapper (`ipc.ts`) — `invoke('api_complete', { params })`.
4. **`DocsScreen`** — new screen: a doc list (`.vanguard/docs/*.md`) + the CodeMirror editor +
   the sidebar chat, hand-rolled flex split. Wired into the screen union. **Top-level Rail
   entry** (rationale: the Board is remote-sourced — gh/glab/linear live — while docs are
   local files; merging the two data sources into one screen is an S4 UI decision, not S3's).
5. **`DocEditor`** — CodeMirror 6 markdown editor (controlled `value`/`onChange`). **Read-only
   while a chat proposal is pending** (see §7).
6. **`ChatPane` + `ChatMessage`** — sidebar chat: message list (assistant text via the existing
   `Markdown`), input, send. A **plan-mode preset** system prompt seeds the loop (idea → plan).
7. **Whole-doc proposal mechanic** — the assistant is prompted to return the full revised doc
   inside **`<doc>…</doc>` sentinels** (matching vanguard's existing `<plan>`/`<findings>`
   model-output idiom, more robust than fenced-block scraping), with any prose note *outside*
   the tags shown as the chat message. The reducer extracts `<doc>` → a **pending proposal**;
   an accept/reject bar appears; **accept** replaces editor content, **reject** discards. If no
   `<doc>` is present, the reply is a plain chat message (no proposal) — graceful degradation.
   **While a proposal is pending the editor is read-only** so a user edit can't be silently
   eaten by accept (design-gap #1 — hard requirement). Pure `useDocChat` reducer folds messages,
   pending proposal, and the pending/idle editor state.
   *Known ceiling (design-gap #2): whole-doc-per-turn re-transmits the whole doc each turn, so
   cost/latency grow with doc length. Acceptable for v1 plan-sized docs; a diff/patch protocol
   is a later iteration.*
8. **Doc persistence** — Rust `list_docs` / `read_doc` / `write_doc` over `.vanguard/docs/*.md`
   (new `docs.rs`, mirroring `appconfig.rs` read/write); new-doc + save. `.vanguard/docs/` is a
   clean sibling of the existing `staging/`/`memory/`/`runs/` (verified no collision).
9. **`AppConfig` gains non-secret `chatModel?` / `chatBaseUrl?`** (Rust `appconfig.rs` + TS
   `vanguard-output.d.ts`). Settings gets **one** new field: a chat-model **text input** (model
   names churn — no enumerated dropdown). **No apiKey field** (env only); **no baseURL UI field**
   in v1 (a self-hosted Anthropic proxy is a power-user, config-file case → S6).

### Non-goals (deferred, with reason)

- **Create-task on gh/glab/linear** → **Subsystem 4**. v1 ships no create-task affordance;
  S4's seam is the finished `.vanguard/docs/*.md` + the per-project `cfg.source`/`cfg.label`
  already in `AppConfig` (which repo/tracker to target).
- **v2 inline selection comments** (span edits, anchoring, decorations) → later S3 iteration.
- **OpenAI-format / multi-format providers, stored custom keys** → **S6**.
- **Streaming tokens** — v1 is request→full-response (one-shot). Deferred.
- **Rich doc management** (folders, rename, delete, search) → later.

---

## Seams (file:line, verbatim)

- **Screen union** `apps/desktop/src/Rail.tsx:18` — add `'docs'`; **NAV entry** `Rail.tsx:20`
  (icon `FileText` from `lucide-react`).
- **Breadcrumb label** `apps/desktop/src/App.tsx:129` `SCREEN_LABEL` — add `docs: 'Docs'`.
- **Inspector prop union** `Inspector.tsx:39` + **ternary switch** `Inspector.tsx:274+` — add
  `screen === 'docs' ? <DocsScreen .../> : …`; use the `board`-style full-width escape
  (`Inspector.tsx:186` drops `max-w-5xl` for `board`) so the editor gets width.
- **Rust command template** `sidecar.rs:122` `api_capabilities` (sync request/response) +
  registration `lib.rs:131` `generate_handler!`. `api_complete` spawns its own one-shot process
  (no shared `Sidecar`).
- **Spawn recipe** `sidecar.rs:49` `sh -c 'exec vanguard __sidecar'` — mirror with `__complete`,
  write stdin + read one stdout line. Env inherits (no `.env_clear()`).
- **ipc wrapper** `apps/desktop/src/ipc.ts:111` (`apiCapabilities` template) — add `apiComplete`.
- **AppConfig** `apps/desktop/src-tauri/src/appconfig.rs:9` (Rust, `rename_all="camelCase"`,
  hand-maintained) **and** `apps/desktop/src/vanguard-output.d.ts:62` (TS, not generated — safe
  to hand-edit) — add `chatModel?`/`chatBaseUrl?` to both.
- **Doc file IPC** — new `apps/desktop/src-tauri/src/docs.rs` (read/write like `appconfig.rs`) +
  `lib.rs:139` registration for `list_docs`/`read_doc`/`write_doc`.
- **CLI entrypoint** `src/cli/index.ts:95` (`__sidecar` gate) + `src/cli/args.ts`
  (`__sidecar → {kind:'sidecar'}`) — add the hidden `__complete` branch/kind, replicating the
  stdout gate.
- **Env auth** `src/agents/auth.ts:26` `authFromEnv()` — the Anthropic-only primitive
  (`agentAuthFromEnv(choice)` is the wrong helper — it returns non-Anthropic provider keys too).
- **Markdown renderer** `apps/desktop/src/ui/Markdown.tsx` — reuse for chat messages.
- **`@/ui` seam** `apps/desktop/src/ui/index.ts` — add newly-needed chunks-ui names
  (`ScrollArea`, `Separator`, `Loader`) to the barrel before use.

---

## New dependencies

- Root: **no new dep** — `__complete` uses the already-present `@anthropic-ai/claude-agent-sdk`
  (the Claude Code programmatic SDK, which is exactly what makes the subscription token work).
- Desktop (`apps/desktop/package.json`): **`@uiw/react-codemirror`**, **`@codemirror/lang-markdown`**
  (+ transitive `@codemirror/*`). React 19 satisfied (peer `>=16.8.0`).

---

## Acceptance criteria

- **AC1** `vanguard __complete` sets the stdout gate, reads a JSON request on stdin, writes one
  JSON line: `{text}` on success, `{error:{message}}` on failure. No stdout pollution (a stray
  `console.log` must not corrupt the line). SDK mocked in tests.
- **AC2** `api_complete` (Rust) spawns `__complete`, pipes the request, returns the parsed
  response; a non-zero exit or malformed line → `Err(String)`. It takes no `State<Sidecar>` (a
  chat completes while a run is in flight).
- **AC3** Auth is inherited from the environment by the agent SDK: a `CLAUDE_CODE_OAUTH_TOKEN`
  subscription token alone drives the chat (no API key needed), and `ANTHROPIC_API_KEY` works too.
  An auth failure surfaces as a chat `{error}` (the SDK's `result` error subtype), not a crash. No
  credential is ever written to `app.json` or sent to the renderer.
- **AC4** `DocsScreen` lists `.vanguard/docs/*.md`, opens one in the editor, edits persist via
  `write_doc`, "New doc" creates one; reachable from the Rail.
- **AC5** Chat: sending calls `apiComplete`; an assistant reply with `<doc>…</doc>` renders a
  **pending proposal** + accept/reject bar; a reply without `<doc>` is a plain message;
  **accept** replaces editor content, **reject** leaves it unchanged; both clear the pending
  state. `useDocChat` reducer covers this.
- **AC6** **While a proposal is pending, the editor is read-only** — a user cannot edit into a
  window where accept would silently discard their keystrokes.
- **AC7** The plan-mode preset seeds a plan-oriented system prompt so an idea doc → a structured
  plan proposal in one turn. (It is a chat preset, **not** the sandboxed `planner` pipeline
  stage — no repo/tool parity implied.)
- **AC8** `pnpm typecheck` + `pnpm test` (core) green; `cd apps/desktop && pnpm test` + `tsc`
  green; `cargo test` + `clippy` green. No `.github/workflows/` change; existing CLI unaffected.

---

## Test plan

**Core (Vitest):**
- **T1** `__complete` with `@anthropic-ai/claude-agent-sdk`'s `query()` mocked (injected via
  `CompleteDeps`): a `result`/`success` message → `{text}`; a non-success `result` subtype →
  `{error}`; a thrown SDK error → `{error}`; a stream that ends with no `result` → `{error}`.
  There is no auth case to test — the SDK reads the environment itself and we write no auth code,
  so an auth failure is just another `{error}` subtype.
- **T2** request parsing/validation: malformed stdin JSON, empty `messages`, missing `model`.

**Desktop (Vitest + Testing Library):**
- **T3** `useDocChat` reducer (pure — the real logic): send appends a user message; a `<doc>`
  reply sets a pending proposal + read-only; accept applies to doc + clears + re-enables edit;
  reject clears without changing doc; a no-`<doc>` reply is a plain message; an `apiComplete`
  error surfaces a chat error, not a throw.
- **T4** `DocEditor` **render-only smoke** (mount with a value; CM6 needs real DOM geometry that
  jsdom lacks, so do NOT simulate typing — assert the `onChange` prop is wired / dispatch a CM
  transaction if exercising it). (Feasibility #2.)
- **T5** `ChatPane`/`ChatMessage` render a transcript; the accept/reject bar shows only with a
  pending proposal; buttons fire reducer actions (`apiComplete` mocked).
- **T6** `DocsScreen` lists docs (mock `list_docs`), opens/saves (mock read/write).

**Rust (cargo):**
- **T7** `docs.rs` list/read/write round-trip in a temp dir; `list_docs` ignores non-`.md`.
- **T8** (light) `api_complete` request serialization shape.

**Not auto-tested (env-gated, dogfood):** a real `__complete` call (needs a live
`ANTHROPIC_API_KEY`) and the Tauri spawn/pipe layer — same class as S0's untested pipe layer.

---

## Open questions — resolved by review

1. **LLM transport** → one-shot `__complete` (no shared mutex, SDK + TS logic). Confirmed by
   both reviews; env-inheritance + stdout gate handled above.
2. **`@uiw/react-codemirror` vs raw CM6** → the wrapper for v1 (whole-doc only needs no
   span-level control); raw CM6 is a contained swap if v2 decorations need it.
3. **Doc storage** → `.vanguard/docs/*.md`, repo-local (verified no collision; keeps S4's
   read-path trivial).
4. **Proposal encoding** → `<doc>…</doc>` sentinels (vanguard's model-output idiom), degrade to
   plain chat on no-match. Not fenced-block scraping (equally fragile, no gain).
5. **`chatModel`** → in `AppConfig` (follows the existing `provider` pattern, non-secret); a
   fixed default would rot when Anthropic ships new model names.
