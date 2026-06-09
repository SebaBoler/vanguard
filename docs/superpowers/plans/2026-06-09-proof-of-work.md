# Proof of Work (host-driven verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** After the agent finishes, the *host* (not the agent) runs a verification command inside the sandbox, captures its output, exit code, and a SHA-256 of the output, and stamps a Proof of Work block into the PR body and the run record. The agent cannot fake it. On failure the PR still opens, clearly marked.

**Decisions (locked in brainstorming):**
- On verify failure: always open the (draft) PR, stamp PASS/FAIL plus proof in the body, and best-effort add a `vanguard:verify-failed` label. Never silently swallow a red result.
- Verify command precedence: `--verify "<cmd>"` flag > `VANGUARD_VERIFY_CMD` env > auto-detect from `package.json` > skip (no command resolved means no Proof of Work block, graceful).
- v1 is test and log attestation only. Visual proofs (Playwright video) are a later phase, out of scope.

**Tech Stack:** TypeScript (strict, exactOptionalPropertyTypes), Vitest, `node:crypto` for SHA-256. Conventions: Polish commits no co-author, English code and docs, `.js` imports, no `any`, no em-dashes in prose.

**Model strategy for executing this plan:** implementer, reviewer, simplifier subagents on **sonnet**; planning (this doc) is opus.

---

## Task 1: verify.ts (resolve, run, proof block) + run-record persistence

**Files:** Create `src/pipeline/verify.ts`, `src/pipeline/verify.test.ts`; Modify `src/core/run-record.ts` (persist the proof) and `src/core/run-record.test.ts`.

- [ ] **Step 1 (TDD): `src/pipeline/verify.ts`** with three exports. Use the same `sh` alias pattern the providers use (bind the sandbox method to a local) so there is no bare `.exec` call site:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

export interface VerificationResult {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;        // over the combined stdout + stderr
  outputTail: string;    // last ~40 lines, for the PR body
}

const WORKDIR = '/workspace';

/**
 * Resolve the verification command. Precedence: explicit cmd (CLI flag) > VANGUARD_VERIFY_CMD env >
 * auto-detect from the worktree package.json > undefined (skip Proof of Work entirely).
 * Auto-detect: if package.json has a `test` script, build "<pm> install --frozen-lockfile && <pm> run
 * typecheck && <pm> test", including typecheck only when that script exists; pm from the
 * `packageManager` field (pnpm/yarn/npm), default npm.
 */
export async function resolveVerifyCommand(
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (opts.cmd !== undefined && opts.cmd !== '') return opts.cmd;
  const envCmd = (opts.env ?? process.env).VANGUARD_VERIFY_CMD;
  if (envCmd !== undefined && envCmd !== '') return envCmd;
  try {
    const pkg = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const scripts = pkg.scripts ?? {};
    if (scripts.test === undefined) return undefined;
    const field = pkg.packageManager ?? '';
    const pm = field.startsWith('pnpm') ? 'pnpm' : field.startsWith('yarn') ? 'yarn' : 'npm';
    const parts = [`${pm} install --frozen-lockfile`];
    if (scripts.typecheck !== undefined) parts.push(`${pm} run typecheck`);
    parts.push(`${pm} test`);
    return parts.join(' && ');
  } catch {
    return undefined;
  }
}

/** Run the command inside the sandbox (host-driven) and attest the result. */
export async function runVerification(
  sandbox: IsolatedSandboxProvider,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const sh = sandbox.exec.bind(sandbox);
  const res = await sh(command, { cwd: WORKDIR, ...(signal !== undefined ? { signal } : {}) });
  const output = `${res.stdout}\n${res.stderr}`;
  const sha256 = createHash('sha256').update(output).digest('hex');
  const outputTail = output.split('\n').slice(-40).join('\n').trimEnd();
  return { command, exitCode: res.exitCode, passed: res.exitCode === 0, sha256, outputTail };
}

