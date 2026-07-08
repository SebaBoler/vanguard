import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { runSpecGenerator } from '../runners/spec.js';
import { specComment } from '../runners/watch.js';
import { GitHubTaskFetcher, commentGithubIssue } from '../tasks/github.js';
import type { RunSpecGeneratorDeps } from '../runners/spec.js';
import type { Command } from './args.js';

type SpecCommand = Extract<Command, { kind: 'spec' }>;

export interface SpecCommandDeps {
  /** Injected for tests: replaces the sandboxed spec generator (no Docker, no LLM). */
  generateSpec?: (id: string, deps: RunSpecGeneratorDeps) => Promise<string>;
  /** Injected for tests: replaces the gh-CLI comment post. */
  postComment?: (body: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * One-shot CLI spec pass: research the codebase read-only and post a tech-spec comment on one GitHub
 * issue. Unlike the watch spec pass this touches NO labels (no claim/advance) — pair it with
 * `vanguard run` on the same issue once the spec looks right. --commit-author white-labels the
 * comment heading; recognition is keyed on the <tech_spec> tag, so the readiness gate and the
 * conformance manifest see the spec either way.
 */
export async function specCommand(cmd: SpecCommand, deps: SpecCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const repoSlug = resolveRepoSlug(cmd.issueRef, cmd.repoSlug);
  const whiteLabel = cmd.commitAuthor !== undefined;
  const post =
    deps.postComment ??
    (async (body: string): Promise<void> => {
      await commentGithubIssue(repoSlug, cmd.issueRef, body);
    });

  const generatorDeps: RunSpecGeneratorDeps = {
    repoPath: cmd.repoPath,
    fetcher: new GitHubTaskFetcher(repoSlug),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
  };

  if (deps.generateSpec !== undefined) {
    const spec = await deps.generateSpec(cmd.issueRef, generatorDeps);
    await post(specComment(spec, { whiteLabel }));
    log(`spec ${cmd.issueRef}: posted${whiteLabel ? ' (white-label)' : ''}`);
    return;
  }

  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  const sandboxContext = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });
  try {
    const spec = await runSpecGenerator(cmd.issueRef, {
      ...generatorDeps,
      ...(auth !== undefined ? { auth } : {}),
      ...(sandboxContext.proxyUrl !== undefined ? { proxyUrl: sandboxContext.proxyUrl } : {}),
      ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
      ...(sandboxContext.llmProxy !== undefined ? { llmProxy: sandboxContext.llmProxy } : {}),
    });
    await post(specComment(spec, { whiteLabel }));
    log(`spec ${cmd.issueRef}: posted${whiteLabel ? ' (white-label)' : ''}`);
  } finally {
    await sandboxContext.destroy();
  }
}

function resolveRepoSlug(issueRef: string, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const hash = issueRef.indexOf('#');
  if (hash > 0) return issueRef.slice(0, hash);
  throw new Error(`spec: cannot determine repo slug from "${issueRef}" — use --github-repo`);
}
