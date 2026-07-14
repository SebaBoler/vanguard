/**
 * Typed representation of a parsed HCL flow file. The shapes live in src/wire.ts (the shared
 * desktop contract — S7); this module stays the core-side import path.
 */
export type { StageOverrides, StageDecl, LoopDecl, FlowDoc } from '../wire.js';
