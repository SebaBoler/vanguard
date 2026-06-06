import { describe, it, expect } from 'vitest';
import { extractFindings } from './findings.js';

describe('extractFindings', () => {
  it('parses a findings block', () => {
    const text =
      '<findings>{"findings":[{"severity":"high","kind":"security","title":"path traversal","evidence":"reads req.params.file"}]}</findings>';
    const out = extractFindings(text);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe('high');
    expect(out.findings[0]?.kind).toBe('security');
  });

  it('throws on an invalid severity', () => {
    expect(() =>
      extractFindings('<findings>{"findings":[{"severity":"nope","kind":"security","title":"x","evidence":"y"}]}</findings>'),
    ).toThrow();
  });

  it('throws when the tag is missing', () => {
    expect(() => extractFindings('no findings here')).toThrow();
  });
});
