import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractTag, extractJson, hasTerminationSignal } from './extract.js';

describe('extractTag', () => {
  it('returns inner text of the last matching tag', () => {
    expect(extractTag('a <plan>one</plan> b <plan>two</plan>', 'plan')).toBe('two');
  });
  it('returns undefined when absent', () => {
    expect(extractTag('nothing', 'plan')).toBeUndefined();
  });
});

describe('extractJson', () => {
  const schema = z.object({ steps: z.array(z.string()) });
  it('parses JSON inside a tag against a schema', () => {
    expect(extractJson('<plan>{"steps":["x","y"]}</plan>', 'plan', schema).steps).toEqual(['x', 'y']);
  });
  it('parses JSON wrapped in a code fence', () => {
    expect(extractJson('<plan>```json\n{"steps":["z"]}\n```</plan>', 'plan', schema).steps).toEqual(['z']);
  });
  it('throws on schema mismatch', () => {
    expect(() => extractJson('<plan>{"steps":1}</plan>', 'plan', schema)).toThrow();
  });
});

describe('hasTerminationSignal', () => {
  it('detects <promise>COMPLETE</promise> case-insensitively', () => {
    expect(hasTerminationSignal('done <promise>complete</promise>')).toBe(true);
    expect(hasTerminationSignal('still working')).toBe(false);
  });
});
