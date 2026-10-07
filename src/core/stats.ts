import { cacheEfficiency } from '../agents/provider.js';
import { alignTable } from './table.js';
import { DIFFICULTY_LEVELS } from './decision-probe.js';

/** One parsed `run_complete` line from .vanguard/runs/metrics.jsonl. */
export interface MetricRecord {
  taskId: string;
  stage?: string;
  model?: string;
  requestedModel?: string;
  exitReason?: string;
  /** Agent calls folded into the stage (resumes/repairs); absent = 1. */
  attempts?: number;
  firstExitReason?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
}

/** Aggregated totals for a group of metric records. */
export interface Bucket {
  entries: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
}

/** One `decision_probe` line: the log-only difficulty probe taken before a run. */
export interface ProbeRecord {
  taskId: string;
  completesFirstTry: number;
  difficulty: number;
  specClear: number;
}

/** Probe predictions bucketed by predicted difficulty level, joined to what the implementer did. */
export interface ProbeBucket {
  level: string;
  runs: number;
  /** Implementer stages that needed a repair/resume or did not complete. */
  repaired: number;
  /** Mean predicted probability of a clean first attempt. */
  predictedFirstTry: number;
  /** Observed share of clean first attempts (1 - repaired/runs). */
  observedFirstTry: number;
}

export interface StatsReport {
  byTask: Array<{ key: string } & Bucket>;
  byStage: Array<{ key: string } & Bucket>;
  /** Keyed by the model actually served (see modelKey), so a model swap can be priced against its predecessor. */
  byModel: Array<{ key: string } & Bucket>;
  total: Bucket;
  /** Present only when decision_probe lines exist: predicted vs observed, per difficulty level. */
  probes?: ProbeBucket[];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parse JSONL text into objects, tolerating blank lines and malformed JSON. */
export function parseJsonlLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return lines;
}

/** Parse metrics.jsonl text into records, tolerating blank and malformed lines. Keeps run_complete. */
export function parseMetrics(text: string): MetricRecord[] {
  const records: MetricRecord[] = [];
  for (const parsed of parseJsonlLines(text)) {
    if (parsed.evt !== 'run_complete' || typeof parsed.taskId !== 'string') continue;
    records.push({
      taskId: parsed.taskId,
      ...(typeof parsed.stage === 'string' ? { stage: parsed.stage } : {}),
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.requestedModel === 'string' ? { requestedModel: parsed.requestedModel } : {}),
      ...(typeof parsed.exitReason === 'string' ? { exitReason: parsed.exitReason } : {}),
      ...(typeof parsed.attempts === 'number' ? { attempts: parsed.attempts } : {}),
      ...(typeof parsed.firstExitReason === 'string' ? { firstExitReason: parsed.firstExitReason } : {}),
      costUsd: num(parsed.costUsd),
      inputTokens: num(parsed.inputTokens),
      outputTokens: num(parsed.outputTokens),
      cacheReadInputTokens: num(parsed.cacheReadInputTokens),
      durationMs: num(parsed.durationMs),
    });
  }
  return records;
}

/** Parse `decision_probe` lines (see persistDecisionProbe); malformed lines are skipped. */
export function parseProbes(text: string): ProbeRecord[] {
  const probes: ProbeRecord[] = [];
  for (const parsed of parseJsonlLines(text)) {
    if (parsed.evt !== 'decision_probe' || typeof parsed.taskId !== 'string') continue;
    if (typeof parsed.completesFirstTry !== 'number' || typeof parsed.difficulty !== 'number' || typeof parsed.specClear !== 'number') continue;
    probes.push({ taskId: parsed.taskId, completesFirstTry: parsed.completesFirstTry, difficulty: parsed.difficulty, specClear: parsed.specClear });
  }
  return probes;
}

/**
 * Join each probe to that task's LAST implementer record and bucket by the rounded difficulty level.
 * "Repaired" = the stage needed more than one attempt or did not end completed — the outcome the
 * probe is supposed to predict. Tasks without an implementer record are dropped (run never finished).
 */
export function probeReport(records: ReadonlyArray<MetricRecord>, probes: ReadonlyArray<ProbeRecord>): ProbeBucket[] {
  const implementerByTask = new Map<string, MetricRecord>();
  for (const r of records) if (r.stage === 'implementer') implementerByTask.set(r.taskId, r);
  const acc = new Map<number, { runs: number; repaired: number; predicted: number }>();
  for (const probe of probes) {
    const run = implementerByTask.get(probe.taskId);
    if (run === undefined) continue;
    const level = Math.min(DIFFICULTY_LEVELS.length - 1, Math.max(0, Math.round(probe.difficulty)));
    const bucket = acc.get(level) ?? { runs: 0, repaired: 0, predicted: 0 };
    bucket.runs += 1;
    bucket.predicted += probe.completesFirstTry;
    const repaired = (run.attempts ?? 1) > 1 || run.firstExitReason !== undefined || (run.exitReason !== undefined && run.exitReason !== 'completed');
    if (repaired) bucket.repaired += 1;
    acc.set(level, bucket);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, b]) => ({
      level: DIFFICULTY_LEVELS[level] ?? String(level),
      runs: b.runs,
      repaired: b.repaired,
      predictedFirstTry: Math.round((b.predicted / b.runs) * 1000) / 1000,
      observedFirstTry: Math.round((1 - b.repaired / b.runs) * 1000) / 1000,
    }));
}

