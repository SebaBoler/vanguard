import { describe, it, expect } from 'vitest';
import { execa } from 'execa';

/**
 * The test that would have caught the bug this file exists because of.
 *
 * `LinearCliTaskFetcher.list()` used to shell `linear issue query`, a command that does not exist in
 * the installed CLI. Every unit test passed, because they all inject a fake `LinearCliRunner` — and a
 * fake will happily answer a command that isn't there. The suite proved the parsing and nothing about
 * the contract, so `vanguard watch --linear` was broken in production while CI stayed green.
 *
 * So: one test that touches the real CLI. It asserts the contract we actually depend on, and the
 * absence of the one we wrongly depended on.
 *
 * Opt-in — it needs the real `linear` binary and a login, which CI has neither of. Run with:
 *   VANGUARD_LINEAR_IT=1 pnpm vitest run src/tasks/linear-contract.test.ts
 */
const IT = process.env['VANGUARD_LINEAR_IT'] === '1';

/** Exit code only — never capture the output of `auth token`, which prints a live credential. */
async function exitCode(args: string[]): Promise<number> {
  const { exitCode } = await execa('linear', args, { reject: false, stdout: 'ignore', stderr: 'ignore' });
  return exitCode ?? -1;
}

describe.skipIf(!IT)('linear CLI contract (integration)', () => {
  it('still provides `auth token` — the credential fallback depends on it', async () => {
    expect(await exitCode(['auth', 'token'])).toBe(0);
  });

  it('still provides `issue view --json` — fetch() depends on it', async () => {
    // No id: the command exists but errors on usage. What matters is that it is not "unknown command".
    const help = await execa('linear', ['issue', 'view', '--help'], { reject: false });
    expect(help.exitCode).toBe(0);
  });

  it('does NOT provide `issue query` — the command list() used to shell', async () => {
    // If this ever starts passing, the CLI grew the command back. Do not go back to it: GraphQL is
    // version-independent, and this whole outage was a CLI-version mismatch.
    expect(await exitCode(['issue', 'query', '--json'])).not.toBe(0);
  });
});
