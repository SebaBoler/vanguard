import { Card, Chip } from 'chunks-ui';
import { AgentText } from '../../components/AgentText';
import type { StageDetail } from '../../vanguard-output';

export function StageCard({ stage }: { stage: StageDetail }) {
  const r = stage.record;
  const seconds = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
  const meta = [
    `${r.turns} turns`,
    `${seconds}s`,
    r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens} tok` : null,
    r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : null,
    r.model ?? 'unknown model',
  ].filter((x): x is string => x !== null);

  return (
    <Card.Root>
      <Card.Header className="flex flex-row items-center justify-between gap-2 pb-2">
        <Card.Title className="text-sm">{r.stage ?? 'run'}</Card.Title>
        <Chip variant="outlined" color={r.completed ? 'success' : 'warning'}>
          {r.exitReason}
        </Chip>
      </Card.Header>
      <Card.Content className="pt-0">
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
        {r.finalText && <AgentText>{r.finalText}</AgentText>}
      </Card.Content>
    </Card.Root>
  );
}
