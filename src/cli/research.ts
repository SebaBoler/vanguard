import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, runAgent, disposeContext } from '../core/vanguard.js';
import { runResearch } from '../runners/research.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { Researcher } from '../runners/research.js';
import type { Command } from './args.js';

type ResearchCommand = Extract<Command, { kind: 'research' }>;

export interface ResearchCommandDeps {
  researcher?: Researcher;
  log?: (line: string) => void;
}

/** Run external research on a GitHub issue and post findings as a comment. Does not auto-advance. */
export async function researchCommand(cmd: ResearchCommand, deps: ResearchCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const repoSlug = resolveRepoSlug(cmd.issueRef, cmd.repoSlug);

  const runWith = async (researcher: Researcher): Promise<void> => {
    const result = await runResearch(cmd.issueRef, { repoSlug, researcher, webAccess: cmd.webAccess ?? false, log });
    log(`research ${cmd.issueRef}: iteration ${result.iteration} posted`);
  };

  if (deps.researcher !== undefined) {
    await runWith(deps.researcher);
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
    await runWith((prompt) => runDefaultResearcher(prompt, cmd, auth, sandboxContext));
  } finally {
    await sandboxContext.destroy();
  }
}

function resolveRepoSlug(issueRef: string, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const hash = issueRef.indexOf('#');
  if (hash > 0) return issueRef.slice(0, hash);
  throw new Error(`research: cannot determine repo slug from "${issueRef}" — use --github-repo`);
}

async function runDefaultResearcher(
  prompt: string,
  cmd: ResearchCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
): Promise<string> {
  const agents = selectAgents(cmd, process.env, { proxyMode: sandboxContext.llmProxy !== undefined });

  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(sandboxContext.proxyUrl, sandboxContext.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: 'vanguard-sandbox:latest',
      secrets: {
        ...(sandboxContext.llmProxy === undefined && auth !== undefined && agents.injectAnthropicAuth ? authSecrets(auth) : {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
    });
    const taskId = `research-${cmd.issueRef.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const ctx = await prepareContext({ taskId, localRepoPath: cmd.repoPath, sandbox, agentName: agents.agent.name });
    try {
      const result = await runAgent(ctx, {
        stageName: 'research',
        agent: agents.agent,
        promptTemplate: prompt,
        maxTurns: 12,
        copyBack: false,
        ...(cmd.researchModel !== undefined ? { model: cmd.researchModel } : {}),
      });
      return result.finalText;
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