/** Markdown Proof of Work block for the PR body. */
export function proofBlock(result: VerificationResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  return [
    `## Proof of work: ${status}`,
    '',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    `- sha256(output): \`${result.sha256}\``,
    '',
    '<details><summary>output tail</summary>',
    '',
    '```',
    result.outputTail,
    '```',
    '',
    '</details>',
  ].join('\n');
}
```

- [ ] **Step 2: verify.test.ts** (red then green):
  - `resolveVerifyCommand`: explicit cmd wins; env wins over auto-detect; auto-detect builds the pnpm/npm command when package.json has test (and typecheck) scripts; returns undefined when no package.json, no test script, or nothing set. Use a temp dir with a written package.json for the auto-detect cases.
  - `runVerification`: with a fake sandbox returning canned stdout/stderr and exitCode, assert `passed`, `exitCode`, a stable `sha256` (hash a known string and compare), and `outputTail` trimming.
  - `proofBlock`: contains PASS or FAIL, the command, the sha256, and a fenced output tail.

- [ ] **Step 3: persist the proof in the run record.** In `src/core/run-record.ts` add `persistVerification(localRepoPath, taskId, result, opts: { timestamp?: string })` that writes `<taskId>/<ts>.proof.json` (the VerificationResult) and appends a metric line `{ evt: 'verify', ts, taskId, passed, exitCode, sha256 }` to `metrics.jsonl`. Test it writes the file and the metric line.

- [ ] **Step 4:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: host-driven Proof of Work (verify.ts + zapis proofa)"`.

---

## Task 2: wire into runners + CLI flag/env + label on fail + docs

**Files:** Modify `src/runners/linear.ts`, `src/runners/github.ts`, `src/cli/args.ts` (and `args.test.ts`), `src/cli/run.ts`, `src/cli/watch.ts`, `README.md`, `docs/deploy.md`, `docker/compose.yaml`.

- [ ] **Step 1: deps + CLI.** Add `verifyCmd?: string` to `RunLinearIssueDeps` and `RunGithubIssueDeps`. Add a `--verify <cmd>` string flag to args on run and watch (Command members `verifyCmd?: string`, parse, USAGE). Thread `cmd.verifyCmd` into deps in `cli/run.ts` (linear spread, github mutate, project) and `cli/watch.ts` (linear deps object, buildGithubDeps), mirroring `--provider-model`.

- [ ] **Step 2: run verification in the runners.** In `runLinearIssue` and `runGithubIssue`, AFTER `runStages` returns and the work is copied back (the sandbox is still alive), but BEFORE `disposeContext`:
  ```ts
  const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});
  const verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
  ```
  Build the PR body as the base text plus `proofBlock(verification)` when present, and pass it to `publishForReview` (which already takes `body`). Keep the commit and publish flow otherwise unchanged (PR always opens). When `verification` exists, call `persistVerification(deps.repoPath, ctx.taskId, verification, ...)`.

- [ ] **Step 3: label on fail (best-effort).** After the PR opens, if `verification` exists and did not pass, add a `vanguard:verify-failed` label: first `gh label create vanguard:verify-failed --force` (ignore errors, it may already exist), then `gh pr edit <prUrl> --add-label vanguard:verify-failed`. Wrap in try/catch and never fail the run because labeling failed. Use the injected runner where one exists, else execa.

- [ ] **Step 4: docs.** README: add a short "Proof of work" note (the host runs the verify command, hashes the output, stamps the PR; `--verify` and `VANGUARD_VERIFY_CMD`; auto-detected for node repos). `docs/deploy.md`: add `VANGUARD_VERIFY_CMD` to the `.env` examples (e.g. `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`). `docker/compose.yaml`: add a commented `# VANGUARD_VERIFY_CMD:` line. No em-dashes in prose.

- [ ] **Step 5:** `pnpm typecheck && pnpm test` green. Commit: `git commit -am "feat: Proof of Work w runnerach + --verify/env + label na fail + docs"`.

---

## Verification
- typecheck clean, all tests green (new verify, run-record, args tests).
- Non-verify path unchanged: no command resolved means no proof block, PR body and flow identical to before.
- Trust: the command runs via the sandbox from the host orchestrator after the agent stages, so the agent cannot fabricate the result; the sha256 is over the captured output.

## Self-review
- Precedence flag > env > auto > skip, matches the locked decision.
- PR always opens (decision); failure is visible via the PASS/FAIL block and label, not by blocking.
- Visual proofs explicitly out of scope (v1).
