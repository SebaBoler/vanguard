# Subsystem 3 — Doc Editor + Sidebar Chat (v1) Implementation Plan

> **SUPERSEDED ON AUTH — read this first.** Every mention below of `@anthropic-ai/sdk`,
> `authFromEnv()`, api-mode, `ANTHROPIC_API_KEY`, or "subscription token → specific error" is
> **wrong** and was corrected during implementation. The shipped code uses
> `@anthropic-ai/claude-agent-sdk`'s `query()` — the Claude Code programmatic interface — which
> reads credentials from the environment exactly like the `claude` CLI. **A
> `CLAUDE_CODE_OAUTH_TOKEN` subscription token works with no API key, and we write no auth code of
> our own.** The plain `@anthropic-ai/sdk` Messages endpoint is `x-api-key`-only and *rejects* that
> token; reaching for it was the mistake. `docs/specs/subsystem-3-doc-editor.md` §2 is the source of
> truth. Task 1 Step 1 (`pnpm add @anthropic-ai/sdk`) was **not** performed — `claude-agent-sdk` was
> already a dependency. If you are writing auth branching for an LLM call, you have picked the wrong SDK.

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a CodeMirror doc editor with a sidebar LLM chat that proposes whole-doc edits (accept/reject), backed by a one-shot `vanguard __complete` Anthropic-SDK call. Stop at a saved `.vanguard/docs/*.md`; create-task is S4.

**Architecture:** React `DocsScreen` → Rust `api_complete` (one-shot spawn, no run mutex) → `vanguard __complete` (core TS, `@anthropic-ai/sdk`, key from `authFromEnv()` api-mode). Docs persist via Rust `docs.rs` over `.vanguard/docs/`. Pure `useDocChat` reducer holds the real logic.

**Tech Stack:** TypeScript (strict ESM, `.js` imports, Node 24), Vitest; Rust/Tauri 2; React 19 + CodeMirror 6 (`@uiw/react-codemirror`).

## Global Constraints

- Chat key from **env, api-mode only** (`ANTHROPIC_API_KEY`); subscription token → specific error. Never in `app.json`/webview.
- `__complete` is a **hidden additive** CLI entrypoint; sets the `VANGUARD_SIDECAR` stdout gate before importing the SDK.
- Editor **read-only while a proposal is pending**.
- One React component per file. Never touch `.github/workflows/`. All gates green before done.

---

### Task 1: Add dependencies

- [ ] **Step 1:** `pnpm add @anthropic-ai/sdk` (root — runtime dep of `__complete`).
- [ ] **Step 2:** `cd apps/desktop && pnpm add @uiw/react-codemirror @codemirror/lang-markdown`.
- [ ] **Step 3:** `pnpm -w typecheck` still green (no usage yet). Commit `chore(s3): add @anthropic-ai/sdk + codemirror deps`.

---

### Task 2: `vanguard __complete` core entrypoint (TDD)

**Files:** Create `src/api/complete.ts`, `src/api/complete.test.ts`; modify `src/cli/args.ts` (add `| { kind: 'complete' }` to the Command union ~`:257`; `if (positionals[0] === '__complete') return { kind: 'complete' };` near the `__sidecar` check), `src/cli/index.ts` (add a `command.kind === 'complete'` branch mirroring the sidecar gate `:91-97`).

**Interfaces:**
```ts
export interface CompleteRequest { system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; model: string; baseUrl?: string; maxTokens?: number; }
export interface CompleteResponse { text?: string; error?: { message: string }; }
export function runComplete(req: unknown, deps: { authFromEnv: typeof import('../agents/auth.js').authFromEnv; anthropic: (opts: { apiKey: string; baseURL?: string }) => { messages: { create: (b: unknown) => Promise<{ content: { type: string; text?: string }[] }> } } }): Promise<CompleteResponse>;
```
`runComplete` takes injected deps so tests mock the SDK + auth. The CLI branch wires real `authFromEnv` + `new Anthropic(...)`.

