import { test, expect } from 'vitest'
import { buildStageMeta } from './stage-meta'
import type { RunRecord } from '../../vanguard-output'

const base: RunRecord = {
  taskId: 'task-1',
  completed: true,
  exitReason: 'success',
  turns: 3,
  worktreePath: '/tmp/wt',
  worktreePreserved: false,
  finalText: 'done',
  timestamp: '2026-07-06T19:12:02.123Z',
}

test('formats duration, usage, cost, and model when present', () => {
  const meta = buildStageMeta({
    ...base,
    durationMs: 4500,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0 },
    costUsd: 0.5,
    model: 'sonnet',
  })
  expect(meta).toEqual(['3 turns', '5s', '100/20 tok', '$0.50', 'sonnet'])
})

test('omits usage and cost when absent, falls back to unknown model', () => {
  const meta = buildStageMeta(base)
  expect(meta).toEqual(['3 turns', '0s', 'unknown model'])
})

test('shows zero cost when costUsd is 0', () => {
  const meta = buildStageMeta({ ...base, costUsd: 0 })
  expect(meta).toContain('$0.00')
})
