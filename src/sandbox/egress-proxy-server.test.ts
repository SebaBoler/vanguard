// Boots the real standalone egress proxy (egress-proxy-server.mjs) as a child process and
// exercises its failure discipline. The proxy runs as container PID 1 under `--restart
// on-failure`, so the ONE fatal sin is exiting 0 on a failure: docker treats that as success and
// never restarts, leaving a port-closed "Up-looking" enclave that bricks every remaining stage
// with ConnectionRefused (dogfood #352, PR #353 review r1).
import { test, expect } from 'vitest';
import { execa } from 'execa';
import { connect, createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'egress-proxy-server.mjs');

function occupyPort(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ port, close: () => srv.close() });
    });
  });
}

test('a bind failure exits NONZERO so --restart on-failure engages — never a swallowed error and exit 0', async () => {
  const { port, close } = await occupyPort();
  try {
    const result = await execa('node', [serverPath], {
      env: { PORT: String(port), ALLOW: 'a.example' },
      reject: false,
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/EADDRINUSE|cannot bind/);
  } finally {
    close();
  }
});

test('serves after start: disallowed CONNECT gets 403 and the process stays alive', async () => {
  // PORT=0 ⇒ the OS picks a free port and the banner reports the ACTUAL one — no
  // release-then-rebind race with parallel test processes.
  const server = execa('node', [serverPath], {
    env: { PORT: '0', ALLOW: 'a.example' },
    reject: false,
    all: true,
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no banner')), 10_000);
      let buf = '';
      server.stdout?.on('data', (c: Buffer) => {
        buf += String(c);
        const m = /egress proxy on (\d+);/.exec(buf);
        if (m?.[1] !== undefined) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    const status = await new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n');
      });
      let d = '';
      s.on('data', (c) => {
        d += String(c);
        resolve(d.split('\r\n')[0] ?? '');
        s.destroy();
      });
      s.on('error', reject);
      setTimeout(() => reject(new Error('probe timeout')), 10_000);
    });
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(server.exitCode).toBeNull(); // still serving
  } finally {
    server.kill();
    await server.catch(() => {});
  }
});
