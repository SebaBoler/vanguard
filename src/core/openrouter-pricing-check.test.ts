import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { OPENROUTER_PRICING, PRICED_MODELS } from './openrouter-pricing.js';
import {
  computeDrift,
  formatDriftReport,
  runPricingCheck,
  scanUsedModels,
  scanUsedModelsFromMetricsText,
  strictExitCode,
  toPerMTok,
  type OpenRouterModel,
  type OpenRouterModelsResponse,
} from './openrouter-pricing-check.js';

function payloadFromTable(): OpenRouterModelsResponse {
  const data: OpenRouterModel[] = Object.values(PRICED_MODELS).map((row) => ({
    id: row.openRouterModel,
    pricing: {
      prompt: String(row.input / 1_000_000),
      completion: String(row.output / 1_000_000),
      input_cache_read: String(row.cacheRead / 1_000_000),
    },
  }));
  return { data };
}

describe('table integrity (offline, mandated by acceptance criteria)', () => {
  it('every OPENROUTER_PRICING key resolves and aliases are identity-equal to their dated row', () => {
    expect(OPENROUTER_PRICING['opus']).toBe(PRICED_MODELS['claude-opus-4-8']);
    expect(OPENROUTER_PRICING['sonnet']).toBe(PRICED_MODELS['claude-sonnet-5']);
    expect(OPENROUTER_PRICING['haiku']).toBe(PRICED_MODELS['claude-haiku-4-5-20251001']);
    for (const key of Object.keys(OPENROUTER_PRICING)) {
      expect(OPENROUTER_PRICING[key]).toBeDefined();
    }
  });

  it('every PRICED_MODELS row has a non-empty, trimmed openRouterModel slug', () => {
    for (const [key, row] of Object.entries(PRICED_MODELS)) {
      expect(row.openRouterModel.trim(), `row ${key}`).not.toBe('');
      expect(row.openRouterModel, `row ${key}`).toBe(row.openRouterModel.trim());
    }
  });
});

describe('toPerMTok', () => {
  it('converts a per-token string to per-MTok', () => {
    expect(toPerMTok('0.000002')).toBeCloseTo(2, 9);
  });

  it('returns undefined for absent or NaN input', () => {
    expect(toPerMTok(undefined)).toBeUndefined();
    expect(toPerMTok('not-a-number')).toBeUndefined();
  });
});

describe('computeDrift', () => {
  it('reports no stale rows when live payload matches the table exactly', () => {
    const report = computeDrift(payloadFromTable(), new Set());
    expect(report.stale).toEqual([]);
    expect(report.missingLive).toEqual([]);
    expect(report.checkedRows).toBe(Object.keys(PRICED_MODELS).length);
  });

  it('flags exactly one stale field when one price drifts', () => {
    const payload = payloadFromTable();
    const sonnet5 = payload.data.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    sonnet5.pricing!.prompt = '0.000003'; // live reverted to $3, table still says $2

    const report = computeDrift(payload, new Set());
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toEqual({
      tableKey: 'claude-sonnet-5',
      slug: 'anthropic/claude-sonnet-5',
      field: 'input',
      stored: 2,
      live: 3,
    });
  });

  it('flags one StalePrice per drifted field across multiple rows', () => {
    const payload = payloadFromTable();
    const sonnet5 = payload.data.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    sonnet5.pricing!.prompt = '0.000003';
    sonnet5.pricing!.completion = '0.000015';
    const opus = payload.data.find((m) => m.id === 'anthropic/claude-opus-4.8')!;
    opus.pricing!.input_cache_read = '0.0000009';

    const report = computeDrift(payload, new Set());
    expect(report.stale).toHaveLength(3);
    const fields = report.stale.map((s) => `${s.tableKey}:${s.field}`).sort();
    expect(fields).toEqual(['claude-opus-4-8:cacheRead', 'claude-sonnet-5:input', 'claude-sonnet-5:output']);
  });

  it('skips a field rather than flagging stale when live cacheRead price is absent', () => {
    const payload = payloadFromTable();
    const sonnet5 = payload.data.find((m) => m.id === 'anthropic/claude-sonnet-5')!;
    delete sonnet5.pricing!.input_cache_read;

    const report = computeDrift(payload, new Set());
    expect(report.stale.filter((s) => s.tableKey === 'claude-sonnet-5')).toEqual([]);
  });

  it('reports MissingLiveModel (not StalePrice) when a slug is absent from the live payload', () => {
    const payload = payloadFromTable();
    payload.data = payload.data.filter((m) => m.id !== 'anthropic/claude-sonnet-5');

    const report = computeDrift(payload, new Set());
    expect(report.missingLive).toEqual([{ tableKey: 'claude-sonnet-5', slug: 'anthropic/claude-sonnet-5' }]);
    expect(report.stale.some((s) => s.tableKey === 'claude-sonnet-5')).toBe(false);
  });

  it('float edge: within epsilon is not stale, just outside epsilon is stale', () => {
    const payload = payloadFromTable();
    const haiku = payload.data.find((m) => m.id === 'anthropic/claude-haiku-4.5')!;
    // 0.1 stored; reconstructed value differs by ~1e-13 due to float noise from the round-trip below.
    haiku.pricing!.input_cache_read = String(0.1 / 1_000_000);
    let report = computeDrift(payload, new Set());
    expect(report.stale.filter((s) => s.tableKey === 'claude-haiku-4-5-20251001' && s.field === 'cacheRead')).toEqual([]);

    haiku.pricing!.input_cache_read = String(0.1000001 / 1_000_000);
    report = computeDrift(payload, new Set());
    expect(report.stale.some((s) => s.tableKey === 'claude-haiku-4-5-20251001' && s.field === 'cacheRead')).toBe(true);
  });

  it('flags a metrics-sourced used model with no OPENROUTER_PRICING entry', () => {
    const report = computeDrift(payloadFromTable(), new Set(['gpt-5.3-codex']));
    expect(report.unpriced).toEqual([{ model: 'gpt-5.3-codex', source: 'metrics' }]);
  });

  it('does not flag a used model that is already priced', () => {
    const report = computeDrift(payloadFromTable(), new Set(['sonnet', 'claude-opus-4-8']));
    expect(report.unpriced).toEqual([]);
  });

  it('only checks metrics-sourced models for unpriced usage', () => {
    const report = computeDrift(payloadFromTable(), new Set());
    expect(report.unpriced).toEqual([]);
  });
});

