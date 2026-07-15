import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, {
  EditorSelection,
  EditorView,
  Prec,
  keymap,
  placeholder as cmPlaceholder,
  type Extension,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { vscodeLight, vscodeDark } from '@uiw/codemirror-theme-vscode';
import { Button } from '@/ui';
import { ChatMessage } from './ChatMessage.js';
import { EDITOR_FONT, useAppDark } from './cmEditor.js';
import { lastUserIndex, type DocChatState } from './useDocChat.js';

// Borderless composer chrome layered over the vscode base theme: the surrounding box already draws
// the border/padding, so the editor itself is transparent. Wraps long lines, starts one line high,
// and grows up to ~8 lines (max-h-44 = 11rem) before scrolling internally.
function composerTheme(dark: boolean): Extension {
  const thumb = dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
  return EditorView.theme(
    {
      '&': { backgroundColor: 'transparent', fontFamily: EDITOR_FONT },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: EDITOR_FONT,
        maxHeight: '11rem',
        scrollbarWidth: 'thin',
        scrollbarColor: `${thumb} transparent`,
      },
      '.cm-content': { fontFamily: EDITOR_FONT, fontVariantLigatures: 'contextual', padding: '2px 0' },
      '.cm-scroller::-webkit-scrollbar': { width: '8px' },
      '.cm-scroller::-webkit-scrollbar-thumb': { backgroundColor: thumb, borderRadius: '4px' },
    },
    { dark },
  );
}

// Toggle a wrapping mark (**, *, `) around every selection range: wrap a bare selection, and unwrap
// when the mark already surrounds it — whether the marks sit just inside the selection or just
// outside it. An empty selection becomes `mark|mark`, leaving the caret ready to type.
function toggleMark(mark: string): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const { from, to } = range;
      const inner = state.sliceDoc(from, to);
      const wrappedInside =
        inner.length >= 2 * mark.length && inner.startsWith(mark) && inner.endsWith(mark);
      const before = state.sliceDoc(Math.max(0, from - mark.length), from);
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + mark.length));
      const wrappedOutside = before === mark && after === mark;

      if (wrappedInside) {
        const stripped = inner.slice(mark.length, inner.length - mark.length);
        return {
          changes: { from, to, insert: stripped },
          range: EditorSelection.range(from, from + stripped.length),
        };
      }
      if (wrappedOutside) {
        return {
          changes: [
            { from: from - mark.length, to: from, insert: '' },
            { from: to, to: to + mark.length, insert: '' },
          ],
          range: EditorSelection.range(from - mark.length, to - mark.length),
        };
      }
      return {
        changes: [
          { from, insert: mark },
          { from: to, insert: mark },
        ],
        range: EditorSelection.range(from + mark.length, to + mark.length),
      };
    });
    view.dispatch(state.update(tr, { userEvent: 'input.wrap', scrollIntoView: true }));
    return true;
  };
}

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
  onStop,
  onEditLast,
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
  /** Kill the in-flight turn (Stop button). The owner discards the partial exchange and keeps the text. */
  onStop: () => void;
  /** Edit & regenerate: truncate the last exchange and load the last user message into the composer. */
  onEditLast: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const dark = useAppDark();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const send = (): void => {
    const text = composerText.trim();
    if (text === '' || state.busy || disabled) return;
    onSend(text);
  };

  // The CM keymap fires from CodeMirror's own keydown handling, which is created once. Route it
  // through refs so the commands always see the latest props without reconfiguring the editor.
  const sendRef = useRef(send);
  sendRef.current = send;
  const recallRef = useRef<() => boolean>(() => false);
  recallRef.current = (): boolean => {
    // Up-arrow in an EMPTY composer recalls the last sent message for editing (single step); a
    // non-empty composer lets the arrow fall through to an ordinary caret move.
    if (composerText !== '') return false;
    const idx = lastUserIndex(state.messages);
    if (idx === -1) return false;
    onComposerChange(state.messages[idx]!.content);
    return true;
  };

  // Enter sends; Shift+Enter inserts a newline; Cmd/Ctrl+B/I/E toggle markdown wrapping; ArrowUp
  // recalls in an empty composer. Highest precedence so these win over CM defaults. Rebuilt only
  // when the theme flips (commands read live props through refs, so they never go stale).
  const extensions = useMemo<Extension[]>(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      composerTheme(dark),
      cmPlaceholder(disabled ? 'This draft is read-only.' : 'Plan, scope, or refine this draft…'),
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            run: () => {
              sendRef.current();
              return true;
            },
          },
          {
            key: 'Shift-Enter',
            run: (view) => {
              view.dispatch({ ...view.state.replaceSelection('\n'), scrollIntoView: true, userEvent: 'input' });
              return true;
            },
          },
          { key: 'ArrowUp', run: () => recallRef.current() },
          { key: 'Mod-b', run: toggleMark('**'), preventDefault: true },
          { key: 'Mod-i', run: toggleMark('*'), preventDefault: true },
          { key: 'Mod-e', run: toggleMark('`'), preventDefault: true },
        ]),
      ),
    ],
    [dark, disabled],
  );

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
    if (!disabled) cmRef.current?.view?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disabled is read, not a trigger
  }, [focusSignal]);

  // The edit affordance sits on the LAST user message only, and only when the composer is free to
  // take over (not mid-turn, not read-only) — a regenerate IS a fresh send.
  const editable = !state.busy && !disabled ? lastUserIndex(state.messages) : -1;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex-1 space-y-2 overflow-auto">
        {state.messages.map((m, i) => (
          <ChatMessage key={i} msg={m} onEdit={i === editable ? onEditLast : undefined} />
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
      <div className="rounded border border-border p-2" data-testid="chat-composer">
        <CodeMirror
          ref={cmRef}
          value={composerText}
          onChange={onComposerChange}
          editable={!disabled}
          readOnly={disabled}
          theme={dark ? vscodeDark : vscodeLight}
          extensions={extensions}
          // No gutters/line numbers; auto-grows from one line (capped by composerTheme's maxHeight).
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            autocompletion: false,
          }}
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
          {state.busy ? (
            // Stop replaces Send while a turn is in flight — it never depends on the composer text
            // (that's the retry buffer), only on there being something to stop.
            <Button color="secondary" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button onClick={send} disabled={disabled || composerText.trim() === ''}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
