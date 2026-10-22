import type { ApproverFacts, DiffFacts } from './types.js';

/**
 * An all-clean fact set: every rule passes on it, so a test states only the one signal it is about.
 * Shared by the rules tests (which rule fires) and the record tests (which field is carried).
 */
export function cleanDiff(overrides: Partial<DiffFacts> = {}): DiffFacts {
  return {
    files: 1, lines: 10, paths: ['src/foo.ts'],
    testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false,
    baseSha: 'base', headSha: 'head', mergeBase: 'base',
    headPatchId: 'p1', reviewedPatchId: undefined, reviewedIsAncestor: true,
    mergeTreeHeadClean: true, mergeTreeReviewedClean: undefined,
    headMoved: false, gitFactsFailed: false,
    ...overrides,
  };
}

export function cleanFacts(overrides: Partial<ApproverFacts> = {}): ApproverFacts {
  return {
    pr: { number: 1, url: '', state: 'OPEN', isDraft: false, headSha: 'head', headRefName: 'chore/vanguard-1', baseRefName: 'main', apiBaseSha: 'base', headRepo: 'o/r' },
    isFactoryPr: true,
    checks: [{ name: 'build', appId: 15368, conclusion: 'success' }, { name: 'dependency-review', appId: 15368, conclusion: 'success' }],
    review: { verdict: 'clean', sha: 'head', author: 'bot' },
    diff: cleanDiff(),
    ledger: {},
    thisPrLines: 10,
    ...overrides,
  };
}
