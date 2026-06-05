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
export { ClaudeCodeProvider } from './agents/claude-code.js';
export { PiProvider } from './agents/pi.js';
export { WorktreeManager } from './worktree/manager.js';
export { SkillRegistry } from './context/skill-registry.js';
export { renderPrompt } from './context/prompt-engine.js';
export { extractTag, extractJson, hasTerminationSignal } from './structured/extract.js';
export { DockerSandboxProvider } from './sandbox/docker.js';
export { FirecrackerSandboxProvider } from './sandbox/firecracker.js';
export type { Task, TaskFilter, TaskFetcher } from './tasks/fetcher.js';
export { taskToVariables } from './tasks/fetcher.js';
export { LinearTaskFetcher, createLinearTaskFetcher } from './tasks/linear.js';
export type { LinearClientLike, LinearIssueLike, LinearLabelNode } from './tasks/linear.js';
export { GitHubTaskFetcher } from './tasks/github.js';
export type { GhRunner, GitHubIssue, GitHubLabel } from './tasks/github.js';
export { runStages, implementReviewSimplifyStages, generateEvaluateRepairStages, commitStage } from './pipeline/pipeline.js';
export { buildXmlPrompt } from './context/xml-prompt.js';
export type { XmlPromptSections } from './context/xml-prompt.js';
export type { PipelineStage, StageOutcome, RunStagesOptions, CommitOptions, CommitOutcome } from './pipeline/pipeline.js';
export { reapContainers, dockerContainerLister, dockerContainerRemover, pruneWorktrees, type ContainerInfo, type ContainerLister, type ContainerRemover } from './core/gc.js';
