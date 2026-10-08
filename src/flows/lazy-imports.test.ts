import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S5 Constraint 5 guard: @cdktf/hcl2json gunzips and instantiates its WASM at require time, so it
 * must be unreachable through STATIC imports from the CLI run path and the sidecar deps — only
 * repo.ts's `await import('./parse.js')` may load it, at first flow-method call. This walks the
 * static import graph from both entry seams so a later "cleanup" to a static import fails here
 * instead of silently slowing every `vanguard` invocation.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
    // type-only imports are erased at runtime
    .replace(/import\s+type[\s\S]*?from\s+'[^']+';?/g, '')
    // dynamic import() is the lazy boundary itself — not a static edge
    .replace(/import\(/g, 'IMPORT_CALL(');
  const specs: string[] = [];
  for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'/g)) specs.push(m[1]!);
  for (const m of text.matchAll(/(?:^|\n)import\s+'([^']+)'/g)) specs.push(m[1]!);
  return specs;
}

function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of staticImports(file)) {
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return { files, bare };
}

test.each([
  ['the CLI run path', resolve(SRC, 'runners/source-adapter.ts')],
  ['the sidecar deps', resolve(SRC, 'sidecar/deps.ts')],
])('%s never statically imports the WASM parser', (_label, entry) => {
  const { files, bare } = walk(entry);
  // positive control: the graph does reach the flows layer — otherwise this proves nothing
  expect([...files].some((f) => f.endsWith('flows/repo.ts'))).toBe(true);
  expect([...files].some((f) => f.endsWith('flows/parse.ts'))).toBe(false);
  expect([...bare]).not.toContain('@cdktf/hcl2json');
});
