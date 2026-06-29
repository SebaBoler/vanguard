import { execa } from 'execa';
import { runEvals } from '../evals/run-evals.js';
import { llmJudge } from '../evals/judges.js';
import { corpus, JUDGE_MODEL, DEFAULT_PRODUCE_MODEL } from '../evals/corpus/index.js';
import { formatEvalReport } from '../evals/eval-report.js';
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
export async function evalCommand(
  cmd: EvalCommand,
  makeComplete: (model: string) => (prompt: string) => Promise<string> = makeCliComplete,
): Promise<void> {
  const judgeModel = cmd.judgeModel ?? JUDGE_MODEL;
  const produceModel = cmd.produceModel ?? DEFAULT_PRODUCE_MODEL;

  const judgeComplete = makeComplete(judgeModel);
  const produceComplete = makeComplete(produceModel);

  const judge = llmJudge(judgeComplete);
  const produce = (testCase: EvalCase) => produceComplete(testCase.input);

  const report = await runEvals({ cases: corpus, produce, judge });

  if (cmd.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatEvalReport(report));
}
