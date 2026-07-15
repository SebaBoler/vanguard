import { useMemo, useSyncExternalStore } from 'react';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { vscodeLight, vscodeDark } from '@uiw/codemirror-theme-vscode';

// System coding fonts with ligature support — nothing bundled, graceful fallback to Menlo/monospace.
const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, monospace";

// Track the app theme live: App.tsx toggles the `dark` class on <html>. We subscribe to that class
// so the editor re-themes in place while mounted (no remount).
function subscribeToClass(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

function useAppDark(): boolean {
  return useSyncExternalStore(subscribeToClass, () =>
    document.documentElement.classList.contains('dark'),
  );
}

// VSCode-style chrome layered over the base theme: monospace/ligature font, a subtle border that
// changes color on focus (no dotted outline), an active-line highlight, and thin scrollbars.
function uiTheme(dark: boolean): Extension {
  const border = dark ? '#3c3c3c' : '#d4d4d4';
  const focusBorder = dark ? '#007fd4' : '#0090f1';
  const activeLine = dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';
  const thumb = dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
  const thumbHover = dark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
  return EditorView.theme(
    {
      '&': {
        border: `1px solid ${border}`,
        borderRadius: '4px',
        fontFamily: FONT,
      },
      '&.cm-focused': {
        outline: 'none',
        borderColor: focusBorder,
      },
      '.cm-content': {
        fontFamily: FONT,
        fontVariantLigatures: 'contextual',
      },
      '.cm-activeLine': {
        backgroundColor: activeLine,
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
  const extensions = useMemo(() => [markdown(), uiTheme(dark)], [dark]);
  return (
    <div className="h-full overflow-auto" data-testid="doc-editor" data-theme={dark ? 'dark' : 'light'}>
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
  );
}
