import { isAbsolute } from 'node:path';
import { FLOWS, TRANSPORTS } from '../api/capabilities.js';
import { VanguardError } from '../core/errors.js';
import { coerceFlowDoc, flowDocError, FlowError, FLOW_FILE_RE } from '../flows/repo.js';
import type { RepoFlowInfo } from '../flows/repo.js';
import type { FlowDoc } from '../flows/types.js';
import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';
import type { CreatedTask } from '../tasks/create.js';

/** A caller mistake in a request (bad params, unknown method) — classified `kind: "bad-request"`. */
export class BadRequestError extends VanguardError {}

/** Typed projection of a run request — a subset of RunOptions plus the issue ref and transport. */
// CreateRunParams lives in src/wire.ts (the shared desktop contract — S7).
export type { CreateRunParams } from '../wire.js';
import type { CreateRunParams } from '../wire.js';

/**
 * What the sidecar forwards back to the client — the run's PR outcome. A structural subset of the
 * runner's RunIssueResult (which the production deps return directly); the sidecar never reads `task`.
 */
// CreateRunResult lives in src/wire.ts (S7).
export type { CreateRunResult } from '../wire.js';
import type { CreateRunResult } from '../wire.js';

export interface SidecarDeps {
  capabilities: () => Capabilities;
  createRun: (params: CreateRunParams, onEvent: (e: RunEvent) => void) => Promise<CreateRunResult>;
  createTask: (params: CreateTaskParams) => Promise<CreatedTask>;
  listFlows: (params: ListFlowsParams) => Promise<{ flows: RepoFlowInfo[] }>;
  listProviders: (params: ListProvidersParams) => Promise<{ providers: RepoProviderInfo[] }>;
  readFlow: (params: ReadFlowParams) => Promise<{ doc: FlowDoc; source: string }>;
  writeFlow: (params: WriteFlowParams) => Promise<{ source: string }>;
}

/** Repo-scoped flow-file methods (S5). All ride the query pipe, Bound::Timed. */
export interface ListFlowsParams {
  repoPath: string;
}
/** Repo-scoped custom-provider listing (S6). Query pipe, Bound::Timed. */
export interface ListProvidersParams {
  repoPath: string;
}
/**
 * One configured custom provider on the wire: healthy (name, no error) or broken (error set;
 * index -1 = the whole-file pseudo-entry). `error` absent ⇔ runnable. No baseUrl/keyEnv here —
 * nothing in the UI consumes them (Settings edits app.json directly).
 */
// RepoProviderInfo lives in src/wire.ts (S7).
export type { RepoProviderInfo } from '../wire.js';
import type { RepoProviderInfo } from '../wire.js';
export interface ReadFlowParams {
  repoPath: string;
  file: string;
}
export interface WriteFlowParams {
  repoPath: string;
  file: string;
  doc: FlowDoc;
}

/**
 * A task to create on the configured transport. `source`/`label`/`team` come from AppConfig, read on
 * the TRUSTED side (Rust) — the renderer does not get to choose which tracker gets written to.
 */
export interface CreateTaskParams {
  source: string;
  repoPath: string;
  title: string;
  body: string;
  labels?: string[];
  /** Linear only: which team the issue lands in. */
  team?: string;
}

interface Request {
  id?: string;
  method?: string;
  params?: unknown;
}

/**
 * Validate a createTask request at the protocol boundary. This one creates something in an external
 * system and CANNOT be undone from inside the app, so every caller mistake must fail here — loudly,
 * before anything is written — rather than half-way through a transport.
 */
export function validateCreateTask(params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.source !== 'string' || !TRANSPORTS.includes(p.source as (typeof TRANSPORTS)[number])) {
    throw new BadRequestError(`source must be one of: ${TRANSPORTS.join(', ')}`);
  }
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '') {
    throw new BadRequestError('repoPath is required');
  }
  if (typeof p.title !== 'string' || p.title.trim() === '') {
    throw new BadRequestError('title is required');
  }
  if (typeof p.body !== 'string') {
    throw new BadRequestError('body must be a string');
  }
  if (p.source === 'linear' && (typeof p.team !== 'string' || p.team.trim() === '')) {
    // Without a team Linear would either fail deep in the API or land the issue in the caller's default
    // team — creating real work in the wrong place, with no undo.
    throw new BadRequestError('a Linear team key is required to create a task (set it in Settings)');
  }
}

/**
 * Validate a createRun request at the protocol boundary, before dispatch. Throws BadRequestError
 * for any caller mistake so it is classified `bad-request` rather than surfacing as `internal` deep
 * in the runner. Provider and flow are shape-checked only — repo customs/flows are legal values this
 * sync validator cannot see; both resolve as first statements of the createRun dep (bad-request).
 */
