import { Card } from '../../components/atoms/Card';
import type { RunSummary } from '../../vanguard-output';

export function RunList({
  runs,
  onSelect,
}: {
  runs: RunSummary[];
  onSelect: (r: RunSummary) => void;
}) {
  if (runs.length === 0) {
    return <div className="text-sm opacity-60">No runs found in .vanguard/runs.</div>;
  }
  return (
    <div className="space-y-2">
      {runs.map((r) => (
        <button
          key={`${r.taskId}:${r.timestamp}`}
          onClick={() => onSelect(r)}
          className="block w-full text-left"
        >
          <Card>
            <div className="font-semibold">
              {r.taskId}
              {r.anyFailed ? ' · ⚠ failed' : ''}
            </div>
            <div className="text-sm opacity-80">
              {r.timestamp} · {r.stages.join(', ')} · ${r.totalCostUsd.toFixed(2)}
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}
