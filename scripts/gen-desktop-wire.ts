/**
 * Copy src/wire.ts (the shared TS↔TS contract, S7) and src/hub-wire.ts (the hub's RPC/SSE/marker
 * codec) into the desktop app, which lives in a separate pnpm install with no import path into
 * core. Byte-exact plus a header; the drift guard (src/wire.test.ts) re-derives the same bytes and
 * compares in root CI — the gen-flow-b pattern.
 *
 * Usage: pnpm gen:wire
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['wire.ts', 'hub-wire.ts'];

for (const file of FILES) {
  const header = `// GENERATED from src/${file} — do not edit; run pnpm gen:wire\n`;
  const target = join(root, 'apps', 'desktop', 'src', file);
  writeFileSync(target, header + readFileSync(join(root, 'src', file), 'utf8'));
  console.log(`wrote ${target}`);
}
