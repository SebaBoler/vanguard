import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { LlmProxyDep } from './llm-proxy.js';

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'api.linear.app',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
];

/** True if host equals an allowlist entry or is a subdomain of one (so `github.com.evil.com` is denied). */
export function isAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

export interface EgressProxy {
  port: number;
  /** Proxy URL as seen from inside the sandbox (the host is reachable as host.docker.internal). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Sandbox env that routes HTTP(S) through the egress proxy (localhost stays direct). NODE_USE_ENV_PROXY
 * makes Node 24's fetch/undici honor the proxy too, so the agent's own API traffic is covered in the
 * hard (internal-network) enclave, not just shell tools.
 */
export function egressEnv(proxyUrl: string, opts: { noProxy?: readonly string[] } = {}): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: ['localhost', '127.0.0.1', ...(opts.noProxy ?? [])].join(','),
    NODE_USE_ENV_PROXY: '1',
  };
}

/**
 * Build the sandbox env for a runner: undefined when there's no egress proxy (direct mode); otherwise
 * the egress proxy vars, plus — when an LLM-proxy sidecar owns Claude — its host in NO_PROXY and the
 * ANTHROPIC_BASE_URL/AUTH_TOKEN that point Claude at the sidecar with the per-run nonce (never the real
 * secret). Single source for the nested ternary the runners used to duplicate.
 */
export function llmProxySandboxEnv(
  proxyUrl: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Record<string, string> | undefined {
  if (proxyUrl === undefined) return undefined;
  const base = egressEnv(proxyUrl, llmProxy !== undefined ? { noProxy: [llmProxy.host] } : {});
  if (llmProxy === undefined) return base;
  return { ...base, ANTHROPIC_BASE_URL: llmProxy.url, ANTHROPIC_AUTH_TOKEN: llmProxy.nonce };
}

/** Returns the allowlist minus exact matches of `host` (e.g. drop api.anthropic.com when a trusted sidecar owns it). */
export function allowlistWithout(list: readonly string[], host: string): string[] {
  return list.filter((entry) => entry !== host);
}

/**
 * A forward proxy that only tunnels HTTPS CONNECT to allowlisted domains (others get 403). Phase 1
 * (soft) egress control: point the sandbox's HTTPS_PROXY at this. It does not block a sandbox that
 * bypasses the proxy — kernel-level enforcement is phase 2.
 */
export async function startEgressProxy(opts: { allowlist?: readonly string[]; port?: number } = {}): Promise<EgressProxy> {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const server = createServer((_req, res) => {
    res.writeHead(405).end('This proxy only supports HTTPS CONNECT.');
  });

  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? '';
    const sep = target.lastIndexOf(':');
    const host = sep > 0 ? target.slice(0, sep) : target;
    const port = sep > 0 ? Number(target.slice(sep + 1)) : 443;
    if (host === '' || !Number.isInteger(port) || !isAllowed(host, allowlist)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://host.docker.internal:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
