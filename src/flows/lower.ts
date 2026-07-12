import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isProviderName, makeProvider } from '../agents/registry.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import { STAGE_LIBRARY } from './library.js';
import type { FlowDoc, StageDecl, StageOverrides } from './types.js';

/**
 * Lower a parsed FlowDoc to `PipelineStage[]` — the array the runner consumes. Each stage's base
 * record comes from the library (by name) or a `ref =` TS export (Layer 2), then HCL overrides are
 * spread on top (last-writer-wins, mirroring resolveRouting). `ref` paths are resolved and confined
 * to `<repoPath>/.vanguard/` (no escape). Source order is preserved.
 */
export async function lowerFlow(doc: FlowDoc, opts: { repoPath: string }): Promise<PipelineStage[]> {
  const out: PipelineStage[] = [];
  for (const decl of doc.stages) {
    const base = await resolveBase(decl, opts.repoPath);
    out.push(applyOverrides(base, decl.overrides));
  }
  return out;
}

async function resolveBase(decl: StageDecl, repoPath: string): Promise<PipelineStage> {
  if (decl.ref !== undefined) return resolveRef(decl.ref, repoPath);
  const factory = STAGE_LIBRARY[decl.name];
  if (factory === undefined) {
    throw new Error(`unknown stage "${decl.name}": not in the stage library and no ref given`);
  }
  return factory();
}

async function resolveRef(ref: string, repoPath: string): Promise<PipelineStage> {
  const hash = ref.indexOf('#');
  if (hash <= 0 || hash === ref.length - 1) {
    throw new Error(`invalid ref "${ref}": expected "relpath#export"`);
  }
  const rel = ref.slice(0, hash);
  const exportName = ref.slice(hash + 1);
  const root = resolve(repoPath, '.vanguard');
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`ref "${ref}" resolves outside ${join(repoPath, '.vanguard')} — refs must stay inside .vanguard/`);
  }
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const value = mod[exportName];
  if (value === undefined) throw new Error(`ref "${ref}": export "${exportName}" not found`);
  const record = typeof value === 'function' ? (value as () => PipelineStage)() : (value as PipelineStage);
  if (record === null || typeof record !== 'object' || typeof record.name !== 'string') {
    throw new Error(`ref "${ref}": export "${exportName}" is not a PipelineStage`);
  }
  return record;
}

function applyOverrides(base: PipelineStage, o: StageOverrides): PipelineStage {
  return {
    ...base,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
    ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
    ...(o.resumePrevious !== undefined ? { resumePrevious: o.resumePrevious } : {}),
    ...(o.provider !== undefined ? { provider: resolveProvider(o.provider) } : {}),
  };
}

function resolveProvider(name: string): ReturnType<typeof makeProvider> {
  if (!isProviderName(name)) throw new Error(`unknown provider "${name}"`);
  return makeProvider(name);
}