- [ ] **Step 1: failing tests** (`complete.test.ts`):
```ts
import { test, expect } from 'vitest';
import { runComplete } from './complete.js';

const okAnthropic = () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: 'hi' }] }) } });
const apiAuth = () => ({ mode: 'api' as const, apiKey: 'sk-x' });
const subAuth = () => ({ mode: 'subscription' as const, token: 'oauth-x' });

test('api-mode key → text', async () => {
  const r = await runComplete({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.text).toBe('hi');
});
test('subscription token → specific ANTHROPIC_API_KEY error', async () => {
  const r = await runComplete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { authFromEnv: subAuth, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/ANTHROPIC_API_KEY/);
});
test('no key → error', async () => {
  const r = await runComplete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { authFromEnv: () => undefined, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/ANTHROPIC_API_KEY/);
});
test('empty messages → error', async () => {
  const r = await runComplete({ model: 'm', messages: [] }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.error).toBeDefined();
});
test('missing model → error', async () => {
  const r = await runComplete({ messages: [{ role: 'user', content: 'x' }] }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.error).toBeDefined();
});
test('SDK throw → error, not reject', async () => {
  const boom = () => ({ messages: { create: async () => { throw new Error('429'); } } });
  const r = await runComplete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { authFromEnv: apiAuth, anthropic: boom });
  expect(r.error?.message).toMatch(/429/);
});
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** `complete.ts`: validate (`messages` non-empty array, `model` non-empty string) → error; `auth = deps.authFromEnv()`; if undefined or `mode!=='api'` → `{ error: { message: 'doc chat needs ANTHROPIC_API_KEY' + (mode subscription ? ' (found a Claude-Code subscription token, which the Messages API cannot use)' : '') } }`; else `client = deps.anthropic({ apiKey: auth.apiKey, ...(baseUrl?{baseURL:baseUrl}:{}) })`; `const res = await client.messages.create({ model, system, messages, max_tokens: maxTokens ?? 4096 })` in try/catch; text = concat `content` text parts; return `{ text }`. Catch → `{ error: { message: String(err) } }`.
- [ ] **Step 4:** run → pass.
- [ ] **Step 5: wire the CLI branch** in `index.ts` (after the sidecar branch): set `process.env.VANGUARD_SIDECAR='1'` + redirect `console.log/info`→stderr (copy `:95-97`), read one line from stdin (`node:readline` or `for await`), `import Anthropic from '@anthropic-ai/sdk'`, call `runComplete(JSON.parse(line), { authFromEnv, anthropic: (o) => new Anthropic(o) })`, `process.stdout.write(JSON.stringify(res) + '\n')`, exit. Add `kind:'complete'` handling.
- [ ] **Step 6:** `pnpm typecheck && pnpm test src/api/complete.test.ts src/cli/args.test.ts`. Commit `feat(s3): vanguard __complete entrypoint (Anthropic Messages, api-key required)`.

---

### Task 3: Rust `docs.rs` — doc file IO (TDD)

**Files:** Create `apps/desktop/src-tauri/src/docs.rs`; modify `lib.rs` (`mod docs;` + register `list_docs`/`read_doc`/`write_doc` in `generate_handler!` `:131` + wherever `read_app_config` is registered `:139`).

**Interfaces (Rust):** `list_docs(repo_path: String) -> Vec<String>` (basenames of `*.md` under `<repo>/.vanguard/docs/`, sorted, `[]` if dir absent), `read_doc(repo_path, name) -> String`, `write_doc(repo_path, name, content) -> Result<(), String>` (creates `.vanguard/docs/` if absent; rejects names with `/` or `..`).

- [ ] **Step 1: failing cargo test** in `docs.rs`: write two `.md` + one `.txt` in a `tempfile::tempdir`, assert `list_docs` returns the two `.md` sorted; `write_doc` then `read_doc` round-trips; `write_doc` with `../evil` → `Err`.
- [ ] **Step 2:** `cd apps/desktop/src-tauri && cargo test docs` → fail.
- [ ] **Step 3: implement** `docs.rs` (mirror `appconfig.rs` read/write; `std::fs`; name guard `!name.contains('/') && !name.contains("..")`; ensure `.md` extension).
- [ ] **Step 4:** register in `lib.rs`; `cargo test` + `cargo clippy` green.
- [ ] **Step 5:** Commit `feat(s3): Rust docs.rs — list/read/write .vanguard/docs`.

---

### Task 4: Rust `api_complete` command

**Files:** modify `sidecar.rs` (add `#[tauri::command] pub fn api_complete(req: serde_json::Value) -> Result<serde_json::Value, String>` — spawn `sh -c 'exec vanguard __complete'` mirroring `ensure`/`:49`, `Stdio::piped` stdin+stdout, write `req` + `\n`, read one line, `serde_json::from_str`; non-zero/malformed → `Err`), register in `lib.rs`. It takes **no `State<Sidecar>`**.

