import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Button, Textarea } from '@/ui';
import { ChatMessage } from './ChatMessage.js';
import type { DocChatState } from './useDocChat.js';

/** Drawer conversation panel: transcript + composer (textarea, model selector, Send) + accept/
 * reject bar when a proposal is pending. `disabled` freezes input entirely (archived drafts, S10)
 * while keeping the transcript.
 *
 * The composer is CONTROLLED (`composerText`/`onComposerChange`) so its text can persist per
 * conversation across navigation and reload (Editor UX 4/7) — the owning screen writes it through
 * the debounced DraftWriter and re-seeds it on draft switch. */
export function ChatPane({
  state,
  disabled = false,
  model,
  modelOptions,
  defaultModel,
  composerText,
  focusSignal,
  onModelChange,
  onComposerChange,
  onSend,
  onAccept,
  onReject,
}: {
  state: DocChatState;
  disabled?: boolean;
  /** Per-conversation override; `undefined` ⇒ the app-wide default. */
  model: string | undefined;
  /** Distinct models found in the project's vanguard configuration. */
  modelOptions: string[];
  /** What "default" resolves to right now (shown in the selector). */
  defaultModel: string;
  /** Controlled composer value — the active conversation's unsent draft text. */
  composerText: string;
  /** Bumped by the owner when a reply lands in the ACTIVE conversation, to refocus the composer. */
  focusSignal?: number;
  onModelChange: (model: string | undefined) => void;
  onComposerChange: (text: string) => void;
  onSend: (text: string) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const send = (): void => {
    const text = composerText.trim();
    if (text === '' || state.busy || disabled) return;
    onSend(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter keeps the default (newline).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    // Up-arrow in an EMPTY composer recalls the last sent message for editing (single step).
    if (e.key === 'ArrowUp' && composerText === '') {
      const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
      if (lastUser !== undefined) {
        e.preventDefault();
        onComposerChange(lastUser.content);
      }
    }
  };

  // Refocus the composer once the active conversation's reply has landed. Guarded against the
  // initial render so opening the drawer doesn't steal focus; the owner only bumps the signal for
  // replies in the conversation the user is actually looking at (viewingRef semantics). Keyed on
  // focusSignal ALONE — reacting to `disabled` too would steal focus whenever a draft un-archives
  // or the user switches to an editable draft (review r1).
  const focusMounted = useRef(false);
  useEffect(() => {
    if (!focusMounted.current) {
      focusMounted.current = true;
      return;
    }
    if (!disabled) textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disabled is read, not a trigger
  }, [focusSignal]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex-1 space-y-2 overflow-auto">
        {state.messages.map((m, i) => (
          <ChatMessage key={i} msg={m} />
        ))}
        {state.busy && <p className="text-xs text-muted-foreground">thinking…</p>}
      </div>
      {state.error !== undefined && <p className="text-xs text-rose-500">{state.error}</p>}
      {state.pending !== undefined && (
        <div className="flex items-center gap-2 rounded border border-border bg-muted/20 p-2">
          <span className="text-xs text-muted-foreground">Proposed a doc revision.</span>
          <Button variant="text" onClick={onAccept} className="ml-auto">
            Accept
          </Button>
          <Button variant="text" color="secondary" onClick={onReject}>
            Reject
          </Button>
        </div>
      )}
      <div className="rounded border border-border p-2">
        <Textarea
          ref={textareaRef}
          value={composerText}
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'This draft is read-only.' : 'Plan, scope, or refine this draft…'}
          // Grows with content (field-sizing) up to ~8 lines, then scrolls internally — no fixed
          // scroll box.
          autoResize
          className="max-h-44 min-h-14 w-full resize-none overflow-y-auto border-0 shadow-none focus-visible:ring-0"
          disabled={disabled}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <select
            aria-label="chat model"
            value={model ?? ''}
            onChange={(e) => onModelChange(e.target.value === '' ? undefined : e.target.value)}
            disabled={disabled || state.busy}
            className="max-w-[60%] truncate bg-transparent font-mono text-xs text-muted-foreground outline-none"
          >
            <option value="">default · {defaultModel}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {model !== undefined && !modelOptions.includes(model) && (
              // A persisted override no longer in the config must stay visible (and used) — a
              // value-less <select> would silently RENDER "default" while sending the override.
              <option value={model}>{model}</option>
            )}
          </select>
          <Button onClick={send} disabled={state.busy || disabled || composerText.trim() === ''}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
