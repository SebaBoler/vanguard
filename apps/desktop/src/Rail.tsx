import { ThemeToggle, type Theme } from 'chunks-ui';
import { FolderPlus, Search } from 'lucide-react';
import { Logo } from './Logo';
import type { Project } from './vanguard-output';

export function Rail({
  projects,
  activePath,
  onSelect,
  onHome,
  onAdd,
  onCommandK,
  theme,
  onToggleTheme,
}: {
  projects: Project[];
  activePath: string | null;
  onSelect: (p: { path: string; name: string }) => void;
  onHome: () => void;
  onAdd: () => void;
  onCommandK: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/20">
      <button onClick={onHome} className="flex items-center gap-2 px-4 py-3 text-left">
        <Logo className="size-5 text-primary" />
        <span className="font-semibold">Vanguard</span>
      </button>

      <button
        onClick={onCommandK}
        className="mx-2 mb-1 flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        <Search className="size-3.5" />
        Search
        <span className="ml-auto font-mono">⌘K</span>
      </button>

      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Projects</span>
        <button onClick={onAdd} aria-label="Add project" className="text-muted-foreground hover:text-foreground">
          <FolderPlus className="size-4" />
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-auto px-2 py-1">
        {projects.map((p) => (
          <button
            key={p.path}
            onClick={() => onSelect({ path: p.path, name: p.name })}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
              p.path === activePath ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <span className="truncate">{p.name}</span>
            {p.runningCount > 0 && (
              <span
                className="ml-auto size-2 shrink-0 animate-pulse rounded-full bg-green-500"
                title={`${p.runningCount} running`}
              />
            )}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">{projects.length} projects</span>
        <ThemeToggle theme={theme} onClick={onToggleTheme} />
      </div>
    </aside>
  );
}
