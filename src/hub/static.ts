// Serves the built apps/desktop/dist SPA, injecting the hub marker into index.html so the browser
// bundle's transport.ts picks the hub (fetch/SSE) branch instead of Tauri's invoke/listen.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HUB_MARKER_SCRIPT = '<script>window.__VANGUARD_HUB__=true</script>';

/** Inject the hub marker immediately after `<head>`. Pure string function (its own test target).
 * Throws if no insertion point is found — a silent no-op here means the browser silently takes the
 * Tauri branch and every call throws, which must fail loudly at startup instead. */
export function injectHubMarker(html: string): string {
  const idx = html.indexOf('<head>');
  if (idx === -1) throw new Error('index.html has no <head> — cannot inject the hub marker');
  const insertAt = idx + '<head>'.length;
  return html.slice(0, insertAt) + HUB_MARKER_SCRIPT + html.slice(insertAt);
}

function isSafeRelativePath(p: string): boolean {
  const normalized = normalize(p);
  return !normalized.startsWith('..') && !normalized.startsWith(sep) && !normalized.includes(`..${sep}`);
}

export interface StaticOptions {
  uiDir: string;
}

/**
 * Handle one static GET request. Returns true if it handled (and ended) the response, false if the
 * caller should try another route (e.g. this wasn't a GET, or isn't a path this server owns — never
 * happens here since everything non-/rpc,/events falls through to the SPA, but kept for composability).
 */
export async function serveStatic(opts: StaticOptions, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const rawPath = decodeURIComponent(url.pathname);

  if (!isSafeRelativePath(rawPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', kind: 'bad-request' } }));
    return true;
  }

  const hasExtension = extname(rawPath) !== '';
  if (hasExtension && rawPath !== '/') {
    const filePath = join(opts.uiDir, rawPath);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(body);
      return true;
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', kind: 'bad-request' } }));
      return true;
    }
  }

  // SPA fallback: any extensionless path (including `/`) serves index.html with the hub marker.
  try {
    const raw = await readFile(join(opts.uiDir, 'index.html'), 'utf8');
    const html = injectHubMarker(raw);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return true;
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `cannot read ${join(opts.uiDir, 'index.html')} — build the desktop app first: pnpm --dir apps/desktop build`,
          kind: 'internal',
        },
      }),
    );
    return true;
  }
}

function contentType(filePath: string): string {
  const ext = extname(filePath);
  switch (ext) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ico':
      return 'image/x-icon';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}
