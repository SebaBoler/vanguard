#!/usr/bin/env node
// Standalone zero-dep CONNECT proxy for the egress enclave sidecar. Only tunnels HTTPS CONNECT to
// allowlisted domains (others 403). ALLOW (comma-separated) and PORT come from env. The allow
// semantics (exact or subdomain) are imported from the shared `egress-allow.mjs`, which the host
// `docker cp`'s next to this file — the SAME module egress-proxy.ts uses, so the two never drift.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { writeSync } from 'node:fs';
import { isAllowed } from './egress-allow.mjs';

// Synchronous stdout: `docker logs` reads a pipe, and async console.log buffers can be dropped by
// process.exit — the crash evidence is the point, so it must flush before death (PR #353 review).
const log = (line) => writeSync(1, `${line}\n`);

const ALLOW = (process.env.ALLOW ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const PORT = Number(process.env.PORT ?? '8080');

const allowed = (host) => isAllowed(host, ALLOW);

// The proxy must not die silently mid-run (dogfood #352: a dead proxy bricks every remaining
// stage with ConnectionRefused). It runs as container PID 1 under `--restart on-failure`, so the
// right response to the unexpected is: write the reason to stdout (docker logs) and let docker
// restart a fresh process — never a silent exit, never limping on in unknown state.
process.on('uncaughtException', (err) => {
  log(`egress proxy crashed: ${err?.stack ?? err}`);
  process.exit(1);
});

createServer((_req, res) => res.writeHead(405).end('This proxy only supports HTTPS CONNECT.'))
  .on('error', (err) => {
    // A listen-time failure (EADDRINUSE, EACCES) MUST be fatal-nonzero: swallowing it ends the
    // process with exit 0, which --restart on-failure reads as success — the port-closed brick
    // this server exists to prevent (PR #353 review). Accept-level errors (EMFILE) keep serving.
    if (err.syscall === 'listen') {
      log(`egress proxy cannot bind: ${err}`);
      process.exit(1);
    }
    log(`egress proxy server error: ${err}`);
  })
  .on('clientError', (_err, socket) => socket.destroy())
  .on('connect', (req, clientSocket, head) => {
    const target = req.url ?? '';
    const sep = target.lastIndexOf(':');
    const host = sep > 0 ? target.slice(0, sep) : target;
    const port = sep > 0 ? Number(target.slice(sep + 1)) : 443;
    if (host === '' || !Number.isInteger(port) || !allowed(host)) {
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
  })
  .listen(PORT, () => console.log(`egress proxy on ${PORT}; allow=${ALLOW.join(',')}`));
