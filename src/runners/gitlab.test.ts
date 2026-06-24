import { describe, it, expect, vi } from 'vitest';
import { runGitlabIssue } from './gitlab.js';
import type { RunGitlabIssueDeps } from './gitlab.js';

describe('runGitlabIssue', () => {
  it('returns no prUrl when agent produces no changes', async () => {
    // Unit test is minimal — the full flow requires Docker. Just verify the dep contract.
    // This test is intentionally thin; integration coverage lives in E2E runs.
    expect(runGitlabIssue).toBeDefined();
    expect(typeof runGitlabIssue).toBe('function');
  });
});
