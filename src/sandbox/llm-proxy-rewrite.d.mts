// Type declarations for the plain-ESM `llm-proxy-rewrite.mjs` so the strict-TS app keeps types.
export type Upstream = 'anthropic' | 'openai' | 'zai';
export type UpstreamAuth = { mode: 'subscription'; secret: string } | { mode: 'api'; secret: string };

/** One upstream's wiring: forward host, allowed POST paths, and auth scheme. */
export interface UpstreamSpec {
  host: string;
  paths: readonly string[];
  auth: 'anthropic' | 'bearer';
}

/** Single source of truth for every proxiable upstream, keyed by the secret file's UPSTREAM value. */
export declare const UPSTREAMS: Record<Upstream, UpstreamSpec>;

export declare const OAUTH_BETA: 'oauth-2025-04-20';

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export declare function mergeAnthropicBeta(incoming: string | string[] | undefined, extra: string): string;

/**
 * Headers to apply upstream for the chosen auth mode. Subscription => Authorization: Bearer + oauth beta
 * merged; api => x-api-key, no oauth beta.
 */
export declare function upstreamAuthHeaders(
  auth: UpstreamAuth,
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string>;

/**
 * Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored).
 * anthropic => /v1/messages, /v1/messages/count_tokens. openai => /v1/responses only.
 * zai => same paths as anthropic (z.ai's coding endpoint is Anthropic-compatible). Defaults to anthropic.
 */
export declare function isAllowedLlmPath(method: string, path: string, upstream?: Upstream): boolean;

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export declare function openaiAuthHeaders(secret: string): Record<string, string>;

/** Constant-time string compare (length-safe). */
export declare function constantTimeEqual(a: string, b: string): boolean;
