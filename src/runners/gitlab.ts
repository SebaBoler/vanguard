import { execa } from 'execa';
import { GitLabTaskFetcher, linkMergeRequest, addMrFailureLabel } from '../tasks/gitlab.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { parseMergeRequestRef, postMergeRequestNote, mergeRequestReviewMarker } from './mr-review.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import { renderConformanceSection, hasBlockingFinding } from '../pipeline/review-publish.js';
import { runSourcedIssue } from './source-adapter.js';
import { GITLAB_VERIFY_FAILED_LABEL, GITLAB_VISUAL_PROOF_FAILED_LABEL } from '../gitlab-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { ProviderName } from '../agents/registry.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { RunIssueDeps, SourceAdapter, PublishVerdictInput, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitLab issue end to end. */
export interface RunGitlabIssueDeps extends RunIssueDeps {
  /** GitLab project path, e.g. `group/project`. */
  project: string;
}

export interface RunGitlabIssueResult {
  task: Task;
  prUrl?: string;
}

/** @internal Exported for unit tests; production callers use runGitlabIssue. */
export function gitlabAdapter(deps: RunGitlabIssueDeps, glab?: GlabRunner): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const task = await new GitLabTaskFetcher(deps.project, glab).fetch(issueRef);
      return { task };
    },
    taskId: (task: Task) => `gl-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    reviewCli: 'glab',
    async publishVerdict(input: PublishVerdictInput) {
      if (input.reviewerOutcome === undefined) {
        throw new Error(`publishVerdict: no reviewer outcome for ${input.prUrl} — silence is not ok`);
      }
      const target = parseMergeRequestRef(input.prUrl);
      const verdictText = input.reviewerOutcome.result.finalText;
      // Build the comment body with attribution header and MR dedupe marker.
      const body = verdictText.replace(/<promise>\s*COMPLETE\s*<\/promise>/gi, '').trim();
      const sha7 = input.headSha.slice(0, 7);
      const header = `Reviewed by ${input.attribution} @ ${sha7}`;
      const visible = body === ''
        ? `## Vanguard Review\n\n${header}: no blocking issues`
        : `## Vanguard Review\n\n${header}:\n\n${body}`;
      let commentBody = `${visible}\n\n${mergeRequestReviewMarker(input.headSha)}`;

      const conformanceResult = input.conformanceOutcome?.result;
      if (conformanceResult !== undefined) {
        const section = renderConformanceSection(conformanceResult);
        if (section !== undefined) {
          commentBody = `${commentBody}\n\n## Conformance\n\n${section}`;
        }
      }

      // Gate degrades to a plain note on GitLab — no --request-changes equivalent.
      // Warn when blocking findings exist so silence ≠ enforcement.
      if (input.gate === true) {
        const conformanceGateText = conformanceResult?.completed === false ? undefined : conformanceResult?.finalText;
        const blocking =
          hasBlockingFinding(verdictText) || (conformanceGateText !== undefined && hasBlockingFinding(conformanceGateText));
        if (blocking) {
          commentBody = `${commentBody}\n\n> ⚠️ Blocking findings detected — review gate is not enforced on GitLab (no \`--request-changes\` equivalent). Please review manually.`;
        }
      }

      await postMergeRequestNote(target, commentBody, glab);
    },
    async addFailureLabel(mrUrl: string, kind: ProofFailureKind) {
      const label = kind === 'verify' ? GITLAB_VERIFY_FAILED_LABEL : GITLAB_VISUAL_PROOF_FAILED_LABEL;
      // Best-effort: a bad URL must never block the run (publishVerdict uses the same parser).
      let target: MergeRequestReviewTarget;
      try {
        target = parseMergeRequestRef(mrUrl);
      } catch {
        return;
      }
      await addMrFailureLabel(target.project, target.iid, label, glab);
    },
    async linkPr(issueRef: string, _task: Task, mrUrl: string) {
      await linkMergeRequest(deps.project, issueRef, mrUrl, glab);
    },
  };
}

/**
 * Run one GitLab issue end to end: fetch via `glab`, run the canonical implement/review/simplify
 * pipeline (plus optional conformance), open a draft MR, publish the reviewer verdict, and comment
 * the MR link back onto the issue.
 */
export async function runGitlabIssue(issueRef: string, deps: RunGitlabIssueDeps): Promise<RunGitlabIssueResult> {
  return runSourcedIssue(issueRef, deps, gitlabAdapter(deps));
}

/** Extract `group/project` from an SSH or HTTPS git remote URL. */
export function parseGitlabProjectFromRemote(remoteUrl: string): string | undefined {
  return remoteUrl.trim().match(/(?:https?:\/\/[^/]+\/|^[^:]+:)(.+?)(?:\.git)?$/)?.[1];
}

/** Assemble `RunGitlabIssueDeps` from environment + CLI flags (mirrors `githubDepsFromEnv`). */
export async function gitlabDepsFromEnv(
  repoPath: string,
  project: string | undefined,
  provider?: ProviderName,
  reviewProvider?: ProviderName,
): Promise<RunGitlabIssueDeps> {
  let resolvedProject = project;
  if (resolvedProject === undefined) {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const remote = stdout.trim();
    if (/github\.com|bitbucket\.org|dev\.azure\.com/.test(remote)) {
      throw new Error(`origin remote (${remote}) does not look like a GitLab host. Pass --gitlab-project explicitly.`);
    }
    resolvedProject = parseGitlabProjectFromRemote(remote);
    if (resolvedProject === undefined) throw new Error('Cannot detect GitLab project from origin remote. Pass --gitlab-project.');
  }
  return {
    repoPath,
    project: resolvedProject,
    ...(provider !== undefined ? { provider } : {}),
    ...(reviewProvider !== undefined ? { reviewProvider } : {}),
  };
}
