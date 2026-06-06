import { runLinearParent, linearDepsFromEnv } from '../src/runners/linear.js';

/**
 * Fan a Linear parent issue out into one run (and PR) per sub-issue, concurrently and with failure
 * isolation. (Same logic as `vanguard run --linear <ID> --parent`.)
 *
 *   LINEAR_API_KEY=$(op read "op://Personal/Linear API/credential") \
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
 *   REPO_PATH=/tmp/vanguard-e2e SKILLS_DIR=/tmp/linear-cli/skills \
 *     pnpm tsx examples/from-linear-parent.ts TES-1
 */
async function main(): Promise<void> {
  const parentRef = process.argv[2];
  if (parentRef === undefined) {
    throw new Error('Provide a Linear parent issue id: pnpm tsx examples/from-linear-parent.ts <ID>');
  }
  const concurrency = Number(process.env.FANOUT_CONCURRENCY ?? '2');
  const { parent, outcomes } = await runLinearParent(parentRef, linearDepsFromEnv(), { concurrency });
  console.log(`Parent: ${parent.id} — ${parent.title} (${parent.children.length} sub-tasks)`);
  if (parent.children.length === 0) {
    console.log('No sub-tasks — nothing to fan out.');
    return;
  }

  let opened = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.prUrl !== undefined) opened += 1;
      console.log(`  ${outcome.item.id}: ${outcome.value.prUrl ?? 'no changes (no PR)'}`);
    } else {
      failed += 1;
      console.log(`  ${outcome.item.id}: FAILED — ${String(outcome.reason)}`);
    }
  }
  console.log(`Done: ${opened} PR(s) opened, ${failed} failed, of ${parent.children.length} sub-tasks.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
