import type { PipelineStage } from '../pipeline/pipeline.js';

/** Fields the library re-supplies on parse; never emitted (their absence from HCL is by design). */
const IDENTITY = new Set(['name', 'promptTemplate', 'systemPrompt']);

/** Emittable override fields, in canonical output order. HCL keys are the snake_case of these. */
const EMITTABLE = ['model', 'effort', 'maxTurns', 'provider', 'resumePrevious'] as const;

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Emit a canonical HCL flow. Total-or-throw: any stage field that is neither library identity nor
 * an emittable override (e.g. stageCostFraction, timeoutMs, fallback) throws rather than silently
 * dropping — silent loss would change a pipeline's runtime cost/behaviour on reload. Stages are
 * label-less `stage {}` blocks with a `name` attribute so source order round-trips.
 */
export function emitFlowHcl(stages: PipelineStage[], opts: { name: string; label: string }): string {
  const lines: string[] = [`flow "${quote(opts.name)}" {`, `  label = "${quote(opts.label)}"`];
  for (const stage of stages) {
    lines.push('', ...emitStage(stage));
  }
  lines.push('}', '');
  return lines.join('\n');
}

function emitStage(stage: PipelineStage): string[] {
  for (const key of Object.keys(stage)) {
    if (IDENTITY.has(key)) continue;
    if (!(EMITTABLE as readonly string[]).includes(key)) {
      throw new Error(`cannot emit field "${key}" on stage "${stage.name}": no HCL representation (use a ref stage)`);
    }
  }
  const body: string[] = [`    name = "${quote(stage.name)}"`];
  for (const field of EMITTABLE) {
    const value = stage[field];
    if (value === undefined) continue;
    body.push(`    ${snake(field)} = ${emitValue(field, value)}`);
  }
  return ['  stage {', ...body, '  }'];
}

function emitValue(field: (typeof EMITTABLE)[number], value: unknown): string {
  if (field === 'provider') {
    const name = (value as { name?: unknown }).name;
    if (typeof name !== 'string') throw new Error('stage provider has no name to emit');
    return `"${quote(name)}"`;
  }
  if (typeof value === 'string') return `"${quote(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`cannot emit ${field}: unexpected value type`);
}

function quote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
