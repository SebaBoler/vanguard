import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';

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
        const params = req.params as CreateRunParams;
        const result = await deps.createRun(params, (e) => write(JSON.stringify({ id, event: e })));
        write(JSON.stringify({ id, result }));
      } else {
        write(JSON.stringify({ id, error: { message: `unknown method: ${String(req.method)}`, kind: 'bad-request' } }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write(JSON.stringify({ id, error: { message, kind: 'internal' } }));
    }
  }
}
