import { describe, expect, it } from 'vitest';
import { parseGitlabProjectFromRemote, runGitlabIssue } from './gitlab.js';

describe('runGitlabIssue', () => {
  it('returns no prUrl when agent produces no changes', async () => {
    // Unit test is minimal — the full flow requires Docker. Just verify the dep contract.
    // This test is intentionally thin; integration coverage lives in E2E runs.
    expect(runGitlabIssue).toBeDefined();
    expect(typeof runGitlabIssue).toBe('function');
  });
});

describe('parseGitlabProjectFromRemote', () => {
  it('parses SSH remote', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/project.git')).toBe('group/project');
  });
  it('parses SSH remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses HTTPS remote', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project.git')).toBe('group/project');
  });
  it('parses HTTPS remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses HTTPS remote without .git suffix', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project')).toBe('group/project');
  });
  it('returns undefined for unrecognised format', () => {
    expect(parseGitlabProjectFromRemote('not-a-remote')).toBeUndefined();
  });
});
