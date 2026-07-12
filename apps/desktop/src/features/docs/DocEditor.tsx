import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';

/** CodeMirror 6 markdown editor. Read-only while a chat proposal is pending (so an edit can't be
 * silently discarded by accept). */
export function DocEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="h-full overflow-auto" data-testid="doc-editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        extensions={[markdown()]}
        height="100%"
        basicSetup={{ lineNumbers: false, foldGutter: false }}
      />
    </div>
  );
}
