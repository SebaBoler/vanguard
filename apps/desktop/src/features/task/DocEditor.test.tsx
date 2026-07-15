import { test, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { DocEditor } from './DocEditor.js';

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

// Render-only smoke: CodeMirror 6 drives input through contenteditable + DOM measurement, which
// jsdom doesn't reproduce, so we do NOT simulate typing (feasibility #2). We assert it mounts.
test('mounts with a value without throwing', () => {
  render(<DocEditor value={'# Hello\n'} onChange={() => {}} />);
  expect(screen.getByTestId('doc-editor')).toBeInTheDocument();
});

test('mounts read-only without throwing', () => {
  render(<DocEditor value={'x'} onChange={() => {}} readOnly />);
  expect(screen.getByTestId('doc-editor')).toBeInTheDocument();
});

// theme-follows-app: the editor picks vscodeDark when <html> has the `dark` class and vscodeLight
// otherwise, and switches live (via a MutationObserver) without a remount. data-theme reflects the
// same signal that selects the CodeMirror theme, so asserting it proves the theme follows the app.
test('theme follows the app dark class, switching live', async () => {
  document.documentElement.classList.remove('dark');
  render(<DocEditor value={'# Hello\n'} onChange={() => {}} />);
  const editor = screen.getByTestId('doc-editor');
  expect(editor).toHaveAttribute('data-theme', 'light');

  await act(async () => {
    document.documentElement.classList.add('dark');
    // let the MutationObserver microtask run
    await Promise.resolve();
  });
  expect(editor).toHaveAttribute('data-theme', 'dark');

  await act(async () => {
    document.documentElement.classList.remove('dark');
    await Promise.resolve();
  });
  expect(editor).toHaveAttribute('data-theme', 'light');
});

// status-bar-cursor: the bottom status bar shows the live cursor position. We move the selection by
// dispatching on the underlying EditorView (found via the mounted DOM) and assert the bar's Ln/Col
// text tracks it. Markdown/UTF-8 labels are static and asserted on mount.
test('status bar reflects cursor position changes', () => {
  render(<DocEditor value={'line one\nsecond line\n'} onChange={() => {}} />);

  const bar = screen.getByTestId('doc-statusbar');
  expect(bar).toHaveTextContent('Markdown');
  expect(bar).toHaveTextContent('UTF-8');
  expect(screen.getByTestId('doc-cursor')).toHaveTextContent('Ln 1, Col 1');

  const view = viewOf();
  expect(view).toBeTruthy();

  // 'line one\n' spans offsets 0..8 ('\n' at 8); offset 11 sits on line 2, third column.
  act(() => {
    view.dispatch({ selection: { anchor: 11 } });
  });
  expect(screen.getByTestId('doc-cursor')).toHaveTextContent('Ln 2, Col 3');

  act(() => {
    view.dispatch({ selection: { anchor: 0 } });
  });
  expect(screen.getByTestId('doc-cursor')).toHaveTextContent('Ln 1, Col 1');
});

// Dispatch a keydown on the focused editor's content DOM — the path a CM6 keymap actually handles,
// which also proves the binding is scoped to the editor (no-global-shadowing).
function pressKey(view: EditorView, init: KeyboardEventInit): void {
  act(() => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function viewOf(): EditorView {
  const dom = screen.getByTestId('doc-editor').querySelector('.cm-editor') as HTMLElement;
  return EditorView.findFromDOM(dom)!;
}

// select-next-occurrence: with the first "foo" selected, Cmd/Ctrl+D (VSCode keymap) adds a second
// selection over the next "foo" — the multi-cursor "select next match" gesture.
test('Ctrl+D extends selection to the next occurrence', () => {
  render(<DocEditor value={'foo bar foo baz\n'} onChange={() => {}} />);
  const view = viewOf();

  // Select the first "foo" (offsets 0..3).
  act(() => {
    view.dispatch({ selection: { anchor: 0, head: 3 } });
  });
  expect(view.state.selection.ranges).toHaveLength(1);

  pressKey(view, { key: 'd', code: 'KeyD', keyCode: 68, ctrlKey: true });

  const ranges = view.state.selection.ranges.map((r) => [r.from, r.to]);
  expect(ranges).toHaveLength(2);
  // The second "foo" spans offsets 8..11.
  expect(ranges).toContainEqual([8, 11]);
});

// multi-cursor: Alt+Click adds a cursor (VSCode's modifier). jsdom can't run CM6's coordinate-based
// mouse selection, so we assert the wired modifier directly: clickAddsSelectionRange returns true for
// Alt and false for the CM6 default (Cmd/Ctrl), proving the gesture matches VSCode.
test('Alt is the add-a-cursor click modifier', () => {
  render(<DocEditor value={'foo bar foo baz\n'} onChange={() => {}} />);
  const addsRange = viewOf().state.facet(EditorView.clickAddsSelectionRange)[0];
  expect(addsRange({ altKey: true } as MouseEvent)).toBe(true);
  expect(addsRange({ altKey: false, ctrlKey: true, metaKey: true } as MouseEvent)).toBe(false);
});

// move-line: Alt+Up (VSCode keymap) swaps the active line with the one above it.
test('Alt+Up moves the active line up', () => {
  render(<DocEditor value={'line one\nsecond line\n'} onChange={() => {}} />);
  const view = viewOf();

  // Put the cursor on line 2 (offset 11 sits inside "second line").
  act(() => {
    view.dispatch({ selection: { anchor: 11 } });
  });

  pressKey(view, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, altKey: true });

  expect(view.state.doc.toString()).toBe('second line\nline one\n');
});
