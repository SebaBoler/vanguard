import { z } from 'zod';
import { extractJson } from '../structured/extract.js';
import { StructuredOutputError } from '../core/errors.js';

/** Machine-checkable obligations a tech spec declares, emitted as a `<spec_manifest>` JSON block. */
export const specManifestSchema = z.object({
  files: z.array(z.object({ path: z.string(), required: z.boolean().optional() })).optional(),
  tests: z.array(z.object({ id: z.string(), file: z.string(), required: z.boolean().optional() })).optional(),
  acceptance: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        /** Set when the AC defines an artifact (e.g. a pre-change golden file) that must exist post-diff. */
        artifact: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Producer/consumer pairs: if `consumer` is in the diff, `producer` must be too (dangling-consumer check). */
  dependencies: z.array(z.object({ consumer: z.string(), producer: z.string() })).optional(),
});

export type SpecManifest = z.infer<typeof specManifestSchema>;

/** Parse the `<spec_manifest>` block from a tech spec. Returns undefined for legacy specs (no manifest) — never throws, so absence is always advisory-only, never a hard fail. */
export function parseSpecManifest(specText: string): SpecManifest | undefined {
  try {
    return extractJson(specText, 'spec_manifest', specManifestSchema);
  } catch (err) {
    if (err instanceof StructuredOutputError) return undefined;
    throw err;
  }
}

/** Extract every file path touched by a unified diff (both sides of renames), deduped. */
export function extractDiffFiles(diff: string): string[] {
  const files = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  for (const match of diff.matchAll(re)) {
    if (match[1] !== undefined) files.add(match[1]);
    if (match[2] !== undefined) files.add(match[2]);
  }
  return [...files];
}

/** Split a unified diff into per-file sections, keyed by the (post-image) path. */
function diffSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = diff.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const header = part.slice(0, part.indexOf('\n'));
    const match = /^a\/(.+?) b\/(.+)$/.exec(header);
    const path = match?.[2] ?? match?.[1];
    if (path !== undefined) sections.set(path, part);
  }
  return sections;
}

