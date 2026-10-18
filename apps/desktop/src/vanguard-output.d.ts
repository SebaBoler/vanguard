// Hand-mirrors of the RUST serde structs in src-tauri (the persisted/aggregated shapes) — a TS
// seam cannot pin these; keep them in sync manually. Anything Rust passes through OPAQUELY
// belongs in src/wire.ts (the generated S7 contract), not here.
//
// The run-record/remote-run shapes ARE pinned by a TS seam: src/hub (the web hub) is a second,
// TS-side producer of these shapes, so they live in src/wire.ts and are re-exported below —
// drift between the hub and this app now fails CI instead of silently rendering stale UI.
import type { RunSummary } from './wire';
export type {
  AgentUsage,
  Proof,
  RemoteImport,
  RemoteRun,
  RunDetail,
  RunRecord,
  RunSummary,
  StageDetail,
  VisualProof,
  VisualProofArtifact,
} from './wire';

export interface ActiveRun {
  taskId: string;
  sessionFile: string;
  lastActivityMs: number;
}

export interface TranscriptEntry {
  role: 'assistant' | 'tool';
  text: string;
}

export interface SessionRead {
  entries: TranscriptEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Live spend estimate in USD (priced per-message off each message's model; unknown models add
   * nothing, so it's a lower bound — show as "~$"). */
  estCostUsd: number;
}


export interface AppConfig {
  source?: string;
  label?: string;
  team?: string;
  color?: string;
  provider?: string;
  reviewProvider?: string;
  verifyCmd?: string;
  concurrency?: number;
  budgetUsd?: number;
  runCommand?: string;
  /** Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; key is env-only. */
  chatModel?: string;
  chatBaseUrl?: string;
  /**
   * Custom providers (Subsystem 6). `keyEnv` is the NAME of the host env var holding the key —
   * the key itself is never stored. Nullable: Rust's emit-all serde writes null for absent.
   * Entries may carry unknown keys at runtime (Rust round-trips them as raw JSON); this is the
   * intended shape, validated by the core loader.
   */
  customProviders?: { name: string; baseUrl: string; keyEnv: string; model?: string }[] | null;
}

/** A CI run's downloaded `vanguard-runs` artifact, parsed like a local `.vanguard/runs`. */
export interface RemoteRecords {
  /** Cache dir laid out like a repo root — pass it to `readRun` as `repoPath`. */
  cachePath: string;
  runs: RunSummary[];
  /** Hub mode only: the records live under `<project>/.vanguard/remote-runs/<id>`, so `cachePath` is
   * the project itself and `readRun` needs this id to pick the remote root. */
  remoteRunId?: number;
}

export interface Project {
  path: string;
  name: string;
  runCount: number;
  taskCount: number;
  totalCostUsd: number;
  failedCount: number;
  lastRun?: string;
  runningCount: number;
  runsLast24h: number;
  color?: string;
}

/** Hub-only (src/hub/browse.ts) — one subdirectory offered by `browse_dirs`, standing in for the
 * native folder dialog Tauri doesn't have in a browser. */
export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasVanguard: boolean;
}

/** Hub-only (src/hub/browse.ts) — one `browse_dirs` page: the listed directory plus its children. */
export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}
