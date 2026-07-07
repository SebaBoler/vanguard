import { Tabs, Button, Chip } from 'chunks-ui';
import { ArrowLeft } from 'lucide-react';
import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import type { RunDetail as RunDetailT } from '../../vanguard-output';

export function RunDetail({ detail, onBack }: { detail: RunDetailT; onBack: () => void }) {
  const firstDiff = detail.stages.find((s) => s.diff)?.diff;
  const firstTranscript = detail.stages.find((s) => s.transcript)?.transcript;
  const passed = detail.proof
    ? detail.proof.passed
    : !detail.stages.some((s) => !s.record.completed);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="text"
          color="secondary"
          onClick={onBack}
          startIcon={<ArrowLeft className="size-4" />}
        >
          Back
        </Button>
        <h2 className="font-semibold">{detail.taskId}</h2>
        <span className="tabular-nums text-sm text-muted-foreground">{detail.timestamp}</span>
        <Chip className="ml-auto" color={passed ? 'success' : 'destructive'}>
          {passed ? 'passed' : 'failed'}
        </Chip>
      </div>

      <Tabs.Root defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="diff">Diff</Tabs.Tab>
          <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
          <Tabs.Indicator />
        </Tabs.List>

        <Tabs.Panel value="overview" className="space-y-3 pt-4">
          <ProofGate proof={detail.proof} />
          <div className="space-y-2">
            {detail.stages.map((s, i) => (
              <StageCard key={i} stage={s} />
            ))}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="diff" className="pt-4">
          <DiffView diff={firstDiff} />
        </Tabs.Panel>

        <Tabs.Panel value="transcript" className="pt-4">
          <TranscriptView transcript={firstTranscript} />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
