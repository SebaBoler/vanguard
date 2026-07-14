import { useState } from 'react';
import { Button, Textarea } from '@/ui';
import { ChatMessage } from './ChatMessage.js';
import type { DocChatState } from './useDocChat.js';

/** Sidebar chat: transcript + input + (when a proposal is pending) an accept/reject bar.
 * `disabled` freezes input entirely (archived/unreadable drafts, S10) while keeping the transcript. */
export function ChatPane({
  state,
  disabled = false,
  onSend,
  onAccept,
  onReject,
}: {
  state: DocChatState;
  disabled?: boolean;
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
      <div className="flex gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={disabled ? 'This draft is read-only.' : 'Ask for a plan…'}
          rows={2}
          className="flex-1"
          disabled={disabled}
        />
        <Button onClick={send} disabled={state.busy || disabled}>
          Send
        </Button>
      </div>
    </div>
  );
}
