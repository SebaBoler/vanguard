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
  const spy = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    seen = params.options;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete({ messages: msg, system: 'be terse', model: 'claude-sonnet-5' }, { query: spy });
  expect(seen?.['systemPrompt']).toBe('be terse');
  expect(seen?.['model']).toBe('claude-sonnet-5');
  expect(seen?.['allowedTools']).toEqual([]);
  // >1 (dogfood 2026-07-14): the SDK counts internal steps as turns, and maxTurns:1 died with
  // error_max_turns before any text. Tools stay empty, so the cap is only a runaway stop.
  expect(seen?.['maxTurns']).toBe(8);
});

test('prompt-inlines-mention: a file attachment (@mention / dropped text) is inlined as a fenced block tagged with its path', async () => {
  let prompt: string | AsyncIterable<unknown> | undefined;
  const spy = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete(
    {
      messages: [{ role: 'user', content: 'summarise @src/wire.ts' }],
      attachments: [{ kind: 'file', path: 'src/wire.ts', content: 'export const X = 1;' }],
    },
    { query: spy },
  );
  // Text-only turn ⇒ a string prompt carrying both the message and the fenced file block.
  expect(typeof prompt).toBe('string');
  const text = prompt as string;
  expect(text).toContain('summarise @src/wire.ts');
  expect(text).toContain('`src/wire.ts`:');
  expect(text).toContain('```\nexport const X = 1;\n```');
});

test('a file attachment with no content is not inlined (a bad attachment cannot corrupt the prompt)', async () => {
  let prompt: string | AsyncIterable<unknown> | undefined;
  const spy = (params: { prompt: string | AsyncIterable<unknown> }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete({ messages: msg, attachments: [{ kind: 'file', path: 'x.ts' }] }, { query: spy });
  expect(prompt).toBe('User: hi');
});

test('bounded-payload: inlined file content over the 256KB total is refused before send, with a clear error', async () => {
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    {
      messages: msg,
      attachments: [
        { kind: 'file', path: 'a.ts', content: 'x'.repeat(200_000) },
        { kind: 'file', path: 'b.ts', content: 'y'.repeat(100_000) },
      ],
    },
    { query: spy },
  );
  expect(r.text).toBeUndefined();
  expect(r.error?.message).toMatch(/inline limit/);
  expect(called).toBe(false); // refused before the model is ever hit
});

test('an image path outside the trusted asset root is refused before the model is hit (review r1 security)', async () => {
  // The renderer hands __complete image PATHS; without containment any request could read an
  // arbitrary host file (~/.ssh, .env) and exfiltrate it base64'd into the prompt. The sidecar
  // stamps the TRUSTED assetRoot; every image path must canonicalize under it.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const outside = mkdtempSync(join(tmpdir(), 'vg-outside-'));
  const secret = join(outside, 'secret.png');
  writeFileSync(secret, 'top secret');
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: secret }] },
    { query: spy },
  );
  expect(r.error?.message).toMatch(/asset root/);
  expect(called).toBe(false);
});

test('image attachments without a trusted asset root are refused outright', async () => {
  const r = await runComplete(
    { messages: msg, attachments: [{ kind: 'image', path: '/etc/passwd' }] },
    { query: fakeQuery({ type: 'result', subtype: 'success', result: 'ok' }) },
  );
  expect(r.error?.message).toMatch(/asset root/);
});

test('an oversize image is refused before send (bounded-payload applies to images too)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const big = join(root, 'big.png');
  writeFileSync(big, Buffer.alloc(6_000_000));
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: big }] },
    { query: spy },
  );
  expect(r.error?.message).toMatch(/too large|image/i);
  expect(called).toBe(false);
});

test('a contained, small image goes through as a base64 content block', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const ok = join(root, 'draft-1-assets');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ok);
  const img = join(ok, 'pic.png');
  writeFileSync(img, Buffer.from('img-bytes'));
  let prompt: unknown;
  const spy = (params: { prompt: unknown }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: img, mediaType: 'image/png' }] },
    { query: spy },
  );
  expect(r.text).toBe('ok');
  expect(typeof prompt).not.toBe('string'); // streaming-input form with the image block
});
