/**
 * The wire contract shared between core and the desktop app (Subsystem 7).
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — this file must be safe in the Tauri webview.
 * - Syntax ceiling: interfaces, type aliases, literal unions, `const` literals only — nothing the
 *   desktop's OLDER TypeScript cannot parse (the drift guard proves byte-equality, not
 *   compilability; the ceiling is what keeps this compiling on both sides).
 * - `pnpm gen:wire` copies this file verbatim (plus a header) to apps/desktop/src/wire.ts; the
 *   drift test byte-compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
 *
 * Rust never inspects these payloads (sidecar traffic passes through as opaque JSON), so this file
 * IS the contract for everything TS↔TS. TS↔Rust shapes (vanguard-output.d.ts vs serde structs)
 * are a different boundary and stay out.
 */

/** Reasoning-effort tiers accepted across stages, flows, and the CLI. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Structured run events emitted by the pipeline runner when a caller passes `onEvent`. Stage names
 * are plain strings (matching StageOutcome.name). The desktop additionally sees a Rust-minted
 * `run-accepted` variant that core never emits — declared desktop-side, not here.
 */
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean }
  | { type: 'run-error'; message: string }
  | { type: 'run-cancelled' };

/** A selectable flow: its stable key and a human label for the UI. */
export interface FlowInfo {
  name: string;
  label: string;
}

