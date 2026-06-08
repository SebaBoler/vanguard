import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { isAllowed, startEgressProxy, egressEnv, allowlistWithout, DEFAULT_EGRESS_ALLOWLIST } from './egress-proxy.js';

describe('isAllowed', () => {
  it('allows exact domains and subdomains, denies look-alikes', () => {
    expect(isAllowed('api.anthropic.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    expect(isAllowed('codeload.github.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    expect(isAllowed('sub.github.com', ['github.com'])).toBe(true);
    expect(isAllowed('github.com.evil.com', ['github.com'])).toBe(false);
    expect(isAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(isAllowed('exfiltrate.me', DEFAULT_EGRESS_ALLOWLIST)).toBe(false);
  });
});

describe('egressEnv', () => {
  it('keeps NO_PROXY at localhost,127.0.0.1 and routes proxy vars (backward compatible)', () => {
    const url = 'http://host.docker.internal:1234';
    const env = egressEnv(url);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.HTTP_PROXY).toBe(url);
    expect(env.HTTPS_PROXY).toBe(url);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('appends extra noProxy hosts', () => {
    const env = egressEnv('http://host.docker.internal:1234', { noProxy: ['vg-llm-abc'] });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,vg-llm-abc');
  });
});

describe('allowlistWithout', () => {
  it('drops exact host matches and keeps the other defaults', () => {
    const result = allowlistWithout(DEFAULT_EGRESS_ALLOWLIST, 'api.anthropic.com');
    expect(result).not.toContain('api.anthropic.com');
    expect(result).toContain('api.linear.app');
    expect(result).toContain('github.com');
    expect(result).toContain('registry.npmjs.org');
  });
});

describe('startEgressProxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Open a CONNECT tunnel through the proxy to a local upstream; resolve with the status code.
  function connectVia(proxyPort: number, target: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ port: proxyPort, method: 'CONNECT', path: target });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('tunnels CONNECT to an allowlisted host and 403s the rest', async () => {
    const upstream: Server = createServer((s) => s.end());
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = await startEgressProxy({ allowlist: ['127.0.0.1'] });
    cleanups.push(proxy.close);

    expect(await connectVia(proxy.port, `127.0.0.1:${upstreamPort}`)).toBe(200);

    const denying = await startEgressProxy({ allowlist: ['example.com'] });
    cleanups.push(denying.close);
    expect(await connectVia(denying.port, `127.0.0.1:${upstreamPort}`)).toBe(403);
  });
});