- [ ] **Step 1:** implement `api_complete` (no persistent state; one-shot child; env inherits — do not `.env_clear()`).
- [ ] **Step 2:** register in `generate_handler!`.
- [ ] **Step 3:** `cargo build` + `cargo clippy` green. (Runtime path is env-gated; no cargo unit test beyond a light serialize check if cheap.)
- [ ] **Step 4:** Commit `feat(s3): Rust api_complete — one-shot LLM spawn (no run mutex)`.

---

### Task 5: AppConfig `chatModel`/`chatBaseUrl`

**Files:** `apps/desktop/src-tauri/src/appconfig.rs:9` (add `pub chat_model: Option<String>`, `pub chat_base_url: Option<String>`), `apps/desktop/src/vanguard-output.d.ts:62` (add `chatModel?: string; chatBaseUrl?: string;`).

- [ ] **Step 1:** add both fields (Rust `#[serde(default)]` already on struct → camelCase auto).
- [ ] **Step 2:** `cargo build` + `cd apps/desktop && pnpm tsc` green.
- [ ] **Step 3:** Commit `feat(s3): AppConfig chatModel/chatBaseUrl (non-secret)`.

---

### Task 6: ipc wrappers

**Files:** `apps/desktop/src/ipc.ts` — add `apiComplete(params): Promise<{text?; error?}>` (`invoke('api_complete', { params })`), `listDocs(repoPath)`, `readDoc(repoPath, name)`, `writeDoc(repoPath, name, content)`; extend the local `AppConfig` mirror if used here.

- [ ] **Step 1:** add wrappers with typed request/response mirrors.
- [ ] **Step 2:** `pnpm tsc` green. Commit `feat(s3): ipc wrappers — apiComplete + doc IO`.

---

### Task 7: `useDocChat` reducer (TDD — the real logic)

**Files:** Create `apps/desktop/src/features/docs/useDocChat.ts`, `useDocChat.test.ts`.

**Interfaces:**
```ts
export interface ChatMsg { role: 'user' | 'assistant'; content: string; }
export interface DocChatState { messages: ChatMsg[]; pending?: string; /* proposed doc */ busy: boolean; error?: string; }
export function extractDoc(text: string): { note: string; doc?: string }; // parse <doc>…</doc>
export function reduceDocChat(state, action): DocChatState; // actions: send, reply(text), acceptApplied, reject, fail(msg)
```
`pending !== undefined` ⇒ editor read-only.

- [ ] **Step 1: failing tests:** `extractDoc('note <doc>BODY</doc>')` → `{note:'note', doc:'BODY'}`; no tags → `{note:text}`. Reducer: `send` appends user msg + `busy=true`; `reply` with `<doc>` sets `pending` + assistant note msg + `busy=false`; `reply` without `<doc>` appends assistant msg, no pending; `acceptApplied` clears pending; `reject` clears pending; `fail` sets error + `busy=false`, no throw.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** (pure; `extractDoc` via a non-greedy `/<doc>([\s\S]*?)<\/doc>/`).
- [ ] **Step 4:** run → pass. Commit `feat(s3): useDocChat reducer + <doc> extraction`.

---

### Task 8: `DocEditor` (CodeMirror)

**Files:** Create `apps/desktop/src/features/docs/DocEditor.tsx`, `DocEditor.test.tsx`.

**Interface:** `DocEditor({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly?: boolean })` — `<CodeMirror value={value} onChange={onChange} readOnly={readOnly} extensions={[markdown()]} />`.

