import {
  LayoutDashboard,
  List,
  Columns3,
  Boxes,
  Cloud,
  Workflow,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Project, ActiveRun } from './vanguard-output';

export type Screen = 'dashboard' | 'runs' | 'board' | 'fleet' | 'remote' | 'workflow' | 'settings';

const NAV: { key: Screen; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'runs', label: 'Runs', icon: List },
  { key: 'board', label: 'Task board', icon: Columns3 },
  { key: 'fleet', label: 'Fleet', icon: Boxes },
  { key: 'remote', label: 'Remote', icon: Cloud },
  { key: 'workflow', label: 'Workflow', icon: Workflow },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Rail({
  projects,
  activePath,
  screen,
  running,
  onScreen,
  onOpenRunning,
}: {
  projects: Project[];
  activePath: string | null;
  screen: Screen;
  running: ActiveRun[];
  onScreen: (s: Screen) => void;
  onOpenRunning: (r: ActiveRun) => void;
}) {
  const active = projects.find((p) => p.path === activePath);

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20 pt-2">
      <nav className="space-y-0.5 px-2">
        {NAV.map((n) => {
          const count = n.key === 'runs' ? active?.runCount : undefined;
          const Icon = n.icon;
          return (
            <button
              key={n.key}
              onClick={() => onScreen(n.key)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                screen === n.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
              }`}
            >
              <Icon className="size-4" />
              {n.label}
              {count != null && <span className="ml-auto text-xs tabular-nums">{count}</span>}
            </button>
          );
        })}
      </nav>

      {running.length > 0 && (
        <div className="mt-5 px-2">
          <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Running</div>
          <div className="mt-1 space-y-1">
            {running.map((r) => (
              <button
                key={r.taskId}
                onClick={() => onOpenRunning(r)}
                className="block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
              >
                <div className="flex items-center gap-2">
                  <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
                  <span className="truncate font-mono text-xs font-medium">{r.taskId}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
