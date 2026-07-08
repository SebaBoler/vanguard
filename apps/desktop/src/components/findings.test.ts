import { expect, test } from 'vitest';
import { parseFindings } from './findings';

const item = { severity: 'high', kind: 'security', title: 'x', evidence: 'y' };

test('parses the wrapped-object shape', () => {
  expect(parseFindings(JSON.stringify({ findings: [item] }))).toEqual([item]);
});

test('parses the bare-array shape', () => {
  expect(parseFindings(JSON.stringify([item]))).toEqual([item]);
});

test('parses an empty array', () => {
  expect(parseFindings('[]')).toEqual([]);
});

test('returns null on malformed JSON', () => {
  expect(parseFindings('{')).toBeNull();
});

test('returns null when an item has an invalid enum value', () => {
  expect(parseFindings(JSON.stringify([{ ...item, severity: 'extreme' }]))).toBeNull();
});

test('returns null on a non-array, non-findings-wrapper top level', () => {
  expect(parseFindings(JSON.stringify({ foo: 1 }))).toBeNull();
});
