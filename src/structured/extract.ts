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

function stripCodeFences(raw: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = fence.exec(raw.trim());
  return match?.[1] !== undefined ? match[1].trim() : raw;
}

export function extractJson<T>(text: string, tag: string, schema: z.ZodType<T>): T {
  const raw = extractTag(text, tag);
  if (raw === undefined) throw new StructuredOutputError(`Brak taga <${tag}> w odpowiedzi`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (cause) {
    throw new StructuredOutputError(`Niepoprawny JSON w <${tag}>`, { cause });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(`Walidacja <${tag}> nie powiodła się`, { cause: result.error });
  }
  return result.data;
}

const TERMINATION = /<promise>\s*COMPLETE\s*<\/promise>/i;
export function hasTerminationSignal(text: string): boolean {
  return TERMINATION.test(text);
}
