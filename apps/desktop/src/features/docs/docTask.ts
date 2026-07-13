/**
 * The doc's title: its first `# ` heading.
 *
 * Returns undefined when there isn't one — the caller must REFUSE rather than invent a title (falling
 * back to the filename, or the first line, would create a real, un-deletable issue named `note-3.md`).
 * Pure so it can be tested without a DOM; CodeMirror cannot be driven under jsdom.
 */
export function titleFromDoc(doc: string): string | undefined {
  for (const line of doc.split('\n')) {
    const m = line.match(/^#\s+(.*\S)\s*$/);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}
