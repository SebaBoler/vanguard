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
 * Parse Anthropic subscription unified rate-limit headers into a QuotaSnapshot.
 *
 * Real header names (confirmed from Anthropic docs/issues):
 *   anthropic-ratelimit-unified-status                   — overall: allowed | allowed_warning | rejected
 *   anthropic-ratelimit-unified-5h-utilization           — fraction (0..1) OR percent (0..100) of 5-hour window
 *   anthropic-ratelimit-unified-5h-reset                 — 5-hour window reset (epoch-s, epoch-ms, or ISO)
 *   anthropic-ratelimit-unified-5h-status                — per-window status string
 *   anthropic-ratelimit-unified-7d-utilization           — fraction (0..1) OR percent (0..100) of 7-day window
 *   anthropic-ratelimit-unified-7d-reset                 — 7-day window reset (epoch-s, epoch-ms, or ISO)
 *   anthropic-ratelimit-unified-7d-status                — per-window status string
 *   anthropic-ratelimit-unified-representative-claim     — informational: which window is authoritative
 *
 * Utilization-scale tolerance (deliberate calibration choice): the API returns a fraction (0..1) per
 * the spec, but to guard against a percent (0..100) representation we apply `pct = n <= 1 ? n*100 : n`.
 * This treats any value ≤1 as a fraction and any value >1 as already a percent.
 *
 * Priority: utilization windows (pick worst/highest) → status fallback → undefined (no data).
 * Returning undefined when no unified header is present lets callers ignore non-Anthropic responses.
 */
export function parseUnifiedRatelimit(headers, now = Date.now()) {
  // 1. Collect per-window utilization values.
  const windows = ['5h', '7d'];
  let worstPct = -Infinity;
  let worstReset = 0;
  let foundUtilization = false;

  for (const w of windows) {
    const rawUtil = headerValue(headers, `anthropic-ratelimit-unified-${w}-utilization`);
    if (rawUtil === undefined || rawUtil === '') continue;
    const num = Number(rawUtil);
    if (!Number.isFinite(num)) continue;
    // Tolerate fraction (0..1) or percent (0..100) — see note above.
    const pct = num <= 1 ? num * 100 : num;
    foundUtilization = true;
    if (pct > worstPct) {
      worstPct = pct;
      worstReset = parseResetMs(headerValue(headers, `anthropic-ratelimit-unified-${w}-reset`));
    }
  }

  if (foundUtilization) {
    return { usedPct: Math.round(worstPct), resetAt: worstReset, fetchedAt: now };
  }

  // 2. Fall back to status strings (overall status, then per-5h-window status).
  const status =
    headerValue(headers, 'anthropic-ratelimit-unified-status') ??
    headerValue(headers, 'anthropic-ratelimit-unified-5h-status');

  if (status === 'rejected') {
    return { usedPct: 100, resetAt: parseResetMs(headerValue(headers, 'anthropic-ratelimit-unified-5h-reset')), fetchedAt: now };
  }
  if (status === 'allowed_warning') {
    return { usedPct: 95, resetAt: parseResetMs(headerValue(headers, 'anthropic-ratelimit-unified-5h-reset')), fetchedAt: now };
  }
  if (status === 'allowed') {
    return { usedPct: 0, resetAt: parseResetMs(headerValue(headers, 'anthropic-ratelimit-unified-5h-reset')), fetchedAt: now };
  }

  // 3. No utilization values and no recognized status — surface as "no data".
  return undefined;
}

/** Atomically write a QuotaSnapshot as JSON (tmp file + rename). */
export function writeQuotaSnapshot(filePath, snap) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, filePath);
}
