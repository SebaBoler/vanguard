import { describe, expect, it } from 'vitest';
import { reviewRequestBody } from './review-body.js';
import { checkConformance, type SpecManifest } from '../pipeline/conformance-gate.js';

const MANIFEST: SpecManifest = {
  files: [{ path: 'src/foo.ts' }],
  tests: [{ id: 'T1', file: 'src/foo.test.ts' }],
};

function fileSection(path: string, added: string[]): string {
  return [`diff --git a/${path} b/${path}`, '@@ -0,0 +1 @@', ...added.map((l) => `+${l}`)].join('\n');
}

describe('reviewRequestBody', () => {
  it('starts with Closes <task.id> when auto-close is enabled (legacy, no manifest)', () => {
    const taskId = 'owner/repo#42';
    const body = reviewRequestBody(taskId, { closeIssueOnMerge: true });
    expect(body).toBe(`Closes ${taskId}\n\nAutomated implementation of ${taskId} by Vanguard.`);
  });

  it('omits auto-close syntax by default (legacy, no manifest)', () => {
    const body = reviewRequestBody('LIN-42');
    expect(body).toBe('Automated implementation of LIN-42 by Vanguard.');
  });

  it('uses Closes with a full checklist when conformance passes', () => {
    const diff = [fileSection('src/foo.ts', ['export const foo = 1;']), fileSection('src/foo.test.ts', ['it("x", () => {});'])].join(
      '\n',
    );
    const conformance = checkConformance(MANIFEST, diff);
    const body = reviewRequestBody('owner/repo#42', { closeIssueOnMerge: true, conformance, manifest: MANIFEST });
    expect(body).toContain('Closes owner/repo#42');
    expect(body).toContain('## Spec conformance');
    expect(body).toContain('- [x] `src/foo.ts`');
    expect(body).toContain('- [x] T1 (`src/foo.test.ts`)');
  });

  it('uses Part of with unchecked deferred items when conformance is partial', () => {
    const conformance = checkConformance(MANIFEST, fileSection('src/foo.ts', ['export const foo = 1;']));
    const body = reviewRequestBody('owner/repo#42', { closeIssueOnMerge: true, conformance, manifest: MANIFEST });
    expect(body).toContain('Part of owner/repo#42');
    expect(body).not.toContain('Closes owner/repo#42');
    expect(body).toContain('- [x] `src/foo.ts`');
    expect(body).toContain('- [ ] T1 (`src/foo.test.ts`)');
    expect(body).toContain('Conformance gap detail');
  });

  it('falls back to legacy behavior for an unchecked conformance result', () => {
    const conformance = checkConformance(undefined, '');
    const body = reviewRequestBody('owner/repo#42', { closeIssueOnMerge: true, conformance });
    expect(body).toBe('Closes owner/repo#42\n\nAutomated implementation of owner/repo#42 by Vanguard.');
  });
});
