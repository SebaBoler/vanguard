import { z } from 'zod';
import { extractJson } from '../structured/extract.js';
import { buildXmlPrompt } from '../context/xml-prompt.js';
import type { EvalCase, EvalVerdict, Judge } from './types.js';

export type Predicate = (testCase: EvalCase, output: string) => boolean | EvalVerdict;

/** Judge by a programmatic predicate. A boolean becomes score 1/0. */
export function programmaticJudge(predicate: Predicate): Judge {
  return {
    judge: async ({ testCase, output }): Promise<EvalVerdict> => {
      const result = predicate(testCase, output);
      if (typeof result === 'boolean') {
        return { passed: result, score: result ? 1 : 0, reason: result ? 'OK' : 'Predicate returned false' };
      }
      return result;
    },
  };
}

export type Complete = (prompt: string) => Promise<string>;

export const verdictSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string(),
});

/**
 * Judge with an LLM. `complete` runs a model and returns its text; the verdict is parsed from a
 * Zod-validated <verdict> JSON tag. Inject a real completion in production, a fake in tests.
 */
export function llmJudge(complete: Complete): Judge {
  return {
    judge: async ({ testCase, output }): Promise<EvalVerdict> => {
      const prompt = buildXmlPrompt({
        role: 'You are a strict judge evaluating an agent output.',
        guidelines:
          'Judge whether the output meets the expectation. Return JSON in a <verdict> tag with fields passed (bool), score (0..1), reason (string).',
        context: `Case kind: ${testCase.kind}\nInput: ${testCase.input}\nExpectation: ${testCase.expectation ?? '(none — judge reasonableness)'}`,
        task: `Agent output:\n${output}\n\nReturn the verdict as <verdict>{...}</verdict>.`,
      });
      const text = await complete(prompt);
      return extractJson(text, 'verdict', verdictSchema);
    },
  };
}
