// Shared `{ error: { message, kind } }` envelope used by both server.ts (RPC/health/SSE routes)
// and static.ts (static-file routes) so the two don't drift onto different error shapes.
import type { ServerResponse } from 'node:http';
import type { ErrorKind } from './rpc.js';

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: ServerResponse, status: number, message: string, kind: ErrorKind): void {
  writeJson(res, status, { error: { message, kind } });
}
