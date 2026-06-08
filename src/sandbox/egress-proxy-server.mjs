#!/usr/bin/env node
// Standalone zero-dep CONNECT proxy for the egress enclave sidecar. Only tunnels HTTPS CONNECT to
// allowlisted domains (others 403). ALLOW (comma-separated) and PORT come from env. The allow
// semantics (exact or subdomain) are imported from the shared `egress-allow.mjs`, which the host
// `docker cp`'s next to this file — the SAME module egress-proxy.ts uses, so the two never drift.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { isAllowed } from './egress-allow.mjs';

const ALLOW = (process.env.ALLOW ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const PORT = Number(process.env.PORT ?? '8080');

const allowed = (host) => isAllowed(host, ALLOW);

createServer((_req, res) => res.writeHead(405).end('This proxy only supports HTTPS CONNECT.'))
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
