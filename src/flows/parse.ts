import { parse as hcl2json } from '@cdktf/hcl2json';
import type { FlowDoc, LoopDecl, StageDecl, StageOverrides } from './types.js';

/**
 * Parse an HCL flow file into a typed FlowDoc. Uses HashiCorp's real HCL parser (@cdktf/hcl2json,
 * WASM) so quoting/heredocs/comments are handled correctly. Scalars arrive unwrapped; repeated
 * blocks (`stage`, `loop`, `meta`) arrive as arrays — stage source order is preserved because
 * stages are label-less blocks (a labeled `stage "x" {}` would deserialize to an order-losing
 * name-keyed object). Unknown keys throw (typo protection); `until = "user_accept"` throws
 * (interactive gate deferred — see spec).
 */
export async function parseFlowHcl(src: string): Promise<FlowDoc> {
  const json = (await hcl2json('flow.hcl', src)) as Record<string, unknown>;
  const flow = json['flow'];
  if (flow === undefined) throw new Error('expected exactly one flow block, found none');
  // A label-less `flow {}` deserializes to an array; a labeled block to a name-keyed object.
  if (Array.isArray(flow) || typeof flow !== 'object') {
    throw new Error('flow block is missing its "<name>" label');
  }
  const names = Object.keys(flow as Record<string, unknown>);
  if (names.length !== 1) throw new Error(`expected exactly one flow block, found ${names.length}`);
  const name = names[0]!;
  const bodies = (flow as Record<string, unknown>)[name];
  // A second label (`flow "a" "b" {}`) leaves `bodies` a nested object, not the block array.
  if (!Array.isArray(bodies)) throw new Error(`flow "${name}" has an invalid or extra label`);
  if (bodies.length !== 1) throw new Error(`expected exactly one flow block named "${name}", found ${bodies.length}`);
  const body = bodies[0] as Record<string, unknown>;

  const label = body['label'];
  if (typeof label !== 'string') throw new Error(`flow "${name}" is missing a string label`);
  rejectUnknownKeys(body, FLOW_KEYS, `flow "${name}"`);

  const meta = parseMeta(body['meta']);
  return {
    name,
    label,
    stages: parseStages(body['stage'], name),
    loops: parseLoops(body['loop']),
    ...(meta !== undefined ? { meta } : {}),
  };
}

const OVERRIDE_KEYS = new Set(['model', 'effort', 'max_turns', 'provider', 'resume_previous']);
const FLOW_KEYS = new Set(['label', 'meta', 'stage', 'loop']);
const LOOP_KEYS = new Set(['stages', 'until', 'max']);

/** Throw on any key outside the allowed set — typo protection (spec §"HCL flow format v1"). */
function rejectUnknownKeys(block: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(block)) {
    if (!allowed.has(key)) throw new Error(`unknown key "${key}" in ${where}`);
  }
}

function parseStages(raw: unknown, flowName: string): StageDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`flow "${flowName}" stages must be label-less \`stage {}\` blocks`);
  return raw.map((s) => parseStage(s as Record<string, unknown>));
}

function parseStage(block: Record<string, unknown>): StageDecl {
  const name = block['name'];
  if (typeof name !== 'string' || name.trim() === '') throw new Error('a stage block is missing a string `name`');

  const overrides: StageOverrides = {};
  for (const [key, value] of Object.entries(block)) {
    if (key === 'name' || key === 'ref' || key === 'meta') continue;
    if (!OVERRIDE_KEYS.has(key)) throw new Error(`unknown key "${key}" in stage "${name}"`);
    applyOverride(overrides, key, value, name);
  }

  const ref = block['ref'];
  if (ref !== undefined && typeof ref !== 'string') throw new Error(`stage "${name}" ref must be a string`);

  const meta = parseMeta(block['meta']);
  return {
    name,
    ...(typeof ref === 'string' ? { ref } : {}),
    overrides,
    ...(meta !== undefined ? { meta } : {}),
  };
}

function applyOverride(o: StageOverrides, key: string, value: unknown, stage: string): void {
  switch (key) {
    case 'model':
      if (typeof value !== 'string') throw new Error(`stage "${stage}" model must be a string`);
      o.model = value;
      return;
    case 'provider':
      if (typeof value !== 'string') throw new Error(`stage "${stage}" provider must be a string`);
      o.provider = value;
      return;
    case 'effort':
      if (value !== 'low' && value !== 'medium' && value !== 'high') {
        throw new Error(`stage "${stage}" effort must be low|medium|high`);
      }
      o.effort = value;
      return;
    case 'max_turns':
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`stage "${stage}" max_turns must be a positive integer`);
      }
      o.maxTurns = value;
      return;
    case 'resume_previous':
      if (typeof value !== 'boolean') throw new Error(`stage "${stage}" resume_previous must be a boolean`);
      o.resumePrevious = value;
      return;
    default:
      throw new Error(`unknown key "${key}" in stage "${stage}"`);
  }
}

function parseLoops(raw: unknown): LoopDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('loop must be a block');
  return raw.map((l) => {
    const block = l as Record<string, unknown>;
    if (block['until'] === 'user_accept') {
      throw new Error('interactive gate not yet supported (needs pause/resume — future subsystem)');
    }
    rejectUnknownKeys(block, LOOP_KEYS, 'loop');
    const stages = block['stages'];
    const until = block['until'];
    const max = block['max'];
    if (!Array.isArray(stages) || !stages.every((s) => typeof s === 'string')) {
      throw new Error('loop stages must be a list of strings');
    }
    if (typeof until !== 'string') throw new Error('loop until must be a string');
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) throw new Error('loop max must be a positive integer');
    return { stages: stages as string[], until, max };
  });
}

/** A `meta {}` block deserializes to a single-element array; return its object verbatim. */
function parseMeta(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0] as Record<string, unknown>;
  return raw as Record<string, unknown>;
}
