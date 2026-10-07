import { describe, it, expect, vi } from 'vitest';
import { decide, decisionModelConfig, isDecisionModelName } from './decision-model.js';

const cfg = { url: 'https://example.test/run', token: 'tok', model: 'clef-flash' };
const questions = { ok: { type: 'noul' as const, instructions: 'ok?' } };

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('decisionModelConfig', () => {
  it('needs credentials and, on Workers AI, a hosted model; a generic URL wins and never gets the Cloudflare token', () => {
    expect(decisionModelConfig({})).toBeUndefined();
    const cf = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't' };
    expect(decisionModelConfig(cf)).toEqual({ url: 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash', token: 't', model: 'clef-flash' });
    expect(decisionModelConfig(cf, 'clef')?.model).toBe('clef');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(decisionModelConfig(cf, 'jev')).toBeUndefined();
    warn.mockRestore();
    expect(decisionModelConfig({ ...cf, VANGUARD_DECISION_URL: 'http://ai-box/decide' }, 'jev')).toEqual({ url: 'http://ai-box/decide', model: 'jev' });
  });

  it('isDecisionModelName recognises the decision-model names only', () => {
    expect(isDecisionModelName('clef')).toBe(true);
    expect(isDecisionModelName('clef-flash')).toBe(true);
    expect(isDecisionModelName('jev')).toBe(true);
    expect(isDecisionModelName('claude-haiku-4-5-20251001')).toBe(false);
  });
});

describe('decide', () => {
  it('posts model/state/questions with the bearer token and unwraps a Workers AI or bare body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const wrapped = await decide({ a: 1 }, questions, cfg, { fetchImpl: fakeFetch(200, { success: true, result: { model: 'clef-flash', answers: { ok: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 42 } } }, calls) });
    expect(wrapped).toMatchObject({ model: 'clef-flash', answers: { ok: { noul: 0.8 } }, inputTokens: 42 });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'clef-flash', state: { a: 1 }, questions });
    const bare = await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { model: 'jev', answers: { ok: { noul: 0.1 } }, usage: { input_tokens: 1 } }) });
    expect(bare?.model).toBe('jev');
  });

  it('returns undefined (never throws) on non-2xx, a body without answers, or a network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(401, { errors: [] }) })).toBeUndefined();
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { success: false, result: null }) })).toBeUndefined();
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await decide({}, questions, cfg, { fetchImpl: boom, label: 'x' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.every(([line]) => !String(line).includes('example.test'))).toBe(true);
    warn.mockRestore();
  });
});
