import { test, expect } from 'vitest';
import { reduceDocChat, extractDoc, initialDocChat, lastUserIndex } from './useDocChat.js';

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

test('reply with <doc> sets a pending proposal and clears busy — the RAW reply is stored', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'x' });
  const s = reduceDocChat(s0, { type: 'reply', text: 'sure <doc>NEW</doc>' });
  expect(s.pending).toBe('NEW');
  expect(s.busy).toBe(false);
  // The transcript persists to disk now (S10): storing a display placeholder would destroy the
  // proposal's content on relaunch. The placeholder is derived at render time (ChatMessage).
  expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: 'sure <doc>NEW</doc>' });
});

test('load seeds a persisted transcript without restoring pending or busy', () => {
  const persisted = [
    { role: 'user' as const, content: 'plan?' },
    { role: 'assistant' as const, content: 'here <doc>PLAN</doc>' },
  ];
  const s = reduceDocChat(reduceDocChat(initialDocChat(), { type: 'send', text: 'old' }), {
    type: 'load',
    messages: persisted,
  });
  expect(s.messages).toEqual(persisted); // the <doc> content survives the round-trip
  expect(s.pending).toBeUndefined(); // accept/reject is session-only
  expect(s.busy).toBe(false);
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

test('cancel drops the dangling user turn and clears busy without an error (stop-cancels-turn)', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'plan this' });
  expect(s0.busy).toBe(true);
  const s = reduceDocChat(s0, { type: 'cancel' });
  expect(s.messages).toEqual([]); // the trailing user turn leaves nothing behind
  expect(s.busy).toBe(false);
  expect(s.error).toBeUndefined();
});

test('cancel leaves a completed exchange intact (nothing to drop if last turn is assistant)', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'x' });
  const replied = reduceDocChat(s0, { type: 'reply', text: 'done' });
  const s = reduceDocChat(replied, { type: 'cancel' });
  expect(s.messages).toEqual(replied.messages);
  expect(s.busy).toBe(false);
});

test('editLast truncates the last exchange and clears any pending proposal', () => {
  let s = reduceDocChat(initialDocChat(), { type: 'send', text: 'first' });
  s = reduceDocChat(s, { type: 'reply', text: 'ok' });
  s = reduceDocChat(s, { type: 'send', text: 'second' });
  s = reduceDocChat(s, { type: 'reply', text: 'sure <doc>NEW</doc>' });
  expect(s.pending).toBe('NEW');
  const e = reduceDocChat(s, { type: 'editLast' });
  expect(e.messages).toEqual([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
  ]);
  expect(e.pending).toBeUndefined();
});

test('editLast is a no-op with no user message', () => {
  const s = initialDocChat();
  expect(reduceDocChat(s, { type: 'editLast' })).toBe(s);
});

test('lastUserIndex finds the last user turn, or -1 when there is none', () => {
  expect(lastUserIndex([])).toBe(-1);
  expect(
    lastUserIndex([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ]),
  ).toBe(2);
});

test('fail sets an error and clears busy, no throw', () => {
  const s0 = reduceDocChat(initialDocChat(), { type: 'send', text: 'x' });
  const s = reduceDocChat(s0, { type: 'fail', message: 'no ANTHROPIC_API_KEY' });
  expect(s.error).toMatch(/ANTHROPIC_API_KEY/);
  expect(s.busy).toBe(false);
});
