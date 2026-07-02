#!/usr/bin/env tsx
// Thin CLI wrapper around src/core/openrouter-pricing-check.ts. Report-only; never edits the
// price table. Not typechecked (tsconfig `include` is `["src"]`) — keep all logic in src/.
import { formatDriftReport, runPricingCheck, scanUsedModels, strictExitCode } from '../src/core/openrouter-pricing-check.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const repoFlagIndex = argv.indexOf('--repo');
  const repoPath = repoFlagIndex !== -1 ? argv[repoFlagIndex + 1] : undefined;
  if (repoFlagIndex !== -1 && (repoPath === undefined || repoPath.startsWith('--'))) {
    console.error('openrouter pricing check: --repo requires a path');
    process.exitCode = 2;
    return;
  }
  const repo = repoPath ?? process.cwd();

  const usedModels = await scanUsedModels(repo);

  try {
    const report = await runPricingCheck({ usedModels });
    console.log(formatDriftReport(report));
    if (strict) {
      process.exitCode = strictExitCode(report);
    }
  } catch (err) {
    console.warn(`openrouter pricing check: advisory fetch failed, skipping (${(err as Error).message})`);
    process.exitCode = 0;
  }
}

await main();
