import { test, expect } from 'vitest';
import { runComplete } from './complete.js';

/** A fake agent-SDK query() yielding a fixed message stream. */
function fakeQuery(...msgs: { type: string; subtype?: string; result?: string }[]) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}
const msg = [{ role: 'user' as const, content: 'hi' }];

test('returns the model text on a success result', async () => {
  const r = await runComplete({ messages: msg }, { query: fakeQuery({ type: 'result', subtype: 'success', result: 'hello' }) });
  expect(r.text).toBe('hello');
});

test('surfaces an error result subtype (e.g. auth) as an error, not a throw', async () => {
  const r = await runComplete(
    { messages: msg },
    { query: fakeQuery({ type: 'result', subtype: 'error_during_execution' }) },
  );
  expect(r.error?.message).toMatch(/error_during_execution/);
});

test('no result message → error', async () => {
  const r = await runComplete({ messages: msg }, { query: fakeQuery({ type: 'assistant' }) });
  expect(r.error?.message).toMatch(/no result/);
});

test('empty messages → error', async () => {
  const r = await runComplete({ messages: [] }, { query: fakeQuery() });
  expect(r.error?.message).toMatch(/non-empty/);
});

test('malformed message shape → error', async () => {
  const r = await runComplete({ messages: [{ role: 'system', content: 'x' }] }, { query: fakeQuery() });
  expect(r.error).toBeDefined();
});

test('a thrown query → error, not reject', async () => {
  const boom = () => {
    throw new Error('spawn failed');
  };
  const r = await runComplete({ messages: msg }, { query: boom as never });
  expect(r.error?.message).toMatch(/spawn failed/);
});

test('passes system + model into the query options', async () => {
  let seen: Record<string, unknown> | undefined;
  const spy = (params: { prompt: string; options?: Record<string, unknown> }) => {
    seen = params.options;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete({ messages: msg, system: 'be terse', model: 'claude-sonnet-5' }, { query: spy });
  expect(seen?.['systemPrompt']).toBe('be terse');
  expect(seen?.['model']).toBe('claude-sonnet-5');
  expect(seen?.['allowedTools']).toEqual([]);
  expect(seen?.['maxTurns']).toBe(1);
});
