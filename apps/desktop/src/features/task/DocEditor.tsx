import { useMemo, useState } from 'react';
import CodeMirror, {
  crosshairCursor,
  Decoration,
  EditorState,
  EditorView,
  keymap,
  Prec,
  RangeSetBuilder,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
  type Extension,
  type ViewUpdate,
} from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { vscodeLight, vscodeDark } from '@uiw/codemirror-theme-vscode';
import { vscodeKeymap } from '@replit/codemirror-vscode-keymap';
import { EDITOR_FONT, useAppDark } from './cmEditor.js';

// Visual columns between indent guides. Guides are drawn in `ch` units, so the monospace EDITOR_FONT
// keeps them aligned with the text.
const TAB = 2;

// Leading-whitespace width of a line in visual columns (tabs snap to the next TAB stop).
function indentColumns(text: string): number {
  let cols = 0;
  for (const ch of text) {
    if (ch === ' ') cols += 1;
    else if (ch === '\t') cols += TAB - (cols % TAB);
    else break;
  }
  return cols;
}

// VSCode-style indent guides: a line decoration on every indented line carrying its indentation
// width as `--cm-indent-cols`. The theme (uiTheme) turns that into repeating vertical rules via a
// background gradient clipped to the indentation region — no per-column DOM nodes.
function buildIndentGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const cols = indentColumns(line.text);
      if (cols >= TAB) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: { class: 'cm-indentGuides', style: `--cm-indent-cols:${cols}` },
          }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildIndentGuides(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = buildIndentGuides(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Editor interaction: multiple selections + the VSCode default keymap. Multi-cursor gestures come
// from CM6 primitives — Alt+Click adds a cursor (clickAddsSelectionRange, VSCode's default modifier
// rather than CM6's Cmd/Ctrl default), Alt+drag makes a rectangular selection (rectangularSelection)
// with a crosshair cursor showing the modifier is armed — and `allowMultipleSelections` lets those
// ranges edit simultaneously. The VSCode keymap layers muscle-memory bindings (Cmd/Ctrl+D select
// next match, Alt+Up/Down move line, Shift+Alt+Up/Down copy line, Cmd/Ctrl+/ toggle comment,
// Cmd/Ctrl+Shift+K delete line) at highest precedence so they win over basicSetup's defaults. A CM6
// keymap only handles keydown on the focused editor's content DOM, so nothing here shadows app-level
// shortcuts outside the editor.
const editorInteraction: Extension = [
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of((e) => e.altKey),
  rectangularSelection(),
  crosshairCursor(),
  Prec.highest(keymap.of(vscodeKeymap)),
];

// VSCode-style chrome layered over the base theme: monospace/ligature font, a subtle border that
// changes color on focus (no dotted outline), an active-line highlight, indent guides, matched
// brackets, and thin scrollbars.
function uiTheme(dark: boolean): Extension {
  const border = dark ? '#3c3c3c' : '#d4d4d4';
  const focusBorder = dark ? '#007fd4' : '#0090f1';
  const activeLine = dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';
  const guide = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.14)';
  const matchBg = dark ? 'rgba(0, 127, 212, 0.3)' : 'rgba(0, 144, 241, 0.2)';
  const matchBorder = dark ? '#5a9bd4' : '#0090f1';
  const thumb = dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
  const thumbHover = dark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
  return EditorView.theme(
    {
      '&': {
        border: `1px solid ${border}`,
        borderRadius: '4px',
        fontFamily: EDITOR_FONT,
      },
      '&.cm-focused': {
        outline: 'none',
        borderColor: focusBorder,
      },
      '.cm-content': {
        fontFamily: EDITOR_FONT,
        fontVariantLigatures: 'contextual',
      },
      '.cm-activeLine': {
        backgroundColor: activeLine,
      },
      '.cm-indentGuides': {
        backgroundImage: `repeating-linear-gradient(to right, ${guide} 0, ${guide} 1px, transparent 1px, transparent ${TAB}ch)`,
        backgroundSize: 'calc(var(--cm-indent-cols) * 1ch) 100%',
        backgroundRepeat: 'no-repeat',
      },
      '.cm-matchingBracket': {
        backgroundColor: matchBg,
        outline: `1px solid ${matchBorder}`,
        borderRadius: '2px',
      },
      '.cm-nonmatchingBracket': {
        color: dark ? '#f48771' : '#e51400',
      },
      '.cm-scroller': {
        scrollbarWidth: 'thin',
        scrollbarColor: `${thumb} transparent`,
      },
      '.cm-scroller::-webkit-scrollbar': {
        width: '8px',
        height: '8px',
      },
      '.cm-scroller::-webkit-scrollbar-track': {
        backgroundColor: 'transparent',
      },
      '.cm-scroller::-webkit-scrollbar-thumb': {
        backgroundColor: thumb,
        borderRadius: '4px',
      },
      '.cm-scroller::-webkit-scrollbar-thumb:hover': {
        backgroundColor: thumbHover,
      },
    },
    { dark },
  );
}

/** Slim bar pinned to the editor's bottom edge: live cursor position plus static language/encoding
 * labels. Fed by a CM updateListener via React state — no React is rendered inside CodeMirror. */
function StatusBar({ line, col }: { line: number; col: number }) {
  return (
    <div
      data-testid="doc-statusbar"
      className="flex items-center gap-4 border-t border-neutral-200 bg-neutral-50 px-3 py-0.5 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400"
    >
      <span data-testid="doc-cursor" className="tabular-nums">
        Ln {line}, Col {col}
      </span>
      <span className="ml-auto">Markdown</span>
      <span>UTF-8</span>
    </div>
  );
}

/** CodeMirror 6 markdown editor. Read-only while a chat proposal is pending (so an edit can't be
 * silently discarded by accept). Follows the app theme (VSCode light/dark) live. */
export function DocEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  const dark = useAppDark();
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const extensions = useMemo(
    () => [
      markdown(),
      editorInteraction,
      indentGuides,
      uiTheme(dark),
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return;
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        setCursor({ line: line.number, col: head - line.from + 1 });
      }),
    ],
    [dark],
  );
  return (
    <div
      className="flex h-full flex-col"
      data-testid="doc-editor"
      data-theme={dark ? 'dark' : 'light'}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          theme={dark ? vscodeDark : vscodeLight}
          extensions={extensions}
          height="100%"
          basicSetup={{ lineNumbers: false, foldGutter: false }}
        />
      </div>
      <StatusBar {...cursor} />
    </div>
  );
}
