import { isProviderName, PROVIDER_NAMES } from '../agents/registry.js';
import { FLOWS, TRANSPORTS } from '../api/capabilities.js';
import { VanguardError } from '../core/errors.js';
import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';
import type { CreatedTask } from '../tasks/create.js';

/** A caller mistake in a request (bad params, unknown method) — classified `kind: "bad-request"`. */
export class BadRequestError extends VanguardError {}

/** Typed projection of a run request — a subset of RunOptions plus the issue ref and transport. */
export interface CreateRunParams {
  issueRef: string;
  /** Absolute path to the target project repo. Required — the sidecar child has no project cwd. */
  repoPath: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

/**
 * What the sidecar forwards back to the client — the run's PR outcome. A structural subset of the
 * runner's RunIssueResult (which the production deps return directly); the sidecar never reads `task`.
 */
export interface CreateRunResult {
  prUrl?: string;
  secretBlocked?: boolean;
}

export interface SidecarDeps {
  capabilities: () => Capabilities;
  createRun: (params: CreateRunParams, onEvent: (e: RunEvent) => void) => Promise<CreateRunResult>;
  createTask: (params: CreateTaskParams) => Promise<CreatedTask>;
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
 * in the runner. Provider/flow are checked against the real registries (PROVIDER_NAMES, FLOWS) so an
 * unknown value fails here instead of silently defaulting.
 */
export function validateCreateRun(params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.issueRef !== 'string' || p.issueRef.trim() === '') {
    throw new BadRequestError('issueRef is required and must be a non-blank string');
  }
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '') {
    throw new BadRequestError('repoPath is required and must be a non-blank string');
  }
  if (p.provider !== undefined && (typeof p.provider !== 'string' || !isProviderName(p.provider))) {
    throw new BadRequestError(`unknown provider "${String(p.provider)}" — choose one of: ${PROVIDER_NAMES.join(', ')}`);
  }
  if (p.transport !== undefined && !(TRANSPORTS as readonly unknown[]).includes(p.transport)) {
    throw new BadRequestError(`unknown transport "${String(p.transport)}" — choose one of: ${TRANSPORTS.join(', ')}`);
  }
  if (p.flow !== undefined && (typeof p.flow !== 'string' || !Object.hasOwn(FLOWS, p.flow))) {
    throw new BadRequestError(`unknown flow "${String(p.flow)}" — choose one of: ${Object.keys(FLOWS).join(', ')}`);
  }
  if (p.maxTurns !== undefined && (typeof p.maxTurns !== 'number' || !Number.isInteger(p.maxTurns) || p.maxTurns <= 0)) {
    throw new BadRequestError(`maxTurns must be a positive integer, got ${String(p.maxTurns)}`);
  }
  if (p.baseBranch !== undefined && (typeof p.baseBranch !== 'string' || p.baseBranch.trim() === '')) {
    throw new BadRequestError(`baseBranch must be a non-blank string, got ${String(p.baseBranch)}`);
  }
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
      } else {
        write(JSON.stringify({ id, error: { message: `unknown method: ${String(req.method)}`, kind: 'bad-request' } }));
      }
    } catch (err) {
      const kind = err instanceof BadRequestError ? 'bad-request' : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      write(JSON.stringify({ id, error: { message, kind } }));
    }
  }
}