describe('scanUsedModelsFromMetricsText', () => {
  it('extracts deduped string model values, skipping blank/malformed/missing-model lines', () => {
    const text = [
      '{"evt":"run_complete","model":"sonnet"}',
      '',
      'not json',
      '{"evt":"run_complete","model":"sonnet"}',
      '{"evt":"run_complete","model":"gpt-5.3-codex"}',
      '{"evt":"verify","model":"ignored"}',
      '{"evt":"run_complete"}',
    ].join('\n');
    expect(scanUsedModelsFromMetricsText(text)).toEqual(new Set(['sonnet', 'gpt-5.3-codex']));
  });

  it('returns an empty set for empty text', () => {
    expect(scanUsedModelsFromMetricsText('')).toEqual(new Set());
  });

  it('excludes lines where model is present but non-string or empty', () => {
    const text = [
      '{"evt":"run_complete","model":123}',
      '{"evt":"run_complete","model":""}',
      '{"evt":"run_complete","model":null}',
      '{"evt":"run_complete","model":"ok"}',
    ].join('\n');
    expect(scanUsedModelsFromMetricsText(text)).toEqual(new Set(['ok']));
  });
});

describe('scanUsedModels (fs)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns an empty set, no throw, when .vanguard/runs/metrics.jsonl is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vanguard-pricing-check-'));
    await expect(scanUsedModels(dir)).resolves.toEqual(new Set());
  });

  it('reads a real metrics.jsonl when present', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vanguard-pricing-check-'));
    const runsDir = join(dir, '.vanguard', 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, 'metrics.jsonl'),
      '{"evt":"run_complete","model":"sonnet"}\n{"evt":"run_complete","model":"haiku"}\n',
      'utf8',
    );
    await expect(scanUsedModels(dir)).resolves.toEqual(new Set(['sonnet', 'haiku']));
  });
});

describe('formatDriftReport', () => {
  it('renders stored/live values and model names for all three categories', () => {
    const report = {
      stale: [{ tableKey: 'claude-sonnet-5', slug: 'anthropic/claude-sonnet-5', field: 'input' as const, stored: 2, live: 3 }],
      unpriced: [{ model: 'gpt-5.3-codex', source: 'metrics' as const }],
      missingLive: [{ tableKey: 'glm-5.2', slug: 'z-ai/glm-5.2' }],
      checkedRows: 5,
      usedModelsScanned: 1,
    };
    const text = formatDriftReport(report);
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('stored=2');
    expect(text).toContain('live=3');
    expect(text).toContain('gpt-5.3-codex');
    expect(text).toContain('glm-5.2');
  });

  it('prints a clear "no drift" line for an empty report', () => {
    const report = { stale: [], unpriced: [], missingLive: [], checkedRows: 5, usedModelsScanned: 0 };
    expect(formatDriftReport(report)).toMatch(/no drift/i);
  });
});

describe('strictExitCode', () => {
  const base = { stale: [], unpriced: [], missingLive: [], checkedRows: 5, usedModelsScanned: 0 };

  it('is 0 for an empty report', () => {
    expect(strictExitCode(base)).toBe(0);
  });

  it('is 1 when stale is non-empty', () => {
    expect(
      strictExitCode({
        ...base,
        stale: [{ tableKey: 'x', slug: 'y', field: 'input', stored: 1, live: 2 }],
      }),
    ).toBe(1);
  });

  it('is 1 when unpriced is non-empty', () => {
    expect(strictExitCode({ ...base, unpriced: [{ model: 'x', source: 'metrics' }] })).toBe(1);
  });

  it('is 0 when only missingLive is non-empty', () => {
    expect(strictExitCode({ ...base, missingLive: [{ tableKey: 'x', slug: 'y' }] })).toBe(0);
  });
});

describe('runPricingCheck', () => {
  it('wires an injected fetcher to computeDrift without touching the network', async () => {
    const report = await runPricingCheck({
      fetcher: async () => payloadFromTable(),
      usedModels: new Set(['gpt-5.3-codex']),
    });
    expect(report.stale).toEqual([]);
    expect(report.unpriced).toEqual([{ model: 'gpt-5.3-codex', source: 'metrics' }]);
  });
});
