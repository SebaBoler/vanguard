import { describe, it, expect } from 'vitest';
import { alignTable } from './table.js';

describe('alignTable', () => {
  it('left-aligns and pads columns to the widest cell', () => {
    const out = alignTable([
      ['name', 'cost'],
      ['implementer', '0.3'],
      ['x', '10'],
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('name         cost');
    expect(lines[1]).toBe('implementer  0.3');
    expect(lines[2]).toBe('x            10');
  });

  it('returns empty string for no rows', () => {
    expect(alignTable([])).toBe('');
  });

  it('pads ragged rows with empty cells', () => {
    const out = alignTable([
      ['a', 'b', 'c'],
      ['x'],
    ]);
    expect(out.split('\n')[1]).toBe('x');
  });
});
