/** Single source of truth for the Flow B label — shared by the FLOWS registry, the emitter codegen
 * (`scripts/gen-flow-b.ts`), and the round-trip test, so the checked-in flow-b.hcl can't drift. */
export const FLOW_B_LABEL = 'Plan → implement → adversary → repair';
