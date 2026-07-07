import type { ReactNode } from 'react';

/** Left-accent box for agent semantic tags (findings/plan/promise/…). Color per known tag. */
const COLORS: Record<string, string> = {
  plan: 'border-sky-500/50',
  findings: 'border-amber-500/50',
  promise: 'border-green-500/50',
  review: 'border-violet-500/50',
};

export function Callout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={`not-prose my-3 rounded-md border-l-4 bg-muted/40 p-3 ${COLORS[label] ?? 'border-border'}`}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
