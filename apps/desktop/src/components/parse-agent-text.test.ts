import { expect, test } from 'vitest';
import { parseAgentText } from './parse-agent-text';

test('plain text with no tags is a single markdown segment', () => {
  expect(parseAgentText('just some text')).toEqual([{ type: 'markdown', text: 'just some text' }]);
});

test('empty input yields one markdown segment with the raw (empty) string', () => {
  expect(parseAgentText('')).toEqual([{ type: 'markdown', text: '' }]);
});

test('short single-line tag content becomes a chip', () => {
  expect(parseAgentText('<promise>COMPLETE</promise>')).toEqual([{ type: 'chip', tag: 'promise', text: 'COMPLETE' }]);
});

test('content at exactly 40 chars with no newline is still a chip', () => {
  const inner = 'a'.repeat(40);
  expect(parseAgentText(`<note>${inner}</note>`)).toEqual([{ type: 'chip', tag: 'note', text: inner }]);
});

test('content over 40 chars becomes a callout', () => {
  const inner = 'a'.repeat(41);
  expect(parseAgentText(`<note>${inner}</note>`)).toEqual([{ type: 'callout', tag: 'note', text: inner }]);
});

test('multi-line content becomes a callout even if short', () => {
  expect(parseAgentText('<plan>a\nb</plan>')).toEqual([{ type: 'callout', tag: 'plan', text: 'a\nb' }]);
});

test('a valid findings tag becomes a findings segment, not a callout', () => {
  const findings = [{ severity: 'high', kind: 'security', title: 't', evidence: 'e' }];
  expect(parseAgentText(`<findings>${JSON.stringify(findings)}</findings>`)).toEqual([
    { type: 'findings', tag: 'findings', findings },
  ]);
});

test('a malformed findings tag falls back to chip/callout by length, not findings', () => {
  expect(parseAgentText('<findings>not json</findings>')).toEqual([{ type: 'chip', tag: 'findings', text: 'not json' }]);
});

test('text around a tag becomes surrounding markdown segments', () => {
  expect(parseAgentText('before\n<promise>COMPLETE</promise>\nafter')).toEqual([
    { type: 'markdown', text: 'before' },
    { type: 'chip', tag: 'promise', text: 'COMPLETE' },
    { type: 'markdown', text: 'after' },
  ]);
});

test('multiple tags in sequence each become their own segment', () => {
  expect(parseAgentText('<a>x</a><b>y</b>')).toEqual([
    { type: 'chip', tag: 'a', text: 'x' },
    { type: 'chip', tag: 'b', text: 'y' },
  ]);
});
