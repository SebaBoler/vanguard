#!/usr/bin/env node
// Standalone zero-dep LLM reverse-proxy for the host enclave sidecar. Holds the real Anthropic
// credential (read from a tmpfs file, never argv/env) and swaps it in for a per-run nonce, then
// forwards to api.anthropic.com. The pure logic lives in llm-proxy-rewrite.ts; keep auth/beta/path
// semantics in sync with that file.
//
// SECURITY: never log request/response headers, bodies, the secret, or the nonce. Inbound nonce
// check is constant-time. Locked down to POST /v1/messages and /v1/messages/count_tokens.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const OAUTH_BETA = 'oauth-2025-04-20';
const UPSTREAM_HOST = 'api.anthropic.com';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 8;
// Hop-by-hop headers must not be forwarded to the upstream.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// --- config: read MODE/SECRET/NONCE from the tmpfs file; PORT from env ---
const secretFile = process.env.LLM_PROXY_SECRET_FILE;
if (!secretFile) {
  console.error('llm-proxy: LLM_PROXY_SECRET_FILE is required');
  process.exit(1);
}
let secretText;
try {
  secretText = readFileSync(secretFile, 'utf8');
} catch {
  // Never log the error object or file contents (may carry path/secret hints).
  console.error('llm-proxy: cannot read secret file');
  process.exit(1);
}
const config = parseSecretFile(secretText);
if ((config.MODE !== 'subscription' && config.MODE !== 'api') || !config.SECRET || !config.NONCE) {
  console.error('llm-proxy: invalid secret file (need MODE=subscription|api, SECRET, NONCE)');
  process.exit(1);
}
// SECRET/NONCE are placed into HTTP headers; reject control chars to prevent header injection.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
if (CONTROL_CHARS.test(config.SECRET) || CONTROL_CHARS.test(config.NONCE)) {
  console.error('llm-proxy: secret/nonce contains control characters');
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? '8088');

function parseSecretFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key !== '') out[key] = value.replace(/\r$/, '');
  }
  return out;
}

// --- pure logic mirrored from llm-proxy-rewrite.ts ---
function betaToString(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

function mergeAnthropicBeta(incoming, extra) {
  const parts = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

function upstreamAuthHeaders(auth, reqHeaders) {
  const beta = betaToString(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

const ALLOWED = new Set(['/v1/messages', '/v1/messages/count_tokens']);
function isAllowedLlmPath(method, path) {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const p = (path ?? '').split('?')[0] ?? '';
  return ALLOWED.has(p);
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const auth = { mode: config.MODE, secret: config.SECRET };
const expectedAuthorization = `Bearer ${config.NONCE}`;

let inFlight = 0;

function finish(req, res, status, started) {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'text/plain' });
  }
  res.end();
  log(req, status, 0, started);
}

function log(req, status, bytes, started) {
  const ms = Date.now() - started;
  const path = (req.url ?? '').split('?')[0] ?? '';
  // ONLY method, path, status, byte count, duration — never headers/body/secret/nonce.
  console.log(`${req.method} ${path} -> ${status} (${bytes}B, ${ms}ms)`);
}

const server = createServer((req, res) => {
  const started = Date.now();

  if (!isAllowedLlmPath(req.method, req.url)) {
    finish(req, res, 404, started);
    req.resume();
    return;
  }

  const authorization = req.headers['authorization'] ?? '';
  if (!constantTimeEqual(authorization, expectedAuthorization)) {
    finish(req, res, 401, started);
    req.resume();
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    finish(req, res, 503, started);
    req.resume();
    return;
  }

  // We are now holding a concurrency slot; EVERY exit path must funnel through cleanup() exactly
  // once so inFlight is released and sockets are torn down. `done` makes cleanup() idempotent.
  inFlight += 1;
  let done = false;
  let upstream = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (upstream && !upstream.destroyed) upstream.destroy();
    if (!res.writableEnded) res.destroy();
  };

  // Buffer the request body with a hard size cap.
  const chunks = [];
  let size = 0;
  let overflow = false;

  req.on('data', (chunk) => {
    if (done || overflow) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      overflow = true;
      finish(req, res, 413, started);
      req.destroy();
      cleanup();
      return;
    }
    chunks.push(chunk);
  });

  // Client abort during buffering emits 'aborted'/'close' (not always 'error'); cover all of them.
  req.on('error', cleanup);
  req.on('aborted', cleanup);
  req.on('close', () => {
    // If the body never completed (no forward started yet), release the slot.
    if (!done && upstream === null) cleanup();
  });

  req.on('end', () => {
    if (done || overflow) return;
    const body = Buffer.concat(chunks, size);
    forward(req, res, body, started, (up) => {
      upstream = up;
    }, cleanup, () => done);
  });
});

function forward(req, res, body, started, setUpstream, cleanup, isDone) {
  // Strip inbound auth + hop-by-hop + host; then apply upstream auth headers.
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (value !== undefined) headers[lower] = value;
  }
  const applied = upstreamAuthHeaders(auth, req.headers);
  for (const [key, value] of Object.entries(applied)) headers[key] = value;
  headers['content-length'] = String(body.length);

  const path = req.url ?? '/';
  let responded = false;

  const upstream = httpsRequest(
    { host: UPSTREAM_HOST, port: 443, method: 'POST', path, headers },
    (upRes) => {
      responded = true;
      let bytes = 0;
      const outHeaders = {};
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (value !== undefined) outHeaders[key] = value;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.on('data', (chunk) => {
        bytes += chunk.length;
      });
      upRes.pipe(res);
      upRes.on('end', () => {
        log(req, upRes.statusCode ?? 502, bytes, started);
        cleanup();
      });
      upRes.on('error', cleanup);
    },
  );
  setUpstream(upstream);

  upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!responded && !res.headersSent) {
      finish(req, res, 504, started);
    }
    cleanup();
  });

  upstream.on('error', () => {
    if (!responded && !res.headersSent && !isDone()) {
      finish(req, res, 502, started);
    }
    cleanup();
  });

  // Client hung up after we started forwarding — abort upstream and release.
  res.on('close', cleanup);

  upstream.end(body);
}

server.listen(PORT, () => console.log(`llm-proxy on ${PORT}; mode=${config.MODE}`));
