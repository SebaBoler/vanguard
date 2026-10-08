import type { z } from 'zod';
import { StructuredOutputError } from '../core/errors.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractTag(text: string, tag: string): string | undefined {
  const safe = escapeRegExp(tag);
  const re = new RegExp(`<${safe}>([\\s\\S]*?)</${safe}>`, 'gi');
  let last: string | undefined;
  for (const match of text.matchAll(re)) {
    const inner = match[1];
    if (inner !== undefined) last = inner.trim();
  }
  return last;
}

/**
 * Like extractTag, but recovers a block whose closing tag never arrived: when no full
 * <tag>...</tag> pair exists yet a lone opening <tag> does, returns everything after it. This
 * rescues a long response truncated mid-stream — e.g. a corp MITM proxy severing an SSE before the
 * closing tag (see claude-stream.ts). `salvaged` marks the tail-may-be-clipped case so callers can
 * warn. Returns undefined only when the opening tag is absent entirely (nothing was produced).
 */
export function extractTagLenient(text: string, tag: string): { text: string; salvaged: boolean } | undefined {
  const strict = extractTag(text, tag);
  if (strict !== undefined && strict !== '') return { text: strict, salvaged: false };
  const open = new RegExp(`<${escapeRegExp(tag)}>`, 'i').exec(text);
  if (open === null) return undefined;
  const rest = text.slice(open.index + open[0].length).trim();
  return rest === '' ? undefined : { text: rest, salvaged: true };
}

const CODE_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

function stripCodeFences(raw: string): string {
  const match = CODE_FENCE.exec(raw.trim());
  return match?.[1] !== undefined ? match[1].trim() : raw;
}

export function extractJson<T>(text: string, tag: string, schema: z.ZodType<T>): T {
  const raw = extractTag(text, tag);
  if (raw === undefined) throw new StructuredOutputError(`Missing <${tag}> tag in the response`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (cause) {
    throw new StructuredOutputError(`Invalid JSON in <${tag}>`, { cause });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(`Validation of <${tag}> failed`, { cause: result.error });
  }
  return result.data;
}

const TERMINATION = /<promise>\s*COMPLETE\s*<\/promise>/i;
export function hasTerminationSignal(text: string): boolean {
  return TERMINATION.test(text);
}
