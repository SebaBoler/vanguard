import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Home, FolderPlus, FolderGit2, SunMoon } from 'lucide-react';
import type { Project } from './vanguard-output';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({
  projects,
  onOpenProject,
  onHome,
  onAddProject,
  onToggleTheme,
  onClose,
}: {
  projects: Project[];
  onOpenProject: (p: { path: string; name: string }) => void;
  onHome: () => void;
  onAddProject: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cmds = useMemo<Cmd[]>(
    () => [
      { id: 'home', label: 'All projects', icon: <Home className="size-4" />, run: onHome },
      { id: 'add', label: 'Add project', icon: <FolderPlus className="size-4" />, run: onAddProject },
      { id: 'theme', label: 'Toggle theme', icon: <SunMoon className="size-4" />, run: onToggleTheme },
      ...projects.map((p) => ({
        id: `p:${p.path}`,
        label: `Open ${p.name}`,
        hint: p.path,
        icon: <FolderGit2 className="size-4" />,
        run: () => onOpenProject({ path: p.path, name: p.name }),
      })),
    ],
    [projects, onHome, onAddProject, onToggleTheme, onOpenProject],
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds;
    return cmds.filter((c) => c.label.toLowerCase().includes(s) || c.hint?.toLowerCase().includes(s));
  }, [cmds, q]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  const exec = (c?: Cmd): void => {
    if (c) {
      c.run();
      onClose();
    }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      exec(filtered[sel]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search projects & actions…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div className="max-h-80 overflow-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setSel(i)}
                onClick={() => exec(c)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${
                  i === sel ? 'bg-muted' : 'hover:bg-muted/60'
                }`}
              >
                <span className="text-muted-foreground">{c.icon}</span>
                <span>{c.label}</span>
                {c.hint && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
