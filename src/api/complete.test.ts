import { test, expect } from 'vitest';
import { runComplete } from './complete.js';

const okAnthropic = () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: 'hi' }] }) } });
const apiAuth = () => ({ mode: 'api' as const, apiKey: 'sk-x' });
const subAuth = () => ({ mode: 'subscription' as const, token: 'oauth-x' });
const msg = [{ role: 'user' as const, content: 'hi' }];

test('api-mode key → text', async () => {
  const r = await runComplete({ model: 'claude-x', messages: msg }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.text).toBe('hi');
});

test('subscription token → specific ANTHROPIC_API_KEY error', async () => {
  const r = await runComplete({ model: 'm', messages: msg }, { authFromEnv: subAuth, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/ANTHROPIC_API_KEY/);
  expect(r.error?.message).toMatch(/subscription/i);
});

test('no key → error', async () => {
  const r = await runComplete({ model: 'm', messages: msg }, { authFromEnv: () => undefined, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/ANTHROPIC_API_KEY/);
});

test('empty messages → error', async () => {
  const r = await runComplete({ model: 'm', messages: [] }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/non-empty/);
});

test('missing model → error', async () => {
  const r = await runComplete({ messages: msg }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.error?.message).toMatch(/model/);
});

test('malformed message shape → error', async () => {
  const r = await runComplete({ model: 'm', messages: [{ role: 'system', content: 'x' }] }, { authFromEnv: apiAuth, anthropic: okAnthropic });
  expect(r.error).toBeDefined();
});

test('SDK throw → error, not reject', async () => {
  const boom = () => ({ messages: { create: async () => { throw new Error('429 rate limit'); } } });
  const r = await runComplete({ model: 'm', messages: msg }, { authFromEnv: apiAuth, anthropic: boom });
  expect(r.error?.message).toMatch(/429/);
});

test('passes baseUrl through to the client', async () => {
  let seen: { apiKey: string; baseURL?: string } | undefined;
  const spy = (opts: { apiKey: string; baseURL?: string }) => {
    seen = opts;
    return okAnthropic();
  };
  await runComplete({ model: 'm', messages: msg, baseUrl: 'https://proxy.local' }, { authFromEnv: apiAuth, anthropic: spy });
  expect(seen?.baseURL).toBe('https://proxy.local');
});
