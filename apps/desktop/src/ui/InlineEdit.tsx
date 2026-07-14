import { useState } from 'react';
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

  if (disabled) {
    return <span className={cn('truncate', className)}>{value !== '' ? value : placeholder}</span>;
  }
  if (editing === null) {
    return (
      <button
        aria-label={ariaLabel}
        title="Click to rename"
        onClick={() => setEditing(value)}
        className={cn('truncate text-left decoration-dotted underline-offset-4 hover:underline', className)}
      >
        {value !== '' ? value : <span className="text-muted-foreground">{placeholder}</span>}
      </button>
    );
  }
  const commit = (): void => {
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
        if (e.key === 'Escape') setEditing(null);
      }}
      className={cn('min-w-32 border-b border-primary bg-transparent outline-none', className)}
    />
  );
}
