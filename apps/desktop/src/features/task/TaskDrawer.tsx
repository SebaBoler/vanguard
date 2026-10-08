import { useState } from 'react';
import { Clock, Plus, X } from 'lucide-react';

/** One conversation tab in the drawer strip. */
export interface DrawerTab {
  id: string;
  label: string;
  /** Turn in flight, or a reply landed while the tab wasn't focused — renders the dot. */
  dot: boolean;
  archived: boolean;
}

/** One History row. Unreadable rows are delete-only — they can never open as tabs. */
export interface HistoryRow {
  id: string;
  label: string;
  time: string | null;
  unreadable: boolean;
  archived: boolean;
}

/**
 * The chat drawer (task-page handoff §1–2): browser-style tab strip — pinned icon-only History
 * tab, horizontally scrollable conversation tabs, `+` for a fresh conversation — above either the
 * History list or the active conversation panel (passed as children). Purely presentational: all
 * state and persistence live in TaskDraftScreen.
 */
export function TaskDrawer({
  panel,
  tabs,
  activeId,
  rows,
  deleteArm,
  onShowHistory,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRename,
  onOpenRow,
  onArmDelete,
  onDelete,
  children,
}: {
  panel: 'history' | 'chat';
  tabs: DrawerTab[];
  /** null ⇒ the ephemeral fresh "New task…" tab is the active one. */
  activeId: string | null;
  rows: HistoryRow[];
  deleteArm: string | null;
  onShowHistory: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onRename: (id: string, name: string) => void;
  onOpenRow: (id: string) => void;
  onArmDelete: (id: string | null) => void;
  onDelete: (id: string) => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const commitRename = (): void => {
    if (editing !== null) onRename(editing.id, editing.text.trim());
    setEditing(null);
  };

  const tab = (t: DrawerTab): React.ReactElement => {
    const active = panel === 'chat' && t.id === activeId;
    return (
      <div
        key={t.id}
        className={`flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-sm ${
          active ? 'border-primary' : 'border-transparent text-muted-foreground'
        }`}
      >
        {editing?.id === t.id ? (
          <input
            aria-label={`rename ${t.label}`}
            autoFocus
            value={editing.text}
            onChange={(e) => setEditing({ id: t.id, text: e.target.value })}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(null);
            }}
            className="w-28 bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            aria-label={`tab ${t.label}`}
            onClick={() => onSelectTab(t.id)}
            onDoubleClick={() => {
              if (!t.archived) setEditing({ id: t.id, text: t.label });
            }}
            className="max-w-[9rem] truncate"
            title={t.label}
          >
            {t.label}
          </button>
        )}
        {t.dot && <span aria-label={`${t.label} activity`} className="h-1.5 w-1.5 rounded-full bg-primary" />}
        <button aria-label={`close ${t.label}`} onClick={() => onCloseTab(t.id)} className="hover:text-destructive">
          <X size={12} />
        </button>
      </div>
    );
  };

  const row = (e: HistoryRow): React.ReactElement => (
    <div key={e.id} className="group relative">
      <button
        aria-label={`open ${e.label}`}
        onClick={() => {
          if (!e.unreadable) onOpenRow(e.id);
        }}
        className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${
          e.unreadable ? 'cursor-default text-muted-foreground' : 'hover:bg-muted/20'
        }`}
      >
        {e.label}
        {e.time !== null && <span className="ml-1 text-[11px] text-muted-foreground">{e.time}</span>}
      </button>
      {deleteArm === e.id ? (
        <span className="absolute right-1 top-1 flex gap-1 rounded bg-background px-1 text-xs shadow">
          <button className="text-destructive" onClick={() => onDelete(e.id)}>
            delete
          </button>
          <button className="text-muted-foreground" onClick={() => onArmDelete(null)}>
            keep
          </button>
        </span>
      ) : (
        <button
          aria-label={`delete ${e.label}`}
          onClick={() => onArmDelete(e.id)}
          className="absolute right-1 top-1 hidden rounded px-1 text-xs text-muted-foreground hover:text-destructive group-hover:block"
        >
          ×
        </button>
      )}
    </div>
  );

  const active = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);

  return (
    <div className="flex w-[380px] shrink-0 flex-col border-l border-border pl-3">
      <div className="flex shrink-0 items-center gap-1 border-b border-border">
        <button
          aria-label="history"
          onClick={onShowHistory}
          className={`shrink-0 border-b-2 p-2 ${panel === 'history' ? 'border-primary' : 'border-transparent text-muted-foreground'}`}
        >
          <Clock size={14} />
        </button>
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map(tab)}
          {activeId === null && panel === 'chat' && (
            <span className="shrink-0 border-b-2 border-primary px-2 py-1 text-sm text-muted-foreground">
              New task…
            </span>
          )}
        </div>
        <button aria-label="new conversation" onClick={onNewTab} className="shrink-0 p-2 text-muted-foreground">
          <Plus size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 pt-2">
        {/* Both panels stay mounted — History is a picker; flipping to it must not tear down the
            conversation's scroll position or unsent composer text. */}
        <div className={panel === 'history' ? 'h-full space-y-1 overflow-auto' : 'hidden'}>
          {active.map(row)}
          {archived.length > 0 && (
            <>
              <div className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Archived
              </div>
              {archived.map(row)}
            </>
          )}
        </div>
        <div className={panel === 'chat' ? 'h-full' : 'hidden'}>{children}</div>
      </div>
    </div>
  );
}
