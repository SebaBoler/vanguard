import { useState } from 'react';
import {
  LayoutDashboard,
  List,
  Columns3,
  Boxes,
  Cloud,
  Workflow,
  FileText,
  Settings as SettingsIcon,
  PanelLeft,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, Tooltip, cn } from '@/ui';
import type { Project, ActiveRun } from './vanguard-output';
import { relTime } from './time';
import { RailTip } from './RailTip';

export type Screen = 'dashboard' | 'runs' | 'board' | 'docs' | 'fleet' | 'remote' | 'workflow' | 'settings';

const NAV: { key: Screen; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'runs', label: 'Runs', icon: List },
  { key: 'board', label: 'Task board', icon: Columns3 },
  { key: 'docs', label: 'Docs', icon: FileText },
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
  // Base UI Collapsible owns the open/closed state (the trigger gets aria-expanded for free); we persist
  // it and drive the icon-only width off it rather than hiding a panel.
  const [open, setOpen] = useState(() => localStorage.getItem('vg-rail-collapsed') !== '1');
  const collapsed = !open;
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    localStorage.setItem('vg-rail-collapsed', next ? '0' : '1');
  };

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      render={<aside />}
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20 pt-2 transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-36',
      )}
    >
      <Tooltip.Provider delay={200}>
        <nav className="space-y-0.5 px-2">
          {NAV.map((n) => {
            const count = n.key === 'runs' ? active?.runCount : undefined;
            const Icon = n.icon;
            const btn = (
              <button
                type="button"
                onClick={() => onScreen(n.key)}
                className={cn(
                  'flex w-full items-center rounded py-1.5 text-sm transition-colors',
                  collapsed ? 'justify-center px-0' : 'gap-2 px-2',
                  screen === n.key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{n.label}</span>}
                {!collapsed && count != null && (
                  <span className="ml-auto text-xs tabular-nums">{count}</span>
                )}
              </button>
            );
            return (
              <RailTip key={n.key} collapsed={collapsed} label={count != null ? `${n.label} · ${count}` : n.label}>
                {btn}
              </RailTip>
            );
          })}
        </nav>

        {running.length > 0 && (
          <div className={collapsed ? 'mt-4 px-2' : 'mt-5 px-2'}>
            {!collapsed && (
              <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Running</div>
            )}
            <div className={collapsed ? 'flex flex-col items-center gap-1' : 'mt-1 space-y-1'}>
              {running.map((r) => {
                const btn = (
                  <button
                    type="button"
                    onClick={() => onOpenRunning(r)}
                    className={cn(
                      'rounded transition-colors hover:bg-muted/60',
                      collapsed ? 'flex justify-center p-2' : 'block w-full px-2 py-1.5 text-left',
                    )}
                  >
                    {collapsed ? (
                      <span className="size-2 animate-pulse rounded-full bg-success" />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{r.taskId}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {relTime(r.lastActivityMs)}
                        </span>
                      </div>
                    )}
                  </button>
                );
                return (
                  <RailTip key={r.taskId} collapsed={collapsed} label={`${r.taskId} · ${relTime(r.lastActivityMs)}`}>
                    {btn}
                  </RailTip>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-auto p-2 pt-3">
          <RailTip collapsed={collapsed} label="Expand sidebar">
            <Collapsible.Trigger
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'flex w-full items-center rounded py-1.5 text-sm font-normal text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                collapsed ? 'justify-center px-0' : 'justify-start gap-2 px-2',
              )}
            >
              <PanelLeft className="size-4 shrink-0" />
              {!collapsed && <span>Collapse</span>}
            </Collapsible.Trigger>
          </RailTip>
        </div>
      </Tooltip.Provider>
    </Collapsible.Root>
  );
}
