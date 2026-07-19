// Limits + transports come from the generated wire contract (S7 — no more hand-mirrors). They are
// UX guards here: the sidecar enforces the real limits independently; refusing locally means the
// user is told BEFORE committing to an irreversible click, rather than after.
import { MAX_BODY_BYTES, MAX_TITLE_BYTES, TRANSPORTS } from '../../wire';
export { MAX_BODY_BYTES, MAX_TITLE_BYTES, TRANSPORTS };

/** The dialog promises "Create a task on <source>" — never promise a transport the sidecar rejects. */
export function isTransport(s: string | undefined): boolean {
  return s !== undefined && (TRANSPORTS as readonly string[]).includes(s);
}

/**
 * The doc's title: its first `# ` heading.
 *
 * Returns undefined when there isn't one — the caller must REFUSE rather than invent a title (falling
 * back to the filename, or the first line, would create a real, un-deletable issue named `note-3.md`).
 * Pure so it can be tested without a DOM; CodeMirror cannot be driven under jsdom.
 */
/**
 * Rewrite the doc's title in place: replace the first `# ` heading line (the same one
 * `titleFromDoc` reads — fences skipped), or prepend one when the doc has none. An empty title is
 * a no-op: the caller must never delete the heading through a rename affordance. Line endings are
 * normalized to LF (the in-app editor produces LF; only a hand-made CRLF file would notice).
 */
export function retitleDoc(doc: string, title: string): string {
  const t = title.trim();
  if (t === '') return doc;
  const lines = doc.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // Same target as titleFromDoc, including its skip of whitespace-only headings (PR #351 r1):
    // rewriting `#   ` while the reader takes the next real `# ` line would leave two H1s.
    const m = line.match(/^#[ \t]+(.+)$/);
    if (m?.[1] !== undefined && m[1].trim().replace(/\s#+$/, '').trim() !== '') {
      lines[i] = `# ${t}`;
      return lines.join('\n');
    }
  }
  return doc === '' ? `# ${t}\n` : `# ${t}\n\n${lines.join('\n')}`;
}

export function titleFromDoc(doc: string): string | undefined {
  let fenced = false;
  // Split on CRLF too. `doc.split('\n')` leaves a trailing `\r`, and `.` does not match `\r`, so
  // `(.+)$` below would never match on a CRLF document — every heading missed, Create task silently
  // disabled on a doc that plainly has one.
  for (const line of doc.split(/\r?\n/)) {
    // A ``` fence toggles code. `# install deps` inside a shell snippet is a comment, not the doc's
    // heading — taking it would file a real, un-deletable issue under a name the user never wrote.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = line.match(/^#[ \t]+(.+)$/);
    if (m?.[1] === undefined) continue;
    // A closed-ATX heading's closer is a `#`-run PRECEDED BY WHITESPACE (`# Title #`). A `#` that is not
    // space-separated is content: `# Support C#` is about C#, and stripping every trailing hash filed the
    // issue as "Support C" — corrupting the one thing the user cannot undo. Strip the closer only.
    //
    // One anchored `\s#+$` replace, not a lazy-group regex: `/^#\s+(.*?)\s*#*\s*$/` backtracks
    // quadratically on `#` + 60KB of spaces, and this runs on every render, before the size gate.
    const title = m[1].trim().replace(/\s#+$/, '').trim();
    if (title !== '') return title;
  }
  return undefined;
}
