import { cacheEfficiency } from '../agents/provider.js';
import { alignTable } from './table.js';

/** One parsed `run_complete` line from .vanguard/runs/metrics.jsonl. */
export interface MetricRecord {
  taskId: string;
  stage?: string;
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

export interface StatsReport {
  byTask: Array<{ key: string } & Bucket>;
  byStage: Array<{ key: string } & Bucket>;
  total: Bucket;
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
      costUsd: num(parsed.costUsd),
      inputTokens: num(parsed.inputTokens),
      outputTokens: num(parsed.outputTokens),
      cacheReadInputTokens: num(parsed.cacheReadInputTokens),
      durationMs: num(parsed.durationMs),
    });
  }
  return records;
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

/** Aggregate records into per-task, per-stage, and grand-total buckets. */
export function aggregateMetrics(records: ReadonlyArray<MetricRecord>): StatsReport {
  const byTask = new Map<string, Bucket>();
  const byStage = new Map<string, Bucket>();
  const total = emptyBucket();
  for (const record of records) {
    const taskBucket = byTask.get(record.taskId) ?? emptyBucket();
    add(taskBucket, record);
    byTask.set(record.taskId, taskBucket);

    const stageKey = record.stage ?? '(none)';
    const stageBucket = byStage.get(stageKey) ?? emptyBucket();
    add(stageBucket, record);
    byStage.set(stageKey, stageBucket);

    add(total, record);
  }
  const entries = (map: Map<string, Bucket>): Array<{ key: string } & Bucket> =>
    [...map.entries()].map(([key, bucket]) => ({ key, ...bucket }));
  return { byTask: entries(byTask), byStage: entries(byStage), total };
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

/** Render a stats report: a per-task table, a per-stage table, and a grand total. */
export function formatStats(report: StatsReport): string {
  const taskTable = alignTable([
    ['BY TASK', ...HEADER.slice(1)],
    ...report.byTask.map((b) => row(b.key, b)),
  ]);
  const stageTable = alignTable([
    ['BY STAGE', ...HEADER.slice(1)],
    ...report.byStage.map((b) => row(b.key, b)),
  ]);
  const totalLine = alignTable([row('TOTAL', report.total)]);
  return [taskTable, '', stageTable, '', totalLine].join('\n');
}
