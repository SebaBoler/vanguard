// Thin node:http adapter over the hub-wire codec's error envelope, used by both server.ts
// (RPC/health/SSE routes) and static.ts (static-file routes) so the two don't drift onto
// different error shapes.
import type { ServerResponse } from 'node:http';
import { encodeError, type ErrorKind } from '../hub-wire.js';

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  onDone?: () => void,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body), onDone);
}

export function jsonError(res: ServerResponse, status: number, message: string, kind: ErrorKind): void {
  const encoded = encodeError({ message, kind }, status);
  writeJson(res, encoded.status, encoded.body);
}
