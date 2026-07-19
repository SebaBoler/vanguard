import type { FlowDoc, LoopDecl, StageDecl } from './types.js';

/** Override fields in canonical output order. HCL keys are the snake_case of these. */
const OVERRIDE_ORDER = ['model', 'effort', 'maxTurns', 'provider', 'resumePrevious'] as const;

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Canonical HCL emitter at the FlowDoc layer — the editor's write path (S5 D1). Unlike the lowered
 * emitter it carries `ref`, `meta` and `loop {}` through verbatim. Round-trip contract:
 * `parseFlowHcl(emitFlowDoc(doc))` deep-equals `doc`. Total-or-throw: a string containing HCL
 * template syntax (`${`/`%{` — unbalanced openers emit unparseable HCL, and quotes inside balanced
 * spans must not be escaped) or a meta value with no HCL representation throws rather than
 * silently dropping or corrupting.
 */
export function emitFlowDoc(doc: FlowDoc): string {
  const lines: string[] = [`flow "${quote(doc.name)}" {`, `  label = "${quote(doc.label)}"`];
  if (doc.meta !== undefined) lines.push(`  meta = ${emitValue(doc.meta, 'flow meta')}`);
  for (const stage of doc.stages) lines.push('', ...emitStage(stage));
  for (const loop of doc.loops) lines.push('', ...emitLoop(loop));
  lines.push('}', '');
  return lines.join('\n');
}

function emitStage(stage: StageDecl): string[] {
  const body: string[] = [`    name = "${quote(stage.name)}"`];
  if (stage.ref !== undefined) body.push(`    ref = "${quote(stage.ref)}"`);
  for (const field of OVERRIDE_ORDER) {
    const value = stage.overrides[field];
    if (value === undefined) continue;
    body.push(`    ${snake(field)} = ${typeof value === 'string' ? `"${quote(value)}"` : String(value)}`);
  }
  if (stage.meta !== undefined) body.push(`    meta = ${emitValue(stage.meta, `stage "${stage.name}" meta`)}`);
  return ['  stage {', ...body, '  }'];
}

function emitLoop(loop: LoopDecl): string[] {
  return [
    '  loop {',
    `    stages = [${loop.stages.map((s) => `"${quote(s)}"`).join(', ')}]`,
    `    until = "${quote(loop.until)}"`,
    `    max = ${loop.max}`,
    '  }',
  ];
}

/**
 * Meta values emit as attribute expressions with every object key quoted (a parseable key like
 * `"a b"` is not an HCL identifier — bare emission would make the doc unsaveable). Keys are sorted:
 * hcl2json alphabetizes on parse, so sorted output is the fixed point.
 */
function emitValue(value: unknown, where: string): string {
  if (typeof value === 'string') return `"${quote(value)}"`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot emit non-finite number in ${where}`);
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => emitValue(v, where)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `"${quote(k)}" = ${emitValue(v, where)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  throw new Error(`cannot emit ${typeof value} value in ${where}: no HCL representation`);
}

function quote(s: string): string {
  if (s.includes('${') || s.includes('%{')) {
    throw new Error(`cannot emit string containing HCL template syntax (\${ or %{): ${JSON.stringify(s)}`);
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
