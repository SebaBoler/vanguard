import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import type { RunDetail as RunDetailT } from '../../vanguard-output';

export function RunDetail({ detail, onBack }: { detail: RunDetailT; onBack: () => void }) {
  const firstDiff = detail.stages.find((s) => s.diff)?.diff;
  const firstTranscript = detail.stages.find((s) => s.transcript)?.transcript;
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm underline">
        ← back
      </button>
      <h2 className="text-lg font-semibold">
        {detail.taskId} · {detail.timestamp}
      </h2>
      <ProofGate proof={detail.proof} />
      <div className="space-y-2">
        {detail.stages.map((s, i) => (
          <StageCard key={i} stage={s} />
        ))}
      </div>
      <section>
        <h3 className="font-semibold">Diff</h3>
        <DiffView diff={firstDiff} />
      </section>
      <section>
        <h3 className="font-semibold">Transcript</h3>
        <TranscriptView transcript={firstTranscript} />
      </section>
    </div>
  );
}
