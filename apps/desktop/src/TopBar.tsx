import { Chip, ThemeToggle, type Theme } from 'chunks-ui';
import { Search } from 'lucide-react';
import { Logo } from './Logo';

export function TopBar({
  onCommandK,
  theme,
  onToggleTheme,
}: {
  onCommandK: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <Logo className="size-5 text-primary" />
      <span className="font-semibold">Vanguard</span>
      <Chip color="secondary" variant="outlined">Inspector</Chip>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onCommandK}
          className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          <Search className="size-3.5" />
          <span className="font-mono">⌘K</span>
        </button>
        <ThemeToggle theme={theme} onClick={onToggleTheme} />
      </div>
    </header>
  );
}
