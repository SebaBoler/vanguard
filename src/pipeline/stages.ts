import type { AgentProvider } from '../agents/provider.js';

/** Single source of truth for all canonical pipeline stage names. String values are stable. */
export const STAGE = {
  IMPLEMENTER: 'implementer',
  REVIEWER: 'reviewer',
  SIMPLIFIER: 'simplifier',
  CONFORMANCE: 'conformance',
  PLANNER: 'planner',
  GENERATOR: 'generator',
  EVALUATOR: 'evaluator',
  REPAIRER: 'repairer',
  ADVERSARY: 'adversary',
  TECH_SPEC: 'tech-spec',
} as const;

/** Union of all canonical stage name string literals. A typo is a compile error. */
export type StageName = (typeof STAGE)[keyof typeof STAGE];

/** Per-stage routing overrides applied by resolveRouting. Each field is last-writer-wins. */
export interface StageRouting {
  provider?: AgentProvider;
  model?: string;
  fallback?: { provider: AgentProvider; model?: string };
}
