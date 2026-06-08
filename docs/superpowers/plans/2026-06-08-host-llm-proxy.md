# Host LLM Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A trusted reverse-proxy sidecar that holds the real Anthropic credential so it never enters the sandbox; the sandbox calls the proxy with a per-run nonce and the proxy swaps in the real auth and forwards to api.anthropic.com.

**Architecture:** New `llm-proxy` sidecar on the egress enclave's internal network (alongside the existing CONNECT egress sidecar). `vanguard run/watch --llm-proxy` wires it: sandbox gets `ANTHROPIC_BASE_URL=http://<proxy>:PORT` + `ANTHROPIC_AUTH_TOKEN=<nonce>` and NO real Claude secret. The proxy validates the nonce, rewrites auth per mode (OAuth: `Authorization: Bearer <oauth>` + merged `anthropic-beta: oauth-2025-04-20`; API: `x-api-key: <key>`), locks down to `/v1/messages` + `/v1/messages/count_tokens`, and streams the upstream response back.

**Tech Stack:** TypeScript (ESM, NodeNext, strict, exactOptionalPropertyTypes), Vitest, zero-dep `.mjs` sidecar script (mirrors `egress-proxy-server.mjs`), `execa` for docker.

**Empirically confirmed (2026-06-08):** the OAuth subscription token (`sk-ant-oat01…`) authenticates as `Authorization: Bearer` on `https://api.anthropic.com/v1/messages` with `anthropic-beta: oauth-2025-04-20` → HTTP 200 (`claude-haiku-4-5-20251001`). Old model ids → 404 (not auth error). Whether the oauth-beta header is strictly *required* (vs merely accepted) is the one open question, deferred to a live integration check.

**Reference patterns (read before implementing):**
- Secret delivery via tmpfs + stdin (never `-e`, never argv): `src/sandbox/docker.ts` (`start()`, ~line 89; `secretsShellBody()`).
- Sidecar + internal network lifecycle: `src/sandbox/egress-network.ts` (`startEgressEnclave`: `docker network create --internal`, run sidecar on bridge, `network connect`, `docker cp` the `.mjs`, `docker exec -d node …`, `--label vanguard.runId=<id>`).
- Zero-dep sidecar server: `src/sandbox/egress-proxy-server.mjs`.
- Sandbox egress env: `src/sandbox/egress-proxy.ts` (`egressEnv` ~line 36 → only `NO_PROXY: 'localhost,127.0.0.1'` today; `DEFAULT_EGRESS_ALLOWLIST` line 6 includes `api.anthropic.com`).
- Auth source: `src/agents/auth.ts` (`authFromEnv()` → `{mode:'subscription',token}` | `{mode:'api',apiKey}`; `authSecrets`).
- gc reaps by label `vanguard.runId` (`src/core/gc.ts` `reapContainers`) and networks (`reapEgressNetworks`) — label the sidecar the same way so it is reaped.

---

## Security invariants (every task must preserve)

1. The real Anthropic secret reaches the sidecar ONLY via tmpfs+stdin (like docker.ts). Never `docker run/exec -e <secret>`, never argv. `docker inspect` of any container must not reveal it.
2. In `--llm-proxy` mode the sandbox receives NO real Claude secret — only the per-run nonce as `ANTHROPIC_AUTH_TOKEN`. `authSecrets()` for Claude is NOT injected into the sandbox.
3. `api.anthropic.com` is REMOVED from the sandbox's egress allowlist in this mode: the only outbound TLS to Anthropic is from the trusted sidecar. The sandbox has no direct route.
4. The proxy never logs request/response headers or bodies (which carry the nonce and prompt/output). Log only method, path, status, byte counts, duration.
5. Inbound nonce check is constant-time.

---

## Task 1: Proxy rewrite logic (pure, tested) + sidecar server

**Files:**
- Create: `src/sandbox/llm-proxy-rewrite.ts`
- Create: `src/sandbox/llm-proxy-rewrite.test.ts`
- Create: `src/sandbox/llm-proxy-server.mjs`

