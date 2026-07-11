/**
 * Structured run events emitted by the pipeline runner and source-adapter when a caller passes
 * `onEvent`. Stage names are plain strings (matching StageOutcome.name) to keep this module
 * import-free. Consumed by the sidecar; the CLI never sets onEvent, so its behavior is unchanged.
 */
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number; usdCap: number }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean; partial?: boolean; reason?: string };
