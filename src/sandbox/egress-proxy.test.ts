import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { isAllowed, startEgressProxy, DEFAULT_EGRESS_ALLOWLIST } from './egress-proxy.js';

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
