import { execa } from 'execa';
import { runEvals } from '../evals/run-evals.js';
import { llmJudge } from '../evals/judges.js';
import { decisionJudge } from '../evals/decision-judge.js';
import { decisionModelConfig, isDecisionModelName } from '../core/decision-model.js';
import type { Judge } from '../evals/types.js';
import { corpus, JUDGE_MODEL, DEFAULT_PRODUCE_MODEL } from '../evals/corpus/index.js';
import { formatEvalReport } from '../evals/eval-report.js';
import { evalSuggestCommand } from './eval-suggest.js';
import type { Command } from './args.js';
import type { EvalCase } from '../evals/types.js';

type EvalCommand = Extract<Command, { kind: 'eval' }>;

/** Thin host-side completion: runs `claude --print --model <model>` with the prompt on stdin. */
export function makeCliComplete(model: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const result = await execa('claude', ['--print', '--model', model], { input: prompt });
    return result.stdout;
  };
}

/**
 * Run the committed eval corpus and print a per-kind pass-rate report.
 * The optional makeComplete parameter is injectable for testing.
 */
/** A decision model as the judge: calibrated P(acceptable) instead of an LLM's self-rated JSON. */
export function makeDecisionJudge(model: string): Judge {
  const config = decisionModelConfig(process.env, model);
  if (config === undefined) {
    throw new Error(`--judge-model ${model} needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AUTH_TOKEN (Workers AI) or VANGUARD_DECISION_URL.`);
  }
  return decisionJudge(config);
}

export async function evalCommand(
  cmd: EvalCommand,
  makeComplete: (model: string) => (prompt: string) => Promise<string> = makeCliComplete,
  makeDecision: (model: string) => Judge = makeDecisionJudge,
): Promise<void> {
  if (cmd.suggest) {
    await evalSuggestCommand(cmd);
    return;
  }

  const judgeModel = cmd.judgeModel ?? JUDGE_MODEL;
  const produceModel = cmd.produceModel ?? DEFAULT_PRODUCE_MODEL;

  const produceComplete = makeComplete(produceModel);

  const judge = isDecisionModelName(judgeModel) ? makeDecision(judgeModel) : llmJudge(makeComplete(judgeModel));
  const produce = (testCase: EvalCase) => produceComplete(testCase.input);

  const report = await runEvals({ cases: corpus, produce, judge });

  if (cmd.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatEvalReport(report));
}
