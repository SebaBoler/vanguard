import { describe, expect, it } from 'vitest';
import {
  parseSpecManifest,
  extractDiffFiles,
  diffAddsTestContent,
  checkConformance,
  renderConformanceFeedback,
  renderScopeChecklist,
  extractTaskIdFromPrBody,
  type SpecManifest,
} from './conformance-gate.js';

const MANIFEST: SpecManifest = {
  files: [{ path: 'src/foo.ts' }],
  tests: [{ id: 'T1', file: 'src/foo.test.ts' }],
  acceptance: [{ id: 'AC-1', description: 'golden baseline', artifact: 'golden/base.txt' }],
  dependencies: [{ consumer: 'src/consumer.ts', producer: 'src/producer.ts' }],
};

function fileSection(path: string, added: string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1 @@', ...added.map((l) => `+${l}`)].join(
    '\n',
  );
}

function fullCoverageDiff(): string {
  return [
    fileSection('src/foo.ts', ['export const foo = 1;']),
    fileSection('src/foo.test.ts', ['it("works", () => {});']),
    fileSection('golden/base.txt', ['baseline']),
    fileSection('src/producer.ts', ['export const p = 1;']),
    fileSection('src/consumer.ts', ['import { p } from "./producer.js";']),
  ].join('\n');
}

describe('parseSpecManifest', () => {
  it('parses a valid manifest block', () => {
    const spec = `<tech_spec>...</tech_spec>\n<spec_manifest>${JSON.stringify(MANIFEST)}</spec_manifest>`;
    expect(parseSpecManifest(spec)).toEqual(MANIFEST);
  });

  it('returns undefined when the block is absent (legacy spec)', () => {
    expect(parseSpecManifest('<tech_spec>no manifest here</tech_spec>')).toBeUndefined();
  });

  it('returns undefined for a malformed manifest block', () => {
    expect(parseSpecManifest('<spec_manifest>{ not json }</spec_manifest>')).toBeUndefined();
    expect(parseSpecManifest('<spec_manifest>{"files":"nope"}</spec_manifest>')).toBeUndefined();
  });
});

describe('extractDiffFiles', () => {
  it('extracts both sides of a rename across a multi-file diff', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'diff --git a/src/keep.ts b/src/keep.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(new Set(extractDiffFiles(diff))).toEqual(new Set(['src/old.ts', 'src/new.ts', 'src/keep.ts']));
  });
});

describe('diffAddsTestContent', () => {
  it('detects test content added inside an existing file (content, not filename)', () => {
    const diff = fileSection('src/foo.test.ts', ['describe("x", () => {', '  it("y", () => {});', '});']);
    expect(diffAddsTestContent(diff, 'src/foo.test.ts')).toBe(true);
  });

  it('is false when a touched file adds no test blocks', () => {
    const diff = fileSection('src/foo.test.ts', ['const helper = 1;']);
    expect(diffAddsTestContent(diff, 'src/foo.test.ts')).toBe(false);
  });
});

describe('checkConformance', () => {
  it('is advisory-only (checked=false, pass) with no manifest', () => {
    const result = checkConformance(undefined, fullCoverageDiff());
    expect(result.checked).toBe(false);
    expect(result.pass).toBe(true);
  });

  it('PASSES when the diff covers every obligation', () => {
    const result = checkConformance(MANIFEST, fullCoverageDiff());
    expect(result.checked).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.missingFiles).toEqual([]);
    expect(result.missingTests).toEqual([]);
    expect(result.missingArtifacts).toEqual([]);
    expect(result.danglingConsumers).toEqual([]);
  });

  it('FAILS on a missing required file', () => {
    const manifest: SpecManifest = { files: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }] };
    const result = checkConformance(manifest, fileSection('src/foo.ts', ['x']));
    expect(result.pass).toBe(false);
    expect(result.missingFiles).toEqual(['src/bar.ts']);
  });

  it('FAILS when a required test file is touched but adds no test content', () => {
    const manifest: SpecManifest = { tests: [{ id: 'T1', file: 'src/foo.test.ts' }] };
    const result = checkConformance(manifest, fileSection('src/foo.test.ts', ['const noTestsHere = 1;']));
    expect(result.pass).toBe(false);
    expect(result.missingTests).toEqual([{ id: 'T1', file: 'src/foo.test.ts' }]);
  });

  it('PASSES when tests are added inside an existing file (content detection)', () => {
    const manifest: SpecManifest = { tests: [{ id: 'T1', file: 'src/foo.test.ts' }] };
    const result = checkConformance(manifest, fileSection('src/foo.test.ts', ['it("added", () => {});']));
    expect(result.pass).toBe(true);
    expect(result.missingTests).toEqual([]);
  });

  it('FAILS on a dangling consumer wired to a producer not in the diff', () => {
    const manifest: SpecManifest = { dependencies: [{ consumer: 'src/consumer.ts', producer: 'src/producer.ts' }] };
    const result = checkConformance(manifest, fileSection('src/consumer.ts', ['import x;']));
    expect(result.pass).toBe(false);
    expect(result.danglingConsumers).toEqual([{ consumer: 'src/consumer.ts', producer: 'src/producer.ts' }]);
  });

  it('FAILS on a missing acceptance artifact', () => {
    const manifest: SpecManifest = { acceptance: [{ id: 'AC-1', artifact: 'golden/base.txt' }] };
    const result = checkConformance(manifest, fileSection('src/foo.ts', ['x']));
    expect(result.pass).toBe(false);
    expect(result.missingArtifacts).toEqual([{ id: 'AC-1', artifact: 'golden/base.txt' }]);
  });

  it('ignores non-required obligations', () => {
    const manifest: SpecManifest = { files: [{ path: 'src/optional.ts', required: false }] };
    expect(checkConformance(manifest, fileSection('src/other.ts', ['x'])).pass).toBe(true);
  });
});

describe('renderConformanceFeedback', () => {
  it('lists only the unmet obligations', () => {
    const feedback = renderConformanceFeedback({
      missingFiles: ['src/bar.ts'],
      missingTests: [{ id: 'T1', file: 'src/foo.test.ts' }],
      missingArtifacts: [{ id: 'AC-1', artifact: 'golden/base.txt' }],
      danglingConsumers: [{ consumer: 'src/consumer.ts', producer: 'src/producer.ts' }],
    });
    expect(feedback).toContain('src/bar.ts');
    expect(feedback).toContain('T1 (src/foo.test.ts)');
    expect(feedback).toContain('AC-1 (golden/base.txt)');
    expect(feedback).toContain('src/consumer.ts depends on src/producer.ts');
  });
});

describe('renderScopeChecklist', () => {
  it('checks satisfied obligations and leaves gaps unchecked', () => {
    const result = checkConformance(MANIFEST, fileSection('src/foo.ts', ['x']));
    const checklist = renderScopeChecklist(MANIFEST, result);
    expect(checklist).toContain('- [x] `src/foo.ts`');
    expect(checklist).toContain('- [ ] T1 (`src/foo.test.ts`)');
    expect(checklist).toContain('- [ ] AC-1: golden baseline');
  });
});

describe('extractTaskIdFromPrBody', () => {
  it('extracts the ref from a closing keyword', () => {
    expect(extractTaskIdFromPrBody('Closes owner/repo#42\n\nbody')).toBe('owner/repo#42');
  });

  it('extracts the ref from a Part of declaration', () => {
    expect(extractTaskIdFromPrBody('Part of owner/repo#42')).toBe('owner/repo#42');
  });

  it('returns undefined when no ref is present', () => {
    expect(extractTaskIdFromPrBody('no references here')).toBeUndefined();
  });
});
