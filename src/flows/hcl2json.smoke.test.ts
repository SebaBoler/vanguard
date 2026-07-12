import { test, expect } from 'vitest';
import { parse } from '@cdktf/hcl2json';

test('hcl2json parses a labeled block from ESM', async () => {
  const json = await parse('t.hcl', 'flow "x" { label = "y" }');
  expect(json).toHaveProperty('flow');
  expect((json as { flow: { x: unknown[] } }).flow.x).toBeDefined();
});
