import { test, expect } from 'vitest';
import { reduceDocChat, extractDoc, initialDocChat } from './useDocChat.js';

test('extractDoc splits note and doc', () => {
  expect(extractDoc('here you go <doc>BODY</doc>')).toEqual({ note: 'here you go', doc: 'BODY' });
});

test('extractDoc with no tag returns plain note', () => {
  expect(extractDoc('just chatting')).toEqual({ note: 'just chatting' });
});

test('extractDoc captures the full multiline body', () => {
  const { doc } = extractDoc('a\n<doc># Plan\n\n- x\n</doc>\nb');
  expect(doc).toBe('# Plan\n\n- x\n');
});

test('extractDoc is greedy so a body mentioning </doc> is not truncated', () => {
  const { doc } = extractDoc('sure <doc># Plan\nWrap output in </doc> tags.\nrest</doc>');
  expect(doc).toBe('# Plan\nWrap output in </doc> tags.\nrest');
});

test('send appends a user message and sets busy', () => {
  const s = reduceDocChat(initialDocChat(), { type: 'send', text: 'plan this' });
  expect(s.messages).toEqual([{ role: 'user', content: 'plan this' }]);
  expect(s.busy).toBe(true);
});

test('reply with <doc> sets a pending proposal and clears busy', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'x' });
  const s = reduceDocChat(s0, { type: 'reply', text: 'sure <doc>NEW</doc>' });
  expect(s.pending).toBe('NEW');
  expect(s.busy).toBe(false);
  expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: 'sure' });
});

test('reply without <doc> is a plain message, no pending', () => {
  const s = reduceDocChat(initialDocChat(), { type: 'reply', text: 'what do you mean?' });
  expect(s.pending).toBeUndefined();
  expect(s.messages.at(-1)?.content).toBe('what do you mean?');
});

test('accept clears pending (caller applies to the doc)', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'reply', text: '<doc>NEW</doc>' });
  expect(reduceDocChat(s0, { type: 'acceptApplied' }).pending).toBeUndefined();
});

test('reject clears pending without changing anything else', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'reply', text: '<doc>NEW</doc>' });
  const s = reduceDocChat(s0, { type: 'reject' });
  expect(s.pending).toBeUndefined();
});

test('reset drops the transcript and any pending proposal', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'reply', text: 'x <doc>NEW</doc>' });
  expect(reduceDocChat(s0, { type: 'reset' })).toEqual(initialDocChat());
});

test('send is a no-op while busy (no double in-flight)', () => {
  const busy = reduceDocChat(initialDocChat(), { type: 'send', text: 'first' });
  const again = reduceDocChat(busy, { type: 'send', text: 'second' });
  expect(again).toBe(busy);
  expect(again.messages).toHaveLength(1);
});

test('fail sets an error and clears busy, no throw', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'x' });
  const s = reduceDocChat(s0, { type: 'fail', message: 'no ANTHROPIC_API_KEY' });
  expect(s.error).toMatch(/ANTHROPIC_API_KEY/);
  expect(s.busy).toBe(false);
});
