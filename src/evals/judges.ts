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
        return { passed: result, score: result ? 1 : 0, reason: result ? 'OK' : 'Predykat zwrócił false' };
      }
      return result;
    },
  };
}

export type Complete = (prompt: string) => Promise<string>;

const verdictSchema = z.object({
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
        role: 'Jesteś rygorystycznym sędzią oceniającym wynik agenta.',
        guidelines:
          'Oceń, czy wynik spełnia oczekiwanie. Zwróć JSON w tagu <verdict> z polami passed (bool), score (0..1), reason (string).',
        context: `Rodzaj przypadku: ${testCase.kind}\nWejście: ${testCase.input}\nOczekiwanie: ${testCase.expectation ?? '(brak — oceń sensowność)'}`,
        task: `Wynik agenta:\n${output}\n\nZwróć ocenę jako <verdict>{...}</verdict>.`,
      });
      const text = await complete(prompt);
      return extractJson(text, 'verdict', verdictSchema);
    },
  };
}
