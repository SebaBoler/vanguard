import type { PipelineStage } from '../pipeline/pipeline.js';
import { emitFlowDoc } from './emit-doc.js';
import type { StageDecl, StageOverrides } from './types.js';

/** Fields the library re-supplies on parse; never emitted (their absence from HCL is by design). */
const IDENTITY = new Set(['name', 'promptTemplate', 'systemPrompt']);

/** Emittable override fields. HCL keys are the snake_case of these. */
const EMITTABLE = ['model', 'effort', 'maxTurns', 'provider', 'resumePrevious'] as const;

/**
 * Emit a canonical HCL flow from lowered stages — a thin adapter over emitFlowDoc so there is
 * exactly one serializer (S5 §2; two independent emitters would drift and split the canonical
 * form between codegen- and editor-written files). Total-or-throw is preserved here: any stage
 * field that is neither library identity nor an emittable override (e.g. stageCostFraction,
 * timeoutMs, fallback) throws rather than silently dropping — silent loss would change a
 * pipeline's runtime cost/behaviour on reload.
 */
export function emitFlowHcl(stages: PipelineStage[], opts: { name: string; label: string }): string {
  return emitFlowDoc({ name: opts.name, label: opts.label, stages: stages.map(toDecl), loops: [] });
}

function toDecl(stage: PipelineStage): StageDecl {
  for (const key of Object.keys(stage)) {
    if (IDENTITY.has(key)) continue;
    if (!(EMITTABLE as readonly string[]).includes(key)) {
      throw new Error(`cannot emit field "${key}" on stage "${stage.name}": no HCL representation (use a ref stage)`);
    }
  }
  const overrides: StageOverrides = {};
  if (stage.model !== undefined) overrides.model = stage.model;
  if (stage.effort !== undefined) overrides.effort = stage.effort;
  if (stage.maxTurns !== undefined) overrides.maxTurns = stage.maxTurns;
  if (stage.resumePrevious !== undefined) overrides.resumePrevious = stage.resumePrevious;
  if (stage.provider !== undefined) {
    const name = (stage.provider as { name?: unknown }).name;
    if (typeof name !== 'string') throw new Error('stage provider has no name to emit');
    overrides.provider = name;
  }
  return { name: stage.name, overrides };
}
