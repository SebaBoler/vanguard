import { controlCases } from './control.js';
import { edgeCases } from './edge.js';
import { refusalCases } from './refusal.js';
import type { EvalCase } from '../types.js';

export { controlCases, edgeCases, refusalCases };

/**
 * Pinned judge model: fixed cheap Haiku-class, never the model under test.
 * Using the full dated model id (not the alias 'haiku') so a judge-model change is an explicit,
 * reviewable diff rather than a silent float across Haiku releases.
 */
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** Default model under test. Override via --produce-model when running vanguard eval. */
export const DEFAULT_PRODUCE_MODEL = 'claude-sonnet-4-6';

/** The full eval corpus: control, edge, and refusal cases. */
export const corpus: EvalCase[] = [...controlCases, ...edgeCases, ...refusalCases];
