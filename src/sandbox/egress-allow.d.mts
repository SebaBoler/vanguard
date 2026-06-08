// Type declarations for the plain-ESM `egress-allow.mjs` so the strict-TS app keeps types.

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export declare const DEFAULT_EGRESS_ALLOWLIST: readonly string[];

/** True if host equals an allowlist entry or is a subdomain of one (so `github.com.evil.com` is denied). */
export declare function isAllowed(host: string, allowlist: readonly string[]): boolean;
