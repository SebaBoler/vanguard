import { useRef, useState } from 'react';
import { cn } from 'chunks-ui';

/**
 * Click-to-edit text (task-page dogfood r3): renders as plain text; a click swaps in an input.
 * Enter/blur commits the TRIMMED value through `onCommit`, Escape cancels. The caller decides
 * what an empty commit means (clear vs no-op). `disabled` renders static text — used for
 * archived drafts, where every rename affordance must die.
 */
export function InlineEdit({
  value,
  placeholder,
  ariaLabel,
  onCommit,
  disabled = false,
  className,
}: {
  value: string;
  /** Shown (muted) when value is empty. Also the click target — an empty value stays editable. */
  placeholder: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Escape must beat the blur some browsers fire when the focused input unmounts (PR #351 r1):
  // that blur runs the OLD render's onBlur closure, which would commit the value Escape just
  // discarded. jsdom cannot reproduce the sequence, so this guard is untestable there — reset in
  // the next edit's click so one Escape can't poison a later commit.
  const escaped = useRef(false);

  if (disabled) {
    return <span className={cn('truncate', className)}>{value !== '' ? value : placeholder}</span>;
  }
  if (editing === null) {
    return (
      <button
        aria-label={ariaLabel}
        title="Click to rename"
        onClick={() => {
          escaped.current = false;
          setEditing(value);
        }}
        className={cn('truncate text-left decoration-dotted underline-offset-4 hover:underline', className)}
      >
        {value !== '' ? value : <span className="text-muted-foreground">{placeholder}</span>}
      </button>
    );
  }
  const commit = (): void => {
    if (escaped.current) return;
    onCommit(editing.trim());
    setEditing(null);
  };
  return (
    <input
      aria-label={`${ariaLabel} input`}
      autoFocus
      value={editing}
      placeholder={placeholder}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          escaped.current = true;
          setEditing(null);
        }
      }}
      className={cn('min-w-32 border-b border-primary bg-transparent outline-none', className)}
    />
  );
}
