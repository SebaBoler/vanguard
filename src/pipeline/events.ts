/**
 * Structured run events emitted by the pipeline runner and source-adapter when a caller passes
 * `onEvent`. The type lives in src/wire.ts (the shared desktop contract — S7); this module stays
 * the core-side import path. Consumed by the sidecar; the CLI never sets onEvent.
 */
export type { RunEvent } from '../wire.js';
