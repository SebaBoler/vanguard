// The hub's node:http entry point (spec §2.2): wires the RPC dispatcher (rpc.ts), the SSE bus
// (events.ts) and the static SPA server (static.ts) behind one listener. Same-origin only — this
// never emits Access-Control-Allow-Origin, so a page on another origin cannot read responses even
// if it can trigger the request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { serveStatic } from './static.js';
import { EventBus } from './events.js';
import { writeJson, jsonError } from './json-response.js';
import { dispatchRpc, classifyError, type RpcContext } from './rpc.js';
import { encodeError, encodeResult } from '../hub-wire.js';
import { ProjectAllowlist, type BindOptions } from './allowlist.js';
import { WatchRegistry, type WatchOptions } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry, type SpawnComplete } from './complete.js';
import { loadPaths } from './projects.js';
import { productionDeps } from '../sidecar/deps.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';

/**
 * `write_draft_asset` ships an image's bytes as a JSON array of numbers (comma-separated decimal —
 * several times the raw byte size), so the RPC body cap must clear a few MB of raw attachment data
 * by a wide margin, not just the biggest ordinary JSON payload.
 */
export const MAX_RPC_BODY_BYTES = 32 * 1024 * 1024;

export interface HubServerOptions {
  uiDir: string;
  configDir: string;
  browseRoot: string;
  /** Additional permitted clone hosts. */
  cloneHosts?: readonly string[];
  bind: BindOptions;
  /** The `--repo` seed, always allowed even before it reaches the persisted project store. */
  seedRepoPath?: string;
  /** Returned verbatim by `GET /healthz` (the package version). */
  version: string;
  watch?: WatchOptions;
  deps?: SidecarDeps;
  spawnComplete?: SpawnComplete;
}

export interface HubServer {
  readonly server: Server;
  readonly eventBus: EventBus;
  readonly allowlist: ProjectAllowlist;
  listen(port: number, host: string): Promise<void>;
  /** Graceful shutdown: ends every SSE client, stops project watchers, then closes the listener. */
  close(): Promise<void>;
}

function notFound(res: ServerResponse): void {
  jsonError(res, 404, 'not found', 'bad-request');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  const encoded = encodeError({ message: 'method not allowed', kind: 'bad-request' }, 405);
  writeJson(res, encoded.status, encoded.body, { allow });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Same-origin check for mutating routes: no Origin header (curl, same-process tooling) is allowed
 * through; a present Origin must match the request's own Host, or the request is cross-origin. This
 * guards against cross-site requests by host, not by scheme, so an HTTPS reverse proxy in front of
 * the hub (the VPS deployment) works with no extra configuration: the browser's `https://` Origin
 * still matches the `Host` header the hub sees, provided the proxy preserves the public Host. */
function sameOriginOk(req: IncomingMessage): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}

/**
 * Reads the full body before deciding, even once over `maxBytes` (dropping further chunks rather
 * than buffering them): destroying the socket mid-upload would race the client's own write and can
 * surface as a connection-reset instead of the 413 response. Draining to `end` lets the 413 (or any
 * other response) always reach the client cleanly.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new BodyTooLargeError('request body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function respondBodyTooLarge(res: ServerResponse): void {
  const encoded = encodeError({ message: 'request body too large', kind: 'bad-request' }, 413);
  writeJson(res, encoded.status, encoded.body, { connection: 'close' }, () => res.socket?.destroy());
}

async function handleRpcRequest(ctx: RpcContext, req: IncomingMessage, res: ServerResponse, cmd: string): Promise<void> {
  if (!sameOriginOk(req)) {
    jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
    return;
  }
  const contentType = singleHeader(req.headers['content-type']);
  if (contentType === undefined || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    jsonError(res, 400, 'Content-Type must be application/json', 'bad-request');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_RPC_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondBodyTooLarge(res);
      return;
    }
    jsonError(res, 400, 'invalid JSON body', 'bad-request');
    return;
  }

  try {
    const result = await dispatchRpc(ctx, cmd, body);
    // Spec §2.3: success is `{ result }` (null for void commands); apps/desktop/src/transport.ts reads
    // `body.result`. A bare body here left the UI with `undefined` projects on first paint.
    writeJson(res, 200, encodeResult(result));
  } catch (err) {
    const classified = classifyError(err);
    const status = classified.notFound ? 404 : classified.kind === 'bad-request' ? 400 : 500;
    jsonError(res, status, classified.message, classified.kind);
  }
}

async function handleRequest(
  ctx: RpcContext,
  eventBus: EventBus,
  opts: HubServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    writeJson(res, 200, { ok: true, version: opts.version });
    return;
  }

  if (pathname === '/events') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    eventBus.subscribe(req, res);
    res.flushHeaders();
    return;
  }

  if (pathname.startsWith('/rpc/')) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    await handleRpcRequest(ctx, req, res, pathname.slice('/rpc/'.length));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notFound(res);
    return;
  }

  const handled = await serveStatic({ uiDir: opts.uiDir }, req, res);
  if (!handled) notFound(res);
}

/** Build (but do not start) the hub's HTTP server. `listen`/`close` drive its lifecycle. */
export function createHubServer(opts: HubServerOptions): HubServer {
  const deps = opts.deps ?? productionDeps();
  const eventBus = new EventBus();
  eventBus.startKeepalive();
  const watchRegistry = new WatchRegistry(opts.watch);
  const publish = (name: string, payload: unknown): void => eventBus.publish(name, payload);
  const runSession = createRunSession(deps, publish);
  const completeRegistry = new CompleteRegistry(opts.spawnComplete);
  const allowlist = new ProjectAllowlist(() => loadPaths(opts.configDir), opts.seedRepoPath);

  const ctx: RpcContext = {
    allowlist,
    watchRegistry,
    runSession,
    completeRegistry,
    deps,
    configDir: opts.configDir,
    browseRoot: opts.browseRoot,
    ...(opts.cloneHosts !== undefined ? { cloneHosts: opts.cloneHosts } : {}),
    bind: opts.bind,
    publish,
  };

  const server = createServer((req, res) => {
    void handleRequest(ctx, eventBus, opts, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else jsonError(res, 500, 'internal server error', 'internal');
    });
  });

  return {
    server,
    eventBus,
    allowlist,
    listen: (port, host) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        watchRegistry.closeAll();
        eventBus.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