/** What the run builder + flow editor render from — providers, flows, the stage palette, transports, defaults. */
export interface Capabilities {
  providers: string[];
  flows: FlowInfo[];
  /** STAGE_LIBRARY keys — the flow editor's stage palette. Static per session. */
  stages: string[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

/** The task transports vanguard reads/publishes through. */
export const TRANSPORTS = ['github', 'gitlab', 'linear'] as const;

/** Params for the sidecar `createRun` method. */
export interface CreateRunParams {
  issueRef: string;
  /** Absolute path to the target project repo — required (the sidecar child has no project cwd). */
  repoPath: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

/** Result of the sidecar `createRun` method. */
export interface CreateRunResult {
  prUrl?: string;
  secretBlocked?: boolean;
}

/** Per-stage routing/budget overrides expressible in HCL (snake_case keys map to these camelCase fields). */
export interface StageOverrides {
  model?: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  provider?: string;
  resumePrevious?: boolean;
}

/** One `stage {}` block: a name (library key), an optional `ref` (Layer-2 escape hatch), and overrides. */
export interface StageDecl {
  name: string;
  /** `"relpath#export"` resolved under `<repoPath>/.vanguard/`. Present ⇒ record comes from TS, not the library. */
  ref?: string;
  overrides: StageOverrides;
  /** Freeform pass-through block; never interpreted. */
  meta?: Record<string, unknown>;
}

/** One `loop {}` block. Parsed/emitted in S2; execution deferred. */
export interface LoopDecl {
  stages: string[];
  until: string;
  max: number;
}

/** A whole flow file: exactly one `flow "<name>" {}` block. */
export interface FlowDoc {
  name: string;
  label: string;
  stages: StageDecl[];
  loops: LoopDecl[];
  meta?: Record<string, unknown>;
}

/** One discovered flow file. `name` present ⇔ parsed (openable); `error` present ⇔ not runnable. */
export interface RepoFlowInfo {
  file: string;
  name?: string;
  label?: string;
  error?: string;
}

/**
 * One configured custom provider on the wire (S6): healthy (name, no error) or broken (`error`
 * set; index -1 = the whole-file pseudo-entry). `error` absent ⇔ runnable.
 */
export interface RepoProviderInfo {
  index: number;
  name?: string;
  error?: string;
}

/**
 * One composer attachment forwarded with a doc-chat completion (Editor UX 7/7). Additive on the
 * wire — a caller that sends none is byte-identical to the pre-attachment protocol.
 *
 * `kind: 'image'` → a pasted/dropped image persisted under `.vanguard/drafts/<id>-assets/`; `path`
 * is its absolute path and `mediaType` its IANA type (e.g. `image/png`). `__complete` reads the
 * file and forwards it to the agent SDK as an image content block.
 *
 * `kind: 'file'` → a dropped text file or an `@`-mention; `path` is the fence label (the dropped
 * filename or the `@path`) and `content` its already-read, host-capped UTF-8 text, inlined into the
 * prompt as a fenced block. `mediaType`/`content` are per-kind and both optional on the wire.
 */
export interface CompleteAttachment {
  kind: 'image' | 'file';
  path: string;
  mediaType?: string;
  content?: string;
}

/** One doc-chat completion request (the JSON `vanguard __complete` reads on stdin). */
export interface CompleteRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  baseUrl?: string;
  /** Pasted images + inlined text files/mentions (Editor UX 7/7). Absent ⇒ text-only completion. */
  attachments?: CompleteAttachment[];
  /** TRUSTED image-containment root, stamped by the Rust sidecar over anything the renderer sent
   * (like baseUrl): every image attachment path must canonicalize under it. Absent ⇒ image
   * attachments are refused. */
  assetRoot?: string;
}

/** Ceiling on ONE image attachment file (Editor UX 7/7 review r1) — matches the Anthropic API's
 * per-image limit; refused before the model is hit. */
export const MAX_IMAGE_BYTES = 5_000_000;

/** Ceiling on ONE inlined attachment/mention file (Editor UX 7/7) — the drag-drop/mention 64KB cap. */
export const MAX_ATTACHMENT_BYTES = 64_000;

/** Ceiling on TOTAL inlined attachment/mention content per send (Editor UX 7/7). Error above. */
export const MAX_INLINE_TOTAL_BYTES = 256_000;

/** The single JSON line `vanguard __complete` writes to stdout. */
export interface CompleteResponse {
  text?: string;
  error?: { message: string };
}

/** A created task: the ref `vanguard run` accepts, and the URL to show the human. */
export interface CreatedTask {
  id: string;
  url: string;
}

/**
 * Body size ceiling for created tasks. Enforced BEFORE any request: hitting a real provider limit
 * surfaces as a bare E2BIG from the OS, which tells the user nothing.
 */
export const MAX_BODY_BYTES = 60_000;

/** Title byte ceiling for created tasks (a pathological `# ...` is one doc away). */
export const MAX_TITLE_BYTES = 500;

/** The ONE repo-configured-name grammar (flows AND custom providers — S5/S6). */
export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Grammar for a custom provider's `keyEnv` (an environment variable NAME, never a key). */
export const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The allowed keys of a `customProviders` entry (unknown keys are a validation error). */
export const CUSTOM_PROVIDER_KEYS = ['name', 'baseUrl', 'keyEnv', 'model'] as const;

/**
 * The built-in provider names, in registry-table order. A LITERAL, not derived: PROVIDER_NAMES is
 * `Object.keys(PROVIDERS)` inside registry.ts, which imports node-only provider classes — this
 * file must stay webview-safe. registry.test.ts pins `WIRE_PROVIDER_NAMES` equal (incl. order).
 */
export const WIRE_PROVIDER_NAMES = ['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian'] as const;

/** Adversary-finding severity/kind vocabularies; core's zod schema derives its enums from these. */
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const FINDING_KINDS = ['security', 'perf', 'correctness', 'style'] as const;

/** One board card (S9): id resolvable to (source, ref) for spec fetch and run-record matching. */
export interface BoardTask {
  id: string;
  title: string;
  column: 'queued' | 'claimed' | 'running' | 'verify-failed' | 'review' | 'done';
  /** The chip: first label else provider state (github/gitlab); the workflow state (Linear). */
  state: string;
}

/** One adversary-stage finding (the `<findings>` block item shape). */
export interface Finding {
  severity: (typeof FINDING_SEVERITIES)[number];
  kind: (typeof FINDING_KINDS)[number];
  title: string;
  evidence: string;
}