export function validateCreateRun(params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.issueRef !== 'string' || p.issueRef.trim() === '') {
    throw new BadRequestError('issueRef is required and must be a non-blank string');
  }
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '') {
    throw new BadRequestError('repoPath is required and must be a non-blank string');
  }
  // Only the string shape is checked here (like flow below): repo customProviders are legal values
  // and this validator is synchronous. Resolvability is a first statement of the createRun dep
  // (resolveRunChoice — before beginRun, before any sandbox cost), still kind `bad-request`.
  if (p.provider !== undefined && (typeof p.provider !== 'string' || p.provider.trim() === '')) {
    throw new BadRequestError(`provider must be a non-blank string, got ${String(p.provider)}`);
  }
  if (p.transport !== undefined && !(TRANSPORTS as readonly unknown[]).includes(p.transport)) {
    throw new BadRequestError(`unknown transport "${String(p.transport)}" — choose one of: ${TRANSPORTS.join(', ')}`);
  }
  // Only the string shape is checked here: repo `.vanguard/flows/*.hcl` flows are legal values and
  // this validator is synchronous. Resolvability is the createRun dep's first statement
  // (assertFlowResolvable — before beginRun, before any sandbox cost), still kind `bad-request`.
  if (p.flow !== undefined && (typeof p.flow !== 'string' || p.flow.trim() === '')) {
    throw new BadRequestError(`flow must be a non-blank string, got ${String(p.flow)}`);
  }
  if (p.maxTurns !== undefined && (typeof p.maxTurns !== 'number' || !Number.isInteger(p.maxTurns) || p.maxTurns <= 0)) {
    throw new BadRequestError(`maxTurns must be a positive integer, got ${String(p.maxTurns)}`);
  }
  if (p.baseBranch !== undefined && (typeof p.baseBranch !== 'string' || p.baseBranch.trim() === '')) {
    throw new BadRequestError(`baseBranch must be a non-blank string, got ${String(p.baseBranch)}`);
  }
}

/**
 * The flow-file methods read/write disk relative to repoPath, and the sidecar child inherits the
 * APP's cwd (it is spawned with no project cwd) — a relative repoPath would silently target some
 * other tree, so all three methods require an absolute one.
 */
function requireAbsoluteRepoPath(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '' || !isAbsolute(p.repoPath)) {
    throw new BadRequestError('repoPath is required and must be an absolute path');
  }
  return p;
}

function requireFlowFile(p: Record<string, unknown>): void {
  if (typeof p.file !== 'string' || !FLOW_FILE_RE.test(p.file)) {
    throw new BadRequestError('file must be a lowercase [a-z0-9._-] basename ending in .hcl');
  }
}

export function validateListFlows(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

export function validateListProviders(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

export function validateReadFlow(params: unknown): void {
  requireFlowFile(requireAbsoluteRepoPath(params));
}

/**
 * Validate a writeFlow request and return the coerced doc. Everything pure happens here, before
 * dispatch: shape + unknown-key rejection (the renderer sends a JS object, so parse's typo
 * protection never ran — a silently dropped field would survive the re-parse guard), the semantic
 * validity predicate, the canonical-filename rule, and the built-in collision. The
 * sibling-duplicate check needs fs and lives in the dep.
 */
export function validateWriteFlow(params: unknown): FlowDoc {
  const p = requireAbsoluteRepoPath(params);
  requireFlowFile(p);
  let doc: FlowDoc;
  try {
    doc = coerceFlowDoc(p.doc);
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err));
  }
  const problem = flowDocError(doc);
  if (problem !== undefined) throw new BadRequestError(problem);
  if (p.file !== `${doc.name}.hcl`) {
    throw new BadRequestError(`file name doesn't match flow name "${doc.name}" — rename the file to ${doc.name}.hcl to edit it in the app`);
  }
  if (Object.hasOwn(FLOWS, doc.name)) {
    throw new BadRequestError(`flow "${doc.name}" collides with a built-in flow — pick another name`);
  }
  return doc;
}

/**
 * Stdio JSON loop. Reads one request per line, writes correlated event/result/error lines.
 * DI on `deps` so the createRun event stream is testable without a real sandbox.
 */
export async function runSidecar(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  deps: SidecarDeps,
): Promise<void> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line === '') continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      write(JSON.stringify({ error: { message: 'invalid JSON', kind: 'bad-request' } }));
      continue;
    }
    const id = req.id;
    try {
      if (req.method === 'capabilities') {
        write(JSON.stringify({ id, result: deps.capabilities() }));
      } else if (req.method === 'createTask') {
        validateCreateTask(req.params);
        const result = await deps.createTask(req.params as CreateTaskParams);
        write(JSON.stringify({ id, result }));
      } else if (req.method === 'createRun') {
        validateCreateRun(req.params);
        const params = req.params as CreateRunParams;
        const result = await deps.createRun(params, (e) => write(JSON.stringify({ id, event: e })));
        write(JSON.stringify({ id, result }));
      } else if (req.method === 'listFlows') {
        validateListFlows(req.params);
        write(JSON.stringify({ id, result: await deps.listFlows(req.params as ListFlowsParams) }));
      } else if (req.method === 'listProviders') {
        validateListProviders(req.params);
        write(JSON.stringify({ id, result: await deps.listProviders(req.params as ListProvidersParams) }));
      } else if (req.method === 'readFlow') {
        validateReadFlow(req.params);
        write(JSON.stringify({ id, result: await deps.readFlow(req.params as ReadFlowParams) }));
      } else if (req.method === 'writeFlow') {
        const doc = validateWriteFlow(req.params);
        const params = req.params as WriteFlowParams;
        // Pass the coerced doc, not the raw one — the clean rebuild is what gets emitted.
        write(JSON.stringify({ id, result: await deps.writeFlow({ ...params, doc }) }));
      } else {
        write(JSON.stringify({ id, error: { message: `unknown method: ${String(req.method)}`, kind: 'bad-request' } }));
      }
    } catch (err) {
      // FlowError = a user-fixable flow-file problem (parse failure, duplicate, unknown flow) —
      // caller-correctable, so bad-request. `internal` stays reserved for real faults (fs, runner).
      const kind = err instanceof BadRequestError || err instanceof FlowError ? 'bad-request' : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      write(JSON.stringify({ id, error: { message, kind } }));
    }
  }
}
