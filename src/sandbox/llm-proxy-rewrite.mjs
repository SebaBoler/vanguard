// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// Authored as plain ESM `.mjs` so BOTH the strict-TS app and the zero-dep sidecar
// (`llm-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `llm-proxy-rewrite.d.mts`. The sidecar gets this file
// `docker cp`'d next to it so the relative `import './llm-proxy-rewrite.mjs'` resolves.
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';

export const OAUTH_BETA = 'oauth-2025-04-20';

/** Coerce a node header value (string | string[] | undefined) to a single comma-joined string. */
function betaToString(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming, extra) {
  const parts = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

/**
 * Headers to apply upstream for the chosen auth mode. Returns lowercase keys to set; caller deletes any
 * conflicting inbound auth headers first. Subscription => Authorization: Bearer + oauth beta merged;
 * api => x-api-key, no oauth beta.
 */
export function upstreamAuthHeaders(auth, reqHeaders) {
  const beta = betaToString(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  // api mode: x-api-key, no oauth beta; pass through the request's anthropic-beta unchanged if present.
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

/**
 * Single source of truth for every upstream the sidecar can proxy, keyed by the UPSTREAM value in the
 * secret file. Add an upstream here and every consumer follows: host routing + allowlist drop
 * (UPSTREAMS[k].host), POST-path lockdown (.paths), auth scheme (.auth), and boot validation (`k in UPSTREAMS`).
 *
 * - host:  where the sidecar forwards (and the host dropped from the sandbox egress allowlist).
 * - paths: the ONLY POST paths tunnelled through (query string ignored, no wildcards) — the lockdown.
 * - auth:  how the real credential is presented upstream. 'anthropic' = mode-aware x-api-key OR
 *          Bearer+oauth-beta (upstreamAuthHeaders). 'bearer' = plain Authorization: Bearer SECRET
 *          (openaiAuthHeaders). z.ai is Anthropic-Messages-compatible on the WIRE (same paths) but
 *          authenticates with a plain bearer key, so it pairs anthropic paths with bearer auth.
 */
export const UPSTREAMS = {
  anthropic: { host: 'api.anthropic.com', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'anthropic' },
  openai: { host: 'api.openai.com', paths: ['/v1/responses'], auth: 'bearer' },
  // basePath: keep in sync with ZAI_BASE_URL in src/agents/zai.ts
  zai: { host: 'api.z.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'bearer', basePath: '/api/coding/paas/v4' },
};

/** Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored). */
export function isAllowedLlmPath(method, path, upstream = 'anthropic') {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const spec = UPSTREAMS[upstream];
  if (spec === undefined) return false;
  const p = (path ?? '').split('?')[0] ?? '';
  return spec.paths.includes(p);
}

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export function openaiAuthHeaders(secret) {
  return { authorization: `Bearer ${secret}` };
}

/** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
export function upstreamPath(upstream, reqUrl) {
  const spec = UPSTREAMS[upstream];
  return `${spec?.basePath ?? ''}${reqUrl ?? '/'}`;
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** First value of a possibly-array header. */
function headerValue(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Reset value -> epoch ms. Accepts epoch-seconds, epoch-ms, or an ISO string; 0 when absent/unparseable. */
function parseResetMs(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const iso = Date.parse(raw);
  return Number.isNaN(iso) ? 0 : iso;
}

/**
 * Parse Anthropic unified rate-limit headers into a QuotaSnapshot. Prefers remaining/limit (exact
 * percent); falls back to the status string (rejected=100, allowed_warning=95, allowed=0). Returns
 * undefined when no unified header is present (so callers can ignore non-Anthropic responses).
 * NOTE: confirm the exact header names against a real Claude response (Task 7 Step 6) and adjust the
 * three name constants if they differ — the parse logic is name-agnostic beyond these.
 */
export function parseUnifiedRatelimit(headers, now = Date.now()) {
  const status = headerValue(headers, 'anthropic-ratelimit-unified-status');
  const rawRemaining = headerValue(headers, 'anthropic-ratelimit-unified-remaining');
  const rawLimit = headerValue(headers, 'anthropic-ratelimit-unified-limit');
  const reset = headerValue(headers, 'anthropic-ratelimit-unified-reset');
  // Treat absent or empty-string as "not a number" — Number('') === 0 which would be a false signal.
  const remaining = (typeof rawRemaining === 'string' && rawRemaining !== '') ? Number(rawRemaining) : NaN;
  const limit = (typeof rawLimit === 'string' && rawLimit !== '') ? Number(rawLimit) : NaN;
  if (status === undefined && !Number.isFinite(remaining)) return undefined;
  let usedPct;
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    usedPct = Math.round(100 * (1 - remaining / limit));
  } else if (status === 'rejected') {
    usedPct = 100;
  } else if (status === 'allowed_warning') {
    usedPct = 95;
  } else if (status === 'allowed') {
    usedPct = 0;
  } else {
    // No usable remaining/limit and no recognized status — surface as "no data".
    return undefined;
  }
  return { usedPct, resetAt: parseResetMs(reset), fetchedAt: now };
}

/** Atomically write a QuotaSnapshot as JSON (tmp file + rename). */
export function writeQuotaSnapshot(filePath, snap) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, filePath);
}
