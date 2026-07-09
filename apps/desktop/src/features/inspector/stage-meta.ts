import type { RunRecord } from '../../vanguard-output'

export function buildStageMeta(r: RunRecord): string[] {
  const seconds = r.durationMs ? Math.round(r.durationMs / 1000) : 0

  return [
    `${r.turns} turns`,
    `${seconds}s`,
    r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens} tok` : null,
    r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : null,
    r.model ?? 'unknown model',
  ].filter((x): x is string => x !== null)
}