/** Language-agnostic signals that an added diff line introduces test content (not just a modified assertion). */
const TEST_LINE_PATTERNS = [
  /\b(?:it|describe|test)\s*\(/, // JS/TS
  /\bdef\s+test_\w+/, // Python
  /\bfunc\s+Test\w+/, // Go
  /#\[test\]/, // Rust
];

function sectionAddsTestContent(section: string | undefined): boolean {
  if (section === undefined) return false;
  return section
    .split('\n')
    .some((line) => line.startsWith('+') && !line.startsWith('+++') && TEST_LINE_PATTERNS.some((re) => re.test(line)));
}

/** Whether the diff adds new test content to `file` — a new file or new test blocks in an existing one. */
export function diffAddsTestContent(diff: string, file: string): boolean {
  return sectionAddsTestContent(diffSections(diff).get(file));
}

export interface ConformanceGap {
  missingFiles: string[];
  missingTests: { id: string; file: string }[];
  missingArtifacts: { id: string; artifact: string }[];
  danglingConsumers: { consumer: string; producer: string }[];
}

export interface ConformanceResult extends ConformanceGap {
  /** False when there is no manifest to check against (legacy spec / no spec) — always advisory-only then. */
  checked: boolean;
  pass: boolean;
}

const PASSING_RESULT: ConformanceResult = {
  checked: false,
  pass: true,
  missingFiles: [],
  missingTests: [],
  missingArtifacts: [],
  danglingConsumers: [],
};

/**
 * Deterministic spec-manifest vs diff conformance check. Host-side, no LLM call: a required file
 * never touched by the diff, a required test whose file has no new test content, a required
 * acceptance artifact absent from the diff, or a consumer wired to a producer that isn't in the
 * diff are all unambiguous, hard-fail signals. Everything fuzzier is out of scope here — the
 * declared-phasing PR body (`Part of #N` + deferred checklist) is the escape hatch for the rest.
 */
export function checkConformance(manifest: SpecManifest | undefined, diff: string): ConformanceResult {
  if (manifest === undefined) return PASSING_RESULT;

  const touched = new Set(extractDiffFiles(diff));
  const sections = diffSections(diff);
  const missingFiles = (manifest.files ?? [])
    .filter((f) => f.required !== false && !touched.has(f.path))
    .map((f) => f.path);
  const missingTests = (manifest.tests ?? [])
    .filter((t) => t.required !== false && !(touched.has(t.file) && sectionAddsTestContent(sections.get(t.file))))
    .map((t) => ({ id: t.id, file: t.file }));
  const missingArtifacts = (manifest.acceptance ?? [])
    .filter((a): a is typeof a & { artifact: string } => a.required !== false && a.artifact !== undefined && !touched.has(a.artifact))
    .map((a) => ({ id: a.id, artifact: a.artifact }));
  const danglingConsumers = (manifest.dependencies ?? []).filter((d) => touched.has(d.consumer) && !touched.has(d.producer));

  const pass = missingFiles.length === 0 && missingTests.length === 0 && missingArtifacts.length === 0 && danglingConsumers.length === 0;
  return { checked: true, pass, missingFiles, missingTests, missingArtifacts, danglingConsumers };
}

/**
 * Minimal failing-witness feedback for the implement-loop repair loop (CEGIS-style): only the unmet
 * obligations, not the full conformance prose or diff, so the repair context stays small and targeted.
 */
export function renderConformanceFeedback(gap: ConformanceGap): string {
  const lines: string[] = ['Conformance check failed against the spec manifest. Address these gaps specifically:'];
  if (gap.missingFiles.length > 0) lines.push(`- Untouched required files: ${gap.missingFiles.join(', ')}`);
  if (gap.missingTests.length > 0) {
    lines.push(`- Missing or incomplete required tests: ${gap.missingTests.map((t) => `${t.id} (${t.file})`).join(', ')}`);
  }
  if (gap.missingArtifacts.length > 0) {
    lines.push(`- Missing acceptance artifacts: ${gap.missingArtifacts.map((a) => `${a.id} (${a.artifact})`).join(', ')}`);
  }
  if (gap.danglingConsumers.length > 0) {
    lines.push(
      `- Dangling consumers (wired to a producer never implemented): ${gap.danglingConsumers
        .map((d) => `${d.consumer} depends on ${d.producer}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** GFM task-list checklist of every spec-manifest obligation, checked when satisfied per `result`. */
export function renderScopeChecklist(manifest: SpecManifest, result: ConformanceResult): string {
  const missingFilePaths = new Set(result.missingFiles);
  const missingTestIds = new Set(result.missingTests.map((t) => t.id));
  const missingArtifactIds = new Set(result.missingArtifacts.map((a) => a.id));
  const lines: string[] = [];

  const files = manifest.files ?? [];
  if (files.length > 0) {
    lines.push('**Spec files:**');
    for (const f of files) lines.push(`- [${missingFilePaths.has(f.path) ? ' ' : 'x'}] \`${f.path}\``);
  }
  const tests = manifest.tests ?? [];
  if (tests.length > 0) {
    lines.push('', '**Tests:**');
    for (const t of tests) lines.push(`- [${missingTestIds.has(t.id) ? ' ' : 'x'}] ${t.id} (\`${t.file}\`)`);
  }
  const acceptance = manifest.acceptance ?? [];
  if (acceptance.length > 0) {
    lines.push('', '**Acceptance criteria:**');
    for (const a of acceptance) {
      const blocked = a.artifact !== undefined && missingArtifactIds.has(a.id);
      lines.push(`- [${blocked ? ' ' : 'x'}] ${a.id}${a.description !== undefined && a.description !== '' ? `: ${a.description}` : ''}`);
    }
  }
  return lines.join('\n');
}

const TASK_REF_RE = /\b(?:closes|close|closed|fix|fixes|fixed|resolve|resolves|resolved|part of)\s+([^\s,;]+#\d+)/i;

/** Extract the taskId (e.g. `owner/repo#900`) a PR body references via a closing keyword or `Part of`. */
export function extractTaskIdFromPrBody(body: string): string | undefined {
  return TASK_REF_RE.exec(body)?.[1];
}
