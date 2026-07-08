import { Chip } from 'chunks-ui';
import { Markdown } from './Markdown';
import { Callout } from './Callout';
import { type Finding } from './findings';
import { parseAgentText, type AgentTextSegment } from './parse-agent-text';

const SEVERITY_COLOR: Record<Finding['severity'], 'secondary' | 'warning' | 'destructive'> = {
  low: 'secondary',
  medium: 'warning',
  high: 'destructive',
  critical: 'destructive',
};

function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <div className="text-sm text-muted-foreground">No findings.</div>;
  return (
    <div className="space-y-3">
      {findings.map((f, i) => (
        <div key={`${i}:${f.severity}:${f.kind}:${f.title}`}>
          <div className="flex items-center gap-2">
            <Chip color={SEVERITY_COLOR[f.severity]}>{f.severity}</Chip>
            <span className="text-xs text-muted-foreground">{f.kind}</span>
            <span className="font-medium">{f.title}</span>
          </div>
          <Markdown>{f.evidence}</Markdown>
        </div>
      ))}
    </div>
  );
}

function renderSegment(seg: AgentTextSegment, key: number) {
  switch (seg.type) {
    case 'markdown':
      return <Markdown key={key}>{seg.text}</Markdown>;
    case 'chip':
      return (
        <div key={key} className="my-2">
          <Chip color="secondary" variant="outlined">
            {seg.tag}: {seg.text}
          </Chip>
        </div>
      );
    case 'findings':
      return (
        <Callout key={key} label={seg.tag}>
          <FindingsList findings={seg.findings} />
        </Callout>
      );
    case 'callout':
      return (
        <Callout key={key} label={seg.tag}>
          <Markdown>{seg.text}</Markdown>
        </Callout>
      );
  }
}

/** Render agent output: known `<tag>…</tag>` blocks become styled callouts; the rest is markdown. */
export function AgentText({ children }: { children: string }) {
  return <>{parseAgentText(children).map((seg, i) => renderSegment(seg, i))}</>;
}
