export { run, prepareContext, runAgent, disposeContext, type RunDeps, type RunContext, type PrepareOptions, type StageInput } from './core/vanguard.js';
export * as vanguard from './core/vanguard.js';
export type { RunOptions, RunResult, ReasoningEffort, ExitReason } from './core/types.js';
export type {
  IsolatedSandboxProvider,
  SandboxConfig,
  ExecOptions,
  ExecResult,
  ExecStream,
} from './sandbox/provider.js';
export type {
  AgentProvider,
  AgentRunInput,
  AgentRunOutput,
  AgentTurn,
  AgentUsage,
} from './agents/provider.js';
export { cacheEfficiency } from './agents/provider.js';
export { ClaudeCodeProvider } from './agents/claude-code.js';
export { authSecrets, authFromEnv, SUBSCRIPTION_ENV, API_ENV } from './agents/auth.js';
export type { AgentAuth } from './agents/auth.js';
export { PiProvider } from './agents/pi.js';
export { WorktreeManager } from './worktree/manager.js';
export { SkillRegistry, skillRegistryFromDirectory } from './context/skill-registry.js';
export { renderPrompt } from './context/prompt-engine.js';
export { extractTag, extractJson, hasTerminationSignal } from './structured/extract.js';
export { DockerSandboxProvider } from './sandbox/docker.js';
export { FirecrackerSandboxProvider } from './sandbox/firecracker.js';
export { fanOut, type FanOutOutcome, type FanOutOptions } from './pipeline/fan-out.js';
export type { Task, SubTask, TaskFilter, TaskFetcher } from './tasks/fetcher.js';
export { taskToVariables } from './tasks/fetcher.js';
export { LinearCliTaskFetcher, linkLinearIssue } from './tasks/linear-cli.js';
export type { LinearCliRunner, LinearCliOptions } from './tasks/linear-cli.js';
export { GitHubTaskFetcher, issueNumber, toTask, defaultGhRunner } from './tasks/github.js';
export type { GhRunner, GitHubIssue, GitHubLabel } from './tasks/github.js';
export { GitHubProjectFetcher } from './tasks/github-project.js';
export type { GitHubProjectFetcherOptions } from './tasks/github-project.js';
export { linkPullRequest } from './tasks/github.js';
export { runStages, runBudgetedStages, implementReviewSimplifyStages, generateEvaluateRepairStages, fastStages, planImplementReviewStages, defaultSystemPrompt, commitStage, publishForReview } from './pipeline/pipeline.js';
export { extractFindings, findingsSchema } from './structured/findings.js';
export type { Findings, Finding } from './structured/findings.js';
export { adversarySystemPrompt, planImplementAdversaryStages } from './pipeline/pipeline.js';
export { buildXmlPrompt } from './context/xml-prompt.js';
export type { XmlPromptSections } from './context/xml-prompt.js';
export type { PipelineStage, StageOutcome, RunStagesOptions, CommitOptions, CommitOutcome, PublishOptions, PublishOutcome, CommandRunner } from './pipeline/pipeline.js';
export type { FrozenRun, PipelineResult } from './pipeline/pipeline.js';
export { runJudgedRepair } from './pipeline/judged-repair.js';
export type { JudgedRepairOptions } from './pipeline/judged-repair.js';
export { installSignalCleanup, destroyAllTracked } from './core/cleanup.js';
export { setSandboxLimit, sandboxLimit } from './core/concurrency.js';
export { startEgressProxy, isAllowed, DEFAULT_EGRESS_ALLOWLIST, type EgressProxy } from './sandbox/egress-proxy.js';
export { persistRunRecord, persistStageOutcomes, type PersistOptions } from './core/run-record.js';
export { runGc, type GcCliOptions, type GcReport } from './cli/gc.js';
export {
  runLinearIssue,
  runLinearParent,
  linearDepsFromEnv,
  type RunLinearIssueDeps,
  type RunLinearIssueResult,
} from './runners/linear.js';
export {
  runGithubIssue,
  runGithubProject,
  githubDepsFromEnv,
  detectRepoSlug,
  type RunGithubIssueDeps,
  type RunGithubIssueResult,
} from './runners/github.js';
export { reapContainers, dockerContainerLister, dockerContainerRemover, pruneWorktrees, type ContainerInfo, type ContainerLister, type ContainerRemover } from './core/gc.js';
export {
  reapRemoteBranches,
  gitRemoteBranchLister,
  ghMergedPrChecker,
  gitRemoteBranchRemover,
  type RemoteBranchInfo,
  type RemoteBranchLister,
  type MergedChecker,
  type RemoteBranchRemover,
} from './core/gc.js';
export { runEvals } from './evals/run-evals.js';
export type { RunEvalsOptions } from './evals/run-evals.js';
export { buildMcpConfig, injectMcpServer, serverScriptPath, MCP_SERVER_NAME, MCP_TOOL_NAMES } from './mcp/config.js';
export type { McpServerSpec, InjectedMcp } from './mcp/config.js';
export { programmaticJudge, llmJudge } from './evals/judges.js';
export type { Predicate, Complete } from './evals/judges.js';
export type { EvalKind, EvalCase, EvalVerdict, EvalCaseResult, EvalReport, KindTally, Judge } from './evals/types.js';
