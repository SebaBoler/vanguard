import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileCode2, Repeat2 } from 'lucide-react';
import type { FlowDoc } from '../../ipc';

/**
 * Stage blocks in source order (layout is DERIVED — nothing spatial enters the HCL, S5 non-goal).
 * Reorder via native HTML5 drag (no dnd dependency) plus keyboard ◀/▶ buttons; the actual move is
 * a pure reducer action, which is where reordering is tested (jsdom has no drag geometry).
 * Loops render as a read-only chip: they round-trip verbatim, editing them is deferred until
 * loops can run.
 */
export function FlowCanvas({
  doc,
  palette,
  selected,
  onSelect,
  onMove,
}: {
  doc: FlowDoc;
  palette: string[];
  selected: number | null;
  onSelect: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  return (
    <div className="min-h-[24rem] overflow-x-auto rounded-lg border border-border bg-[radial-gradient(circle,theme(colors.border)_1px,transparent_1px)] [background-size:16px_16px] p-6">
      {doc.loops.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {doc.loops.map((loop, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-2.5 py-1 text-xs text-muted-foreground"
              title={`loop until ${loop.until}, max ${loop.max} — loops are read-only for now and survive edits untouched`}
            >
              <Repeat2 className="size-3.5" aria-hidden />
              {loop.stages.join(' ⇄ ')} · until {loop.until} · max {loop.max}
            </span>
          ))}
        </div>
      )}

      {doc.stages.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          No stages yet — add one from the palette to make this flow saveable.
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {doc.stages.map((stage, i) => {
            const unknown = stage.ref === undefined && !palette.includes(stage.name);
            const overrides = Object.entries(stage.overrides).map(([k, v]) => `${k}=${String(v)}`);
            return (
              <div key={i} className="flex items-start gap-2">
                <div
                  draggable
                  onDragStart={() => {
                    dragFrom.current = i;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(i);
                  }}
                  onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(null);
                    if (dragFrom.current !== null && dragFrom.current !== i) onMove(dragFrom.current, i);
                    dragFrom.current = null;
                  }}
                  className={dragOver === i ? 'rounded-md ring-2 ring-primary/40' : undefined}
                >
                  {/* the block frame is NOT interactive itself — the selectable area and the move
                      controls are sibling buttons inside it, so no interactive element nests
                      inside another (a11y: nested role=button confuses AT) */}
                  <div
                    data-testid={`stage-block-${i}`}
                    className={`w-44 cursor-grab rounded-md border bg-background p-3 transition-colors ${
                      selected === i
                        ? 'border-primary ring-1 ring-primary/40'
                        : unknown
                          ? 'border-amber-500/60 hover:border-amber-500'
                          : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <button
                      onClick={() => onSelect(i)}
                      className="block w-full text-left"
                      aria-label={`select ${stage.name}`}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className={`size-2 rounded-full ${unknown ? 'bg-amber-500' : 'bg-primary/70'}`} />
                        <span className="truncate">{stage.name}</span>
                        {stage.ref !== undefined && (
                          <span className="ml-auto inline-flex items-center gap-1 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] text-violet-600 dark:text-violet-400">
                            <FileCode2 className="size-3" aria-hidden /> ref
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {unknown ? 'not in library — pick a name or add a ref' : overrides.length > 0 ? overrides.join(' ') : 'library defaults'}
                      </span>
                    </button>
                    <div className="mt-2 flex gap-1">
                      <button
                        aria-label={`move ${stage.name} left`}
                        disabled={i === 0}
                        onClick={() => onMove(i, i - 1)}
                        className="rounded border border-border p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowLeft className="size-3" aria-hidden />
                      </button>
                      <button
                        aria-label={`move ${stage.name} right`}
                        disabled={i === doc.stages.length - 1}
                        onClick={() => onMove(i, i + 1)}
                        className="rounded border border-border p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowRight className="size-3" aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
                {i < doc.stages.length - 1 && <span className="mt-8 text-muted-foreground">→</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
