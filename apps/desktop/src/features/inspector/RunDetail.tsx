import { useState } from 'react';
import { Tabs } from 'chunks-ui';
import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import { SpecPane } from './SpecPane';
import type { RunDetail as RunDetailT } from '../../vanguard-output';

export function RunDetail({ detail, project }: { detail: RunDetailT; project: string }) {
  const [tab, setTab] = useState('overview');
  const firstDiff = detail.stages.find((s) => s.diff)?.diff;
  const firstTranscript = detail.stages.find((s) => s.transcript)?.transcript;

  return (
    <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))}>
      <Tabs.List>
        <Tabs.Tab value="overview">Overview</Tabs.Tab>
        <Tabs.Tab value="spec">Spec</Tabs.Tab>
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

      <Tabs.Panel value="spec" className="pt-4">
        {tab === 'spec' && <SpecPane project={project} taskId={detail.taskId} />}
      </Tabs.Panel>

      <Tabs.Panel value="diff" className="pt-4">
        <DiffView diff={firstDiff} />
      </Tabs.Panel>

      <Tabs.Panel value="transcript" className="pt-4">
        <TranscriptView transcript={firstTranscript} />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