Pure functions live in the `.ts` (unit-tested); the `.mjs` sidecar reimplements them inline and is kept in sync (same precedent as `egress-proxy.ts` ↔ `egress-proxy-server.mjs`). Add a header comment in both files pointing at each other.

- [ ] **Step 1: Failing tests** (`llm-proxy-rewrite.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { mergeAnthropicBeta, upstreamAuthHeaders, isAllowedLlmPath, constantTimeEqual } from './llm-proxy-rewrite.js';

describe('mergeAnthropicBeta', () => {
  it('appends the oauth beta and dedupes, preserving request betas', () => {
    expect(mergeAnthropicBeta('foo-1,bar-2', 'oauth-2025-04-20')).toBe('foo-1,bar-2,oauth-2025-04-20');
    expect(mergeAnthropicBeta('oauth-2025-04-20,foo', 'oauth-2025-04-20')).toBe('oauth-2025-04-20,foo');
    expect(mergeAnthropicBeta(undefined, 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
});

describe('upstreamAuthHeaders', () => {
  it('subscription: Bearer + merged oauth beta, drops x-api-key', () => {
    const h = upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, { 'anthropic-beta': 'foo' });
    expect(h.authorization).toBe('Bearer oat');
    expect(h['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect('x-api-key' in h).toBe(false);
  });
  it('api: x-api-key, no oauth beta, no authorization', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, { 'anthropic-beta': 'foo' });
    expect(h['x-api-key']).toBe('sk-ant');
    expect('authorization' in h).toBe(false);
    expect(h['anthropic-beta']).toBe('foo'); // unchanged in api mode
  });
});

describe('isAllowedLlmPath', () => {
  it('allows only the two messages endpoints by POST', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true')).toBe(true); // query allowed
    expect(isAllowedLlmPath('GET', '/v1/messages')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/complete')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `llm-proxy-rewrite.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';

export type UpstreamAuth = { mode: 'subscription'; secret: string } | { mode: 'api'; secret: string };
export const OAUTH_BETA = 'oauth-2025-04-20';

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming: string | undefined, extra: string): string {
  const parts = (incoming ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

/**
 * Headers to apply upstream for the chosen auth mode. Returns lowercase keys to set; caller deletes any
 * conflicting inbound auth headers first. Subscription => Authorization: Bearer + oauth beta merged;
 * api => x-api-key, no oauth beta.
 */
export function upstreamAuthHeaders(auth: UpstreamAuth, reqHeaders: Record<string, string | undefined>): Record<string, string> {
  const beta = reqHeaders['anthropic-beta'];
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  return { 'x-api-key': auth.secret };
}

const ALLOWED = new Set(['/v1/messages', '/v1/messages/count_tokens']);
/** Only POST to the two Claude Code messages endpoints (query string ignored). */
export function isAllowedLlmPath(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const p = path.split('?')[0] ?? '';
  return ALLOWED.has(p);
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement `llm-proxy-server.mjs`** (zero-dep, mirrors the logic above inline; header comment: "keep auth/beta/path semantics in sync with llm-proxy-rewrite.ts").
  - Read config from a tmpfs file at `process.env.LLM_PROXY_SECRET_FILE` (KEY=VALUE lines: `MODE`, `SECRET`, `NONCE`); `PORT` from env.
  - `http.createServer`: reject if `!isAllowedLlmPath(req.method, req.url)` → 404. Validate `authorization` header equals `Bearer <NONCE>` constant-time → else 401. Enforce a max body size (e.g. 32 MiB) reading the request; on overflow 413 + destroy.
  - Build upstream request to `https://api.anthropic.com` with `https.request`: copy through `anthropic-version` and `content-type`; apply `upstreamAuthHeaders`; delete inbound `authorization`/`x-api-key`/`host`/hop-by-hop headers before applying. Pipe request body in, pipe response (status + headers + body, SSE-friendly) back out. Per-request timeout (~120s) → 504. Cap concurrency (e.g. 8 in-flight) → 503 when exceeded.
  - Logging: only `method path -> status (<bytes>B, <ms>ms)`. Never log headers, body, secret, or nonce.

- [ ] **Step 6: Commit** — `git commit -am "feat: logika i sidecar llm-proxy (rewrite auth + lockdown)"`.

---

## Task 2: `startLlmProxy` host orchestration

**Files:**
- Create: `src/sandbox/llm-proxy.ts`
- Create: `src/sandbox/llm-proxy.test.ts`

Starts the sidecar on a given (internal enclave) network + bridge, delivers the secret via stdin/tmpfs, returns the URL + nonce + destroy. Mirror `egress-network.ts` and `docker.ts` secret delivery.

- [ ] **Step 1: Test** (inject a fake docker runner `(args, opts?) => Promise<{exitCode}>`; assert: nonce is random + returned; the secret value never appears in any argv; the secret is written via a stdin `input` to `sh -c 'umask 077; cat > <file>'`; the server is started with `docker exec -d … node …` and `LLM_PROXY_SECRET_FILE`/`PORT` via `-e` (these are non-secret); `--label vanguard.runId=<id>` present; destroy removes the container).

```ts
import { describe, it, expect } from 'vitest';
import { startLlmProxy } from './llm-proxy.js';

function fakeDocker() {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], opts?: { input?: string }) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

it('delivers the secret off-argv and returns url + nonce', async () => {
  const d = fakeDocker();
  const proxy = await startLlmProxy({ network: 'vg-egr-x', auth: { mode: 'subscription', secret: 'OAT-SECRET' }, docker: d.run });
  expect(proxy.url).toMatch(/^http:\/\/vg-llm-.*:\d+$/);
  expect(proxy.nonce.length).toBeGreaterThanOrEqual(16);
  const flat = d.calls.flatMap((c) => c.args).join(' ');
  expect(flat).not.toContain('OAT-SECRET'); // never on argv
  expect(d.calls.some((c) => c.input?.includes('OAT-SECRET'))).toBe(true); // delivered via stdin
  await proxy.destroy();
  expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `startLlmProxy`**
  - Signature: `startLlmProxy(opts: { network: string; auth: { mode: 'subscription'|'api'; secret: string }; image?: string; docker?: DockerRunner }): Promise<{ url; nonce; destroy }>`.
  - `id = randomUUID().slice(0,8)`, name `vg-llm-${id}`, PORT 8088, secretFile `/tmp/llm-proxy-secret`.
  - `nonce = randomUUID().replace(/-/g,'')` (or randomBytes hex).
  - docker run on bridge `-d --name <name> --label vanguard.runId=<id> <image> sleep infinity`; `network connect <network> <name>`; `docker cp` the bundled `llm-proxy-server.mjs` (resolve via `fileURLToPath(new URL('./llm-proxy-server.mjs', import.meta.url))`) to `<name>:/tmp/llm-proxy.mjs`; write secret file via `docker exec -i <name> sh -c 'umask 077; cat > /tmp/llm-proxy-secret'` with `input = "MODE=…\nSECRET=…\nNONCE=…\n"`; start `docker exec -d -e LLM_PROXY_SECRET_FILE=… -e PORT=8088 <name> node /tmp/llm-proxy.mjs`.
  - `url = http://${name}:8088` (reachable inside the internal network by container name). Return `{ url, nonce, destroy }`; destroy = `docker rm -f <name>` (reject:false).
  - Wrap failures in `SandboxError`, tearing down on error (mirror egress-network).
  - Note: the existing `reapContainers` (label `vanguard.runId`) already reaps this sidecar on gc — no gc change needed; add a one-line comment saying so.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `git commit -am "feat: startLlmProxy (sidecar, sekret przez stdin)"`.

---

## Task 3: Egress env integration (NO_PROXY + allowlist without anthropic)

**Files:**
- Modify: `src/sandbox/egress-proxy.ts`
- Modify: `src/sandbox/egress-proxy.test.ts` (or create if absent)

- [ ] **Step 1: Tests**
  - `egressEnv(proxyUrl, { noProxy: ['vg-llm-abc'] })` → `NO_PROXY` contains `localhost,127.0.0.1,vg-llm-abc`.
  - `egressEnv(proxyUrl)` unchanged (`localhost,127.0.0.1`) — backward compatible.
  - A new `llmProxyAllowlist()` (or `allowlistWithout(DEFAULT_EGRESS_ALLOWLIST, 'api.anthropic.com')`) returns the default allowlist minus `api.anthropic.com`.

- [ ] **Step 2: Implement**
  - `egressEnv(proxyUrl: string, opts: { noProxy?: readonly string[] } = {})`: `NO_PROXY: ['localhost','127.0.0.1', ...(opts.noProxy ?? [])].join(',')`; rest unchanged. (`exactOptionalPropertyTypes`: spread conditionally.)
  - Export `allowlistWithout(list, host)` (pure filter) used by the runner to drop `api.anthropic.com` when the llm-proxy is active.

- [ ] **Step 3: Run → PASS. Step 4: Commit** — `git commit -am "feat: egressEnv noProxy + allowlistWithout dla llm-proxy"`.

---

## Task 4: CLI + runner wiring (`--llm-proxy`)

**Files:**
- Modify: `src/cli/args.ts`, `src/cli/args.test.ts`
- Modify: `src/cli/run.ts`, `src/cli/watch.ts`
- Modify: `src/runners/linear.ts`, `src/runners/github.ts`
- Modify: `README.md`

- [ ] **Step 1: args** — add boolean `llm-proxy`; on run + watch Command add `llmProxy?: boolean` (set only when true). Add a test: `parseCli(['run','--linear','TES-1','--llm-proxy'])` → `llmProxy === true`; absent → key omitted. Document in USAGE: `--llm-proxy  Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies --egress).`

- [ ] **Step 2: runners** — `RunLinearIssueDeps`/`RunGithubIssueDeps` gain `llmProxy?: boolean`. When set, in `runLinearIssue`/`runGithubIssue`:
  - require the enclave: build/receive an internal network (this mode implies egress). Reuse the enclave the CLI already creates (pass `network`/`proxyUrl` as today) and additionally start `startLlmProxy({ network, auth })` where `auth = deps.auth` (the real secret). 
  - sandbox secrets: OMIT Claude `authSecrets` (do NOT inject the real token). Keep `LINEAR_API_KEY` (linear) / provider keys as before.
  - sandbox env: merge `egressEnv(proxyUrl, { noProxy: [llmProxyHost] })` with `{ ANTHROPIC_BASE_URL: llmProxy.url, ANTHROPIC_AUTH_TOKEN: llmProxy.nonce }`.
  - destroy the llm-proxy in `finally`.
  - NOTE: keep the non-llm-proxy path byte-for-byte unchanged.
- [ ] **Step 3: cli/run.ts + cli/watch.ts** — `--llm-proxy` requires/forces the egress enclave (it already exists behind `--egress`; when `--llm-proxy` is set, enable the enclave even if `--egress` was not passed). Use `allowlistWithout(DEFAULT_EGRESS_ALLOWLIST, 'api.anthropic.com')` for the enclave's allowlist in this mode. Thread `llmProxy` into deps.
- [ ] **Step 4: README** — short "Host LLM proxy" subsection under Security: what it does, the flag, the invariant (real key never in the sandbox; only a per-run nonce), and that it currently covers Claude (Codex/Cursor later).
- [ ] **Step 5: typecheck + full test → PASS. Step 6: Commit** — `git commit -am "feat: vanguard run/watch --llm-proxy (sekret poza sandboxem)"`.

---

## Verification

1. `pnpm typecheck && pnpm test` green.
2. `docker inspect` of the llm-proxy sidecar shows no secret in `Config.Env`; the secret appears only in the in-RAM secret file.
3. (Live, optional, needs real OAuth) `vanguard run --linear <id> --llm-proxy`: the run completes against api.anthropic.com via the sidecar; confirm whether the `oauth-2025-04-20` beta is required by toggling it in the sidecar. The sandbox env has `ANTHROPIC_AUTH_TOKEN=<nonce>`, never the real token.

## Conventions
- Polish commit messages, short, NO co-author. English code/comments. `.js` import extensions. Strict TS, no `any`.
