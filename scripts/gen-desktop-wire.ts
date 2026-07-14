/**
 * Copy src/wire.ts (the shared TS↔TS contract, S7) into the desktop app, which lives in a
 * separate pnpm install with no import path into core. Byte-exact plus a header; the drift guard
 * (src/wire.test.ts) re-derives the same bytes and compares in root CI — the gen-flow-b pattern.
 *
 * Usage: pnpm gen:wire
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = '// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire\n';
const target = join(root, 'apps', 'desktop', 'src', 'wire.ts');

writeFileSync(target, HEADER + readFileSync(join(root, 'src', 'wire.ts'), 'utf8'));
console.log(`wrote ${target}`);