function emptyBucket(): Bucket {
  return { entries: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, durationMs: 0 };
}

function add(bucket: Bucket, record: MetricRecord): void {
  bucket.entries += 1;
  bucket.costUsd += record.costUsd;
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket.cacheReadInputTokens += record.cacheReadInputTokens;
  bucket.durationMs += record.durationMs;
}

/**
 * Bucket key for the BY MODEL table: the served model, annotated with the configured one when a
 * gateway served something else — a silent substitution then shows up as its own row instead of
 * being folded into the model the operator asked for. Records predating the model field land in
 * one '(no model recorded)' row.
 */
export function modelKey(record: Pick<MetricRecord, 'model' | 'requestedModel'>): string {
  if (record.model === undefined) return record.requestedModel ?? '(no model recorded)';
  if (record.requestedModel === undefined || record.requestedModel === record.model) return record.model;
  return `${record.model} (requested ${record.requestedModel})`;
}

/** Aggregate records into per-task, per-stage, per-model, and grand-total buckets (+ probe join when given). */
export function aggregateMetrics(records: ReadonlyArray<MetricRecord>, probes: ReadonlyArray<ProbeRecord> = []): StatsReport {
  const byTask = new Map<string, Bucket>();
  const byStage = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const total = emptyBucket();
  const addTo = (map: Map<string, Bucket>, key: string, record: MetricRecord): void => {
    const bucket = map.get(key) ?? emptyBucket();
    add(bucket, record);
    map.set(key, bucket);
  };
  for (const record of records) {
    addTo(byTask, record.taskId, record);
    addTo(byStage, record.stage ?? '(none)', record);
    addTo(byModel, modelKey(record), record);
    add(total, record);
  }
  const entries = (map: Map<string, Bucket>): Array<{ key: string } & Bucket> =>
    [...map.entries()].map(([key, bucket]) => ({ key, ...bucket }));
  return {
    byTask: entries(byTask),
    byStage: entries(byStage),
    byModel: entries(byModel),
    total,
    ...(probes.length > 0 ? { probes: probeReport(records, probes) } : {}),
  };
}

function pct(bucket: Bucket): string {
  const fraction = cacheEfficiency({
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadInputTokens: bucket.cacheReadInputTokens,
  });
  return `${Math.round(fraction * 100)}%`;
}

function row(label: string, bucket: Bucket): string[] {
  return [
    label,
    String(bucket.entries),
    String(bucket.inputTokens),
    String(bucket.outputTokens),
    String(bucket.cacheReadInputTokens),
    pct(bucket),
    bucket.costUsd.toFixed(4),
    `${(bucket.durationMs / 1000).toFixed(1)}s`,
  ];
}

const HEADER = ['', 'runs', 'in', 'out', 'cacheR', 'cache%', '$cost', 'time'];

/** Render a stats report: per-task, per-stage and per-model tables, and a grand total. */
export function formatStats(report: StatsReport): string {
  const taskTable = alignTable([
    ['BY TASK', ...HEADER.slice(1)],
    ...report.byTask.map((b) => row(b.key, b)),
  ]);
  const stageTable = alignTable([
    ['BY STAGE', ...HEADER.slice(1)],
    ...report.byStage.map((b) => row(b.key, b)),
  ]);
  const modelTable = alignTable([
    ['BY MODEL', ...HEADER.slice(1)],
    ...report.byModel.map((b) => row(b.key, b)),
  ]);
  const totalLine = alignTable([row('TOTAL', report.total)]);
  const sections = [taskTable, '', stageTable, '', modelTable, '', totalLine];
  if (report.probes !== undefined && report.probes.length > 0) {
    // Predicted vs observed clean-first-attempt rate per predicted difficulty: if the probe is any
    // good, "predicted" tracks "observed" and both fall as the level rises.
    const probeTable = alignTable([
      ['PROBE: predicted difficulty', 'runs', 'repaired', 'pred.first-try', 'obs.first-try'],
      ...report.probes.map((b) => [b.level, String(b.runs), String(b.repaired), `${Math.round(b.predictedFirstTry * 100)}%`, `${Math.round(b.observedFirstTry * 100)}%`]),
    ]);
    sections.push('', probeTable);
  }
  return sections.join('\n');
}
