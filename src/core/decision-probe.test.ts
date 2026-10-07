import { describe, it, expect } from 'vitest';
import { decisionProbeConfig, probeTaskDifficulty, probeState, DIFFICULTY_LEVELS } from './decision-probe.js';
import type { Task } from '../tasks/fetcher.js';

const task: Task = {
  id: 'o/r#1',
  title: 'Add retry to fetcher',
  description: 'x'.repeat(30_000),
  labels: ['ready for agent'],
  children: [],
  comments: [{ author: 'bot', body: '<tech_spec>do it</tech_spec>' }],
};

const answers = {
  completes_first_try: { type: 'noul', noul: 0.72 },
  difficulty: { type: 'score', score: 1.6, legend: {}, probabilities: {}, confidence: 0.55 },
  spec_clear: { type: 'noul', noul: 0.9 },
};

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('decisionProbeConfig', () => {
  it('is disabled without credentials', () => {
    expect(decisionProbeConfig({})).toBeUndefined();
    expect(decisionProbeConfig({ CLOUDFLARE_ACCOUNT_ID: 'acc' })).toBeUndefined();
  });

  it('builds the Workers AI URL from the Cloudflare pair, defaulting to clef-flash', () => {
    const cfg = decisionProbeConfig({ CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't' });
    expect(cfg).toEqual({ url: 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash', token: 't', model: 'clef-flash' });
    expect(decisionProbeConfig({ CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't', VANGUARD_DECISION_MODEL: 'clef' })?.model).toBe('clef');
  });

  it('a generic System-One endpoint wins and may run without a token', () => {
    expect(decisionProbeConfig({ VANGUARD_DECISION_URL: 'http://ai-box:8080/decide', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't' }))
      .toEqual({ url: 'http://ai-box:8080/decide', model: 'clef-flash' });
  });
});

describe('probeTaskDifficulty', () => {
  const cfg = { url: 'https://example.test/run', token: 'tok', model: 'clef-flash' };

  it('posts the typed questions and maps a Workers-AI-wrapped answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await probeTaskDifficulty(task, 'claude-sonnet-5', cfg, fakeFetch(200, { success: true, result: { model: 'clef-flash', answers, usage: { input_tokens: 812, output_tokens: 0 } } }, calls));
    expect(result).toMatchObject({ model: 'clef-flash', completesFirstTry: 0.72, difficulty: 1.6, difficultyConfidence: 0.55, specClear: 0.9, inputTokens: 812 });
    expect(result?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.url).toBe(cfg.url);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(calls[0]?.init.body as string) as { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: string[] }> };
    expect(body.model).toBe('clef-flash');
    expect(body.state['implementer_model']).toBe('claude-sonnet-5');
    expect(Object.keys(body.questions)).toEqual(['completes_first_try', 'difficulty', 'spec_clear']);
    expect(body.questions['difficulty']?.criteria).toEqual([...DIFFICULTY_LEVELS]);
  });

  it('accepts a bare System-One body (no result wrapper)', async () => {
    const result = await probeTaskDifficulty(task, undefined, cfg, fakeFetch(200, { model: 'jev', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
    expect(result?.model).toBe('jev');
  });

  it('returns undefined — never throws — on no config, non-2xx, malformed body, or network error', async () => {
    expect(await probeTaskDifficulty(task, undefined, undefined, fakeFetch(200, {}))).toBeUndefined();
    expect(await probeTaskDifficulty(task, undefined, cfg, fakeFetch(401, { errors: [{ message: 'nope' }] }))).toBeUndefined();
    expect(await probeTaskDifficulty(task, undefined, cfg, fakeFetch(200, { result: { answers: { difficulty: { score: 1 } } } }))).toBeUndefined();
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await probeTaskDifficulty(task, undefined, cfg, boom)).toBeUndefined();
  });

  it('truncates long description/spec in the state', () => {
    const state = probeState(task, undefined);
    expect((state['description'] as string).length).toBe(24_000);
    expect(state['implementer_model']).toBe('provider default');
  });
});
