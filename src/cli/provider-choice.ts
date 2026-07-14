import { loadCustomProviders } from '../agents/custom.js';
import { assertProvidersResolvable, validateProviderChoice, assertEgressCompatible } from '../agents/registry.js';
import type { ProviderChoice } from '../agents/registry.js';

/**
 * The S6 dispatch entry block, shared by run/watch: load the target repo's custom providers
 * (`cmd.repoPath`, NOT process.cwd() — `--repo` exists) and validate the full choice BEFORE any
 * side effect. This re-runs the pairing checks the sync parser skipped for a non-built-in
 * `--provider`, so directOnly/--llm-proxy, transport collisions, unknown names, and http+--egress
 * all fail here — before gc, auth resolution, and sandbox/enclave spin-up.
 */
export async function loadProviderChoice(cmd: {
  repoPath: string;
  provider?: string;
  reviewProvider?: string;
  egress?: boolean;
  llmProxy?: boolean;
}): Promise<ProviderChoice> {
  const customProviders = await loadCustomProviders(cmd.repoPath);
  const choice: ProviderChoice = {
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(customProviders.length > 0 ? { customProviders } : {}),
  };
  assertProvidersResolvable(choice); // unknown/broken names die here, before any side effect
  validateProviderChoice(choice, { proxyMode: cmd.llmProxy === true });
  if (cmd.egress === true || cmd.llmProxy === true) assertEgressCompatible(choice);
  return choice;
}
