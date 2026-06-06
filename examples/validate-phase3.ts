import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  authFromEnv,
  authSecrets,
  DockerSandboxProvider,
  ClaudeCodeProvider,
  prepareContext,
  disposeContext,
  runStages,
  runBudgetedStages,
  runJudgedRepair,
  programmaticJudge,
  extractFindings,
  adversarySystemPrompt,
  type PipelineStage,
  type AgentAuth,
} from '../src/index.js';

/**
 * Live validation of Phase 3: adversarial review catches a vulnerability, HITL freezes after
 * repeated rejects, and the budget guardrail freezes when the cost ceiling is crossed.
 * Requires the vanguard-sandbox image and an auth credential (subscription token preferred).
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Claude OAuth/credential") pnpm tsx examples/validate-phase3.ts
 */
async function freshRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vg-validate-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# validate\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=v@v', '-c', 'user.name=v', 'commit', '-m', 'init'], { cwd: repo });
  return repo;
}

function sandbox(auth: AgentAuth): DockerSandboxProvider {
  return new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: authSecrets(auth),
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
  });
}

async function scenarioAdversary(auth: AgentAuth): Promise<void> {
  const repo = await freshRepo();
  const ctx = await prepareContext({ taskId: 'adv', localRepoPath: repo, sandbox: sandbox(auth) });
  try {
    const implementer: PipelineStage = {
      name: 'implementer',
      model: 'haiku',
      maxTurns: 14,
      promptTemplate:
        'Create src/user-files.ts exporting function readUserFile(name: string): string that reads and returns the contents of files/<name> using node fs (synchronous is fine). Keep it minimal, no validation. When done write <promise>COMPLETE</promise>.',
    };
    const adversary: PipelineStage = {
      name: 'adversary',
      model: 'opus',
      effort: 'high',
      maxTurns: 12,
      resumePrevious: false,
      systemPrompt: adversarySystemPrompt(),
      promptTemplate:
        'Review the diff below. Emit ONLY <findings>{...}</findings> matching the schema (severity, kind security|perf|correctness|style, title, evidence). Do not edit files.\n\n{{PREVIOUS_DIFF}}\n\nWhen done write <promise>COMPLETE</promise>.',
    };
    const outcomes = await runStages(ctx, [implementer, adversary], { agent: new ClaudeCodeProvider() });
    const adversaryText = outcomes[1]?.result.finalText ?? '';
    const findings = extractFindings(adversaryText);
    const security = findings.findings.filter((f) => f.kind === 'security');
    console.log(`[adversary] findings=${findings.findings.length} security=${security.length}`);
    for (const f of security) console.log(`  - [${f.severity}] ${f.title}`);
    console.log(`[adversary] PASS=${security.length > 0}`);
  } finally {
    await disposeContext(ctx, { keep: false });
    await rm(repo, { recursive: true, force: true });
  }
}

async function scenarioHitl(auth: AgentAuth): Promise<void> {
  const repo = await freshRepo();
  const ctx = await prepareContext({ taskId: 'hitl', localRepoPath: repo, sandbox: sandbox(auth) });
  try {
    const generate: PipelineStage = {
      name: 'generator',
      model: 'haiku',
      maxTurns: 6,
      promptTemplate: 'Create a file NOTES.txt with one line of text. When done write <promise>COMPLETE</promise>.',
    };
    const repair: PipelineStage = {
      name: 'repairer',
      model: 'haiku',
      maxTurns: 6,
      promptTemplate: 'A reviewer rejected the change: {{JUDGE_REASON}}. Make a small adjustment. When done write <promise>COMPLETE</promise>.',
    };
    const result = await runJudgedRepair(ctx, {
      agent: new ClaudeCodeProvider(),
      generate,
      repair,
      judge: programmaticJudge(() => false),
      maxRejects: 3,
    });
    const ok = result.status === 'frozen' && result.reason === 'needs_human';
    console.log(`[hitl] status=${result.status}`);
    if (result.status === 'frozen') console.log(`  reason=${result.reason} shell="${result.shellCommand}" passes=${result.outcomes.length}`);
    console.log(`[hitl] PASS=${ok}`);
  } finally {
    await disposeContext(ctx, { keep: false });
    await rm(repo, { recursive: true, force: true });
  }
}

async function scenarioBudget(auth: AgentAuth): Promise<void> {
  const repo = await freshRepo();
  const ctx = await prepareContext({ taskId: 'budget', localRepoPath: repo, sandbox: sandbox(auth) });
  try {
    const step = (name: string, file: string): PipelineStage => ({
      name,
      model: 'haiku',
      maxTurns: 6,
      promptTemplate: `Create a file ${file} with one line. When done write <promise>COMPLETE</promise>.`,
    });
    const result = await runBudgetedStages(ctx, [step('a', 'A.txt'), step('b', 'B.txt'), step('c', 'C.txt')], {
      agent: new ClaudeCodeProvider(),
      maxCostUsd: 0.0001,
    });
    const ok = result.status === 'frozen' && result.reason === 'budget_exceeded';
    console.log(`[budget] status=${result.status}`);
    if (result.status === 'frozen') console.log(`  reason=${result.reason} spentUsd=${result.spentUsd} ranStages=${result.outcomes.length}`);
    console.log(`[budget] PASS=${ok}`);
  } finally {
    await disposeContext(ctx, { keep: false });
    await rm(repo, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const auth = authFromEnv();
  if (auth === undefined) throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY before running.');
  console.log('=== Phase 3 live validation ===');
  await scenarioAdversary(auth);
  await scenarioHitl(auth);
  await scenarioBudget(auth);
  console.log('=== done ===');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
