import { Card } from '../../components/atoms/Card';
import type { StageDetail } from '../../vanguard-output';

export function StageCard({ stage }: { stage: StageDetail }) {
  const r = stage.record;
  const seconds = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
  return (
    <Card>
      <div className="font-semibold">
        {r.stage ?? 'run'} · {r.exitReason}
      </div>
      <div className="text-sm opacity-80">
        {r.turns} turns · {seconds}s
        {r.usage ? ` · ${r.usage.inputTokens}/${r.usage.outputTokens} tok` : ''}
        {r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''} · {r.model ?? 'unknown model'}
      </div>
      <p className="mt-2 text-sm whitespace-pre-wrap">{r.finalText}</p>
    </Card>
  );
}
