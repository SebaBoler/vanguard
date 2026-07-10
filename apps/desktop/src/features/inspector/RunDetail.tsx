import { useState } from 'react';
import { Tabs } from '@/ui';
import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import { SpecPane } from './SpecPane';
import type { RunDetail as RunDetailT } from '../../vanguard-output';

export function RunDetail({ detail, project }: { detail: RunDetailT; project: string }) {
  const [tab, setTab] = useState('overview');
  const diffStages = detail.stages.filter((s) => s.diff);
  const transcriptStages = detail.stages.filter((s) => s.transcript);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(String(v))}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List className="shrink-0">
        <Tabs.Tab value="overview">Overview</Tabs.Tab>
        <Tabs.Tab value="spec">Spec</Tabs.Tab>
        <Tabs.Tab value="diff">Diff</Tabs.Tab>
        <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
        <Tabs.Indicator />
      </Tabs.List>

      <Tabs.Panel value="overview" className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-4">
        <ProofGate proof={detail.proof} />
        <div className="space-y-2">
          {detail.stages.map((s, i) => (
            <StageCard key={i} stage={s} />
          ))}
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="spec" className="min-h-0 flex-1 overflow-y-auto pt-4">
        {tab === 'spec' && <SpecPane project={project} taskId={detail.taskId} />}
      </Tabs.Panel>

      <Tabs.Panel value="diff" className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4">
        {diffStages.length === 0 && <DiffView />}
        {diffStages.map((s, i) => (
          <div key={i} className="space-y-1">
            {diffStages.length > 1 && (
              <div className="font-mono text-xs text-muted-foreground">{s.record.stage ?? 'run'}</div>
            )}
            <DiffView diff={s.diff} />
          </div>
        ))}
      </Tabs.Panel>

      <Tabs.Panel value="transcript" className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4">
        {transcriptStages.length === 0 && <TranscriptView />}
        {transcriptStages.map((s, i) => (
          <div key={i} className="space-y-1">
            {transcriptStages.length > 1 && (
              <div className="font-mono text-xs text-muted-foreground">{s.record.stage ?? 'run'}</div>
            )}
            <TranscriptView transcript={s.transcript} />
          </div>
        ))}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
