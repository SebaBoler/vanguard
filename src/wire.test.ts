import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIRE_PROVIDER_NAMES } from './wire.js';
import { PROVIDER_NAMES } from './agents/registry.js';

// Mirrors scripts/gen-desktop-wire.ts (which cannot be imported from src/ — rootDir). The
// duplication is self-checking: if either side changes header or paths, the byte compare fails.
const WIRE_HEADER = '// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire\n';
const CORE_WIRE = join(__dirname, 'wire.ts');
const DESKTOP_WIRE = join(__dirname, '..', 'apps', 'desktop', 'src', 'wire.ts');

describe('wire contract (S7)', () => {
  it('desktop copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    expect(readFileSync(DESKTOP_WIRE, 'utf8')).toBe(WIRE_HEADER + readFileSync(CORE_WIRE, 'utf8'));
  });

  it('wire.ts imports nothing — static, dynamic, or require (webview-safe by construction)', () => {
    const source = readFileSync(CORE_WIRE, 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('WIRE_PROVIDER_NAMES mirrors the registry, including order (the one underivable wire value)', () => {
    expect([...WIRE_PROVIDER_NAMES]).toEqual(PROVIDER_NAMES);
  });
});