- [ ] **Step 1: render-only smoke test** (T4): mount with a value, assert it renders (no keystroke simulation — jsdom can't drive CM6 input). Assert `readOnly` maps through if cheaply observable; otherwise just render.
- [ ] **Step 2:** implement (`@uiw/react-codemirror` default export + `markdown` from `@codemirror/lang-markdown`; theme via existing Tailwind wrapper `div`).
- [ ] **Step 3:** `pnpm test DocEditor` + `tsc` green. Commit `feat(s3): DocEditor (CodeMirror markdown)`.

---

### Task 9: `ChatMessage` + `ChatPane`

**Files:** Create `apps/desktop/src/features/docs/ChatMessage.tsx`, `ChatPane.tsx`, `ChatPane.test.tsx`. Add `ScrollArea`/`Separator`/`Loader` to `@/ui` barrel if used.

**Interfaces:** `ChatMessage({ msg }: { msg: ChatMsg })` — assistant via `Markdown`, user as plain text. `ChatPane({ state, onSend, onAccept, onReject }: { state: DocChatState; onSend: (t: string) => void; onAccept: () => void; onReject: () => void })` — message list + input + send; **accept/reject bar only when `state.pending !== undefined`**; error line when `state.error`.

- [ ] **Step 1: failing test (T5):** render a transcript (asserts messages show); accept/reject bar hidden without `pending`, shown with; clicking Accept/Reject calls the props.
- [ ] **Step 2:** implement both (one component per file).
- [ ] **Step 3:** `pnpm test ChatPane` + `tsc` green. Commit `feat(s3): ChatPane + ChatMessage`.

---

### Task 10: `DocsScreen` (wire it together)

**Files:** Create `apps/desktop/src/features/docs/DocsScreen.tsx`, `DocsScreen.test.tsx`.

**Interface:** `DocsScreen({ project }: { project: string })` — left: doc list (`listDocs`) + "New doc"; center: `DocEditor` (readOnly when `chat.pending`); right: `ChatPane`. Holds `doc` content + `useReducer(reduceDocChat)`. Send → build request (`system` = plan-mode preset, `messages` = chat history + current doc as context, `model` = `cfg.chatModel ?? DEFAULT`, `baseUrl` = `cfg.chatBaseUrl`) → `apiComplete` → `reply`/`fail`. Accept → set editor content to `pending` + `acceptApplied` + `writeDoc`. Save on blur via `writeDoc`.

- [ ] **Step 1: failing test (T6):** mock `listDocs`/`readDoc`/`writeDoc`/`apiComplete`; assert docs list renders, opening loads content, a chat reply with `<doc>` shows the accept bar, accept updates the editor value + calls `writeDoc`.
- [ ] **Step 2:** implement (hand-rolled flex split; plan-mode preset constant).
- [ ] **Step 3:** `pnpm test DocsScreen` + `tsc` green. Commit `feat(s3): DocsScreen — editor + chat + doc list`.

---

### Task 11: Screen wiring

**Files:** `Rail.tsx:18` (`'docs'` in `Screen`), `Rail.tsx:20` (NAV `{ key:'docs', label:'Docs', icon: FileText }`), `App.tsx:129` (`SCREEN_LABEL` `docs:'Docs'`), `Inspector.tsx:39` (widen prop union), `Inspector.tsx:274+` (add `screen === 'docs' ? <DocsScreen project={project}/> : …`), `Inspector.tsx:186` (add `'docs'` to the full-width escape alongside `'board'`).

- [ ] **Step 1:** make the 6 edits.
- [ ] **Step 2:** `pnpm test` + `tsc` green (Rail/nav tests if any still pass). Commit `feat(s3): wire Docs screen into the Rail + Inspector`.

---

### Task 12: Settings chat-model field

**Files:** `apps/desktop/src/features/settings/Settings.tsx` — add one text `Input` bound to `cfg.chatModel` (label "Doc chat model", placeholder e.g. `claude-sonnet-5`). No baseURL field, no apiKey field.

- [ ] **Step 1:** add the field (mirror an existing `Input` binding).
- [ ] **Step 2:** `pnpm test` + `tsc` green. Commit `feat(s3): Settings — doc chat model field`.

---

### Task 13: Full gate

- [ ] `pnpm typecheck && pnpm test` (core) · `cd apps/desktop && pnpm test && pnpm tsc` · `cd apps/desktop/src-tauri && cargo test && cargo clippy` — all green.

## Self-review checklist
1. Key never in `app.json`/renderer; subscription token → specific error (T1). 
2. Editor read-only while `pending` (AC6, DocsScreen wires `readOnly={chat.pending!==undefined}`).
3. `__complete` sets the stdout gate before SDK import.
4. `.github/workflows/` untouched; existing CLI additive-only.
5. Each `.tsx` = one component.
