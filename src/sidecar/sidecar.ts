import { isProviderName, PROVIDER_NAMES } from '../agents/registry.js';
import { FLOWS, TRANSPORTS } from '../api/capabilities.js';
import { VanguardError } from '../core/errors.js';
import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';

/** A caller mistake in a request (bad params, unknown method) — classified `kind: "bad-request"`. */
export class BadRequestError extends VanguardError {}

/** Typed projection of a run request — a subset of RunOptions plus the issue ref and transport. */
export interface CreateRunParams {
  issueRef: string;
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
}

interface Request {
  id?: string;
  method?: string;
  params?: unknown;
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
