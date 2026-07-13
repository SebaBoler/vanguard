/**
 * Every shared RunOptions flag set to a non-default value. The run/watch deps-threading tests assert
 * each per-source builder carries this whole object through `pickRunOptions`, so a dropped spread is
 * caught — a guard the type system cannot give, since RunOptions' fields are all optional.
 */
export const RUN_OPTIONS = {
  provider: 'codex',
  reviewProvider: 'cursor',
  providerModel: 'gpt-5',
  reviewModel: 'claude-opus',
  noSimplify: true,
  verifyCmd: 'pnpm test',
  visualProofCmd: 'pnpm screenshots',
  conformance: true,
  conformanceModel: 'opus',
  commitAuthor: { name: 'Sebastian Pietrzak', email: 'spietrza@gmail.com' },
  plan: true,
  // Coexists with `plan` on purpose: pickRunOptions does no conflict validation (that lives in args.ts),
  // and this fixture's whole job is to catch a field dropped from the spread.
  flow: 'flow-b',
  baseBranch: 'dev',
  maxTurns: 80,
  maxRepairIterations: 5,
} as const;
