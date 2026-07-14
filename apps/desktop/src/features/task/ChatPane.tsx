import { useState } from 'react';
import { Button, Textarea } from '@/ui';
import { ChatMessage } from './ChatMessage.js';
import type { DocChatState } from './useDocChat.js';

/** Drawer conversation panel: transcript + composer (textarea, model selector, Send) + accept/
 * reject bar when a proposal is pending. `disabled` freezes input entirely (archived drafts, S10)
 * while keeping the transcript. */
export function ChatPane({
  state,
  disabled = false,
  model,
  modelOptions,
  defaultModel,
  onModelChange,
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
  onModelChange: (model: string | undefined) => void;
  onSend: (text: string) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [draft, setDraft] = useState('');
  const send = (): void => {
    const text = draft.trim();
    if (text === '' || state.busy || disabled) return;
    onSend(text);
    setDraft('');
  };
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={disabled ? 'This draft is read-only.' : 'Plan, scope, or refine this draft…'}
          rows={2}
          className="w-full border-0 shadow-none focus-visible:ring-0"
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
          <Button onClick={send} disabled={state.busy || disabled || draft.trim() === ''}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
