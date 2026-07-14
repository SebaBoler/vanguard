import { deleteDraft, readDraft, writeDraft } from '../../ipc.js';
import { titleFromDoc } from './docTask.js';
import type { ChatMsg } from './useDocChat.js';

/**
 * The draft model (S10): one JSON file per draft under `.vanguard/drafts/<id>.json` — body, chat
 * transcript, and meta together, so a filed draft's re-file protection and its transcript can
 * never diverge. The webview owns this shape; Rust is dumb storage.
 */
export interface DraftData {
  body: string;
  chat: ChatMsg[];
  archived: boolean;
  /** Present once filed (⇒ archived). */
  created?: { id: string; url: string };
  updatedAt: string;
}

export const emptyDraft = (): DraftData => ({ body: '', chat: [], archived: false, updatedAt: '' });

/** `draft-<ts36>-<6 random hex>` — the entropy suffix kills same-millisecond cross-window collisions. */
export function mintDraftId(): string {
  return `draft-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

/**
 * Parse a draft file. `undefined` ⇒ the draft renders as unreadable: visible, delete-only, never
 * silently dropped. A parseable file with a non-http(s) `created.url` is REJECTED the same way —
 * drafts can arrive committed inside a cloned repo, and a `javascript:` URL must never reach the
 * link chip.
 */
export function parseDraft(raw: string): DraftData | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.body !== 'string' || !Array.isArray(o.chat)) return undefined;
  const chat: ChatMsg[] = [];
  for (const m of o.chat) {
    const msg = m as Record<string, unknown>;
    if ((msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.content !== 'string') return undefined;
    chat.push({ role: msg.role, content: msg.content });
  }
  let created: DraftData['created'];
  if (o.created !== undefined && o.created !== null) {
    const c = o.created as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > 200 || typeof c.url !== 'string') return undefined;
    if (!/^https?:\/\//.test(c.url)) return undefined;
    created = { id: c.id, url: c.url };
  }
  return {
    body: o.body,
    chat,
    // created ⇒ archived (review #349 r6): a hand-edited file must not present an enabled
    // Create-task on a draft that already carries a filed-issue link — that fails toward re-file.
    archived: o.archived === true || created !== undefined,
    ...(created !== undefined ? { created } : {}),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  };
}

/** Sidebar name: heading → first user chat message → "Untitled" (chat-first drafts must stay distinguishable). */
export function draftLabel(d: DraftData): string {
  const title = titleFromDoc(d.body);
  if (title !== undefined) return title;
  const firstUser = d.chat.find((m) => m.role === 'user')?.content.trim();
  if (firstUser !== undefined && firstUser !== '') {
    return firstUser.length > 60 ? `${firstUser.slice(0, 60)}…` : firstUser;
  }
  return 'Untitled';
}

/**
 * Per-draft persistence with the S10 write-ordering invariants:
 *
 * - Writes are serialized per draft id through a promise chain — a stale write can never land
 *   after (and clobber) a newer one; the whole-JSON model makes any inversion total (it would
 *   flip `archived` back and erase `created`).
 * - Writes carry DATA SNAPSHOTS, never thunks over shared component state (review #349 r2
 *   blocking): a `get()` that runs in a later microtask reads whatever the ref points at THEN —
 *   a draft switch inside the debounce window repointed it, and the flushed write serialized the
 *   incoming draft's state into the outgoing draft's file. A snapshot cannot alias; re-arming on
 *   every keystroke keeps it the latest state anyway.
 * - The debounce coalesces body keystrokes ONLY; everything else (chat turns, archive flips,
 *   created-link writes) goes through `writeNow`/`update` immediately. `writeNow` supersedes the
 *   armed debounce for its id — its snapshot is strictly newer, and letting the timer fire after
 *   it would land the older body last.
 * - `deleteNow` discards the pending timer and queues behind any in-flight write of the same id,
 *   so the delete always wins and the file cannot resurrect.
 * - Persistence is keyed by draft id, not by selection: `update` read-modify-writes a draft that
 *   is no longer open (late chat reply, create success after a switch).
 *
 * One instance per project; the instance captures `repoPath`, so a flush racing a project switch
 * still targets the repo it was armed for.
 */
export class DraftWriter {
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingData = new Map<string, DraftData>();
  private inFlight = 0;

  constructor(
    private repoPath: string,
    private onError: (message: string) => void,
    private debounceMs = 800,
  ) {}

  /** Resolves `true` when the op succeeded — never rejects, so a failed write can't break the chain. */
  private enqueue(id: string, op: () => Promise<void>): Promise<boolean> {
    this.inFlight++;
    const chain = (this.chains.get(id) ?? Promise.resolve())
      .then(async () => {
        await op();
        return true;
      })
      .catch((err: unknown) => {
        this.onError(`save failed: ${String(err)}`);
        return false;
      })
      .finally(() => {
        this.inFlight--;
      });
    this.chains.set(id, chain);
    // Prune the settled tail so the map doesn't retain one entry per draft ever touched.
    void chain.then(() => {
      if (this.chains.get(id) === chain) this.chains.delete(id);
    });
    return chain;
  }

  private stamp(d: DraftData): string {
    return JSON.stringify({ ...d, updatedAt: new Date().toISOString() });
  }

  /** Immediate write of a snapshot. Supersedes any armed debounce for this id (see class doc). */
  writeNow(id: string, data: DraftData): Promise<boolean> {
    this.discard(id);
    return this.enqueue(id, () => writeDraft(this.repoPath, id, this.stamp(data)));
  }

  /** Debounced write for body keystrokes. Re-arming replaces both the timer and the snapshot. */
  schedule(id: string, data: DraftData): void {
    const existing = this.timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    // Defensive copy: even a call site that forgets to snapshot cannot alias live state in here.
    this.pendingData.set(id, { ...data });
    this.timers.set(
      id,
      setTimeout(() => {
        this.fire(id);
      }, this.debounceMs),
    );
  }

  private fire(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
    const data = this.pendingData.get(id);
    this.pendingData.delete(id);
    if (data !== undefined) void this.enqueue(id, () => writeDraft(this.repoPath, id, this.stamp(data)));
  }

  /** Drop a pending debounce without writing (delete path). */
  discard(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
    this.pendingData.delete(id);
  }

  /** Fire any armed debounce now and wait for every queued write to settle. */
  flush(): Promise<void> {
    for (const id of [...this.timers.keys()]) this.fire(id);
    return Promise.all([...this.chains.values()]).then(() => undefined);
  }

  /**
   * Read-modify-write keyed by id — for events that must persist regardless of what's open now
   * (create success after a switch, a late chat reply). A missing or unreadable file is SKIPPED,
   * not recreated: an id-keyed append must never resurrect a draft the user deleted. The caller
   * can tell the outcomes apart (review #349 r4): 'skipped' is a deliberate delete, not a failed
   * archive — only 'failed' warrants the do-not-re-file warning.
   */
  update(id: string, mutate: (d: DraftData) => DraftData): Promise<'written' | 'skipped' | 'failed'> {
    let wrote = false;
    return this.enqueue(id, async () => {
      const raw = await readDraft(this.repoPath, id).catch(() => undefined);
      const current = raw !== undefined ? parseDraft(raw) : undefined;
      if (current === undefined) return;
      await writeDraft(this.repoPath, id, this.stamp(mutate(current)));
      wrote = true;
    }).then((ok) => (ok ? (wrote ? 'written' : 'skipped') : 'failed'));
  }

  /** Cancel the draft's pending save and delete its file; queued after in-flight writes, so it wins. */
  deleteNow(id: string): Promise<boolean> {
    this.discard(id);
    return this.enqueue(id, () => deleteDraft(this.repoPath, id));
  }

  /** True while a debounce is armed or a write is in flight — drives the close-flush guard. */
  dirty(): boolean {
    return this.timers.size > 0 || this.inFlight > 0;
  }
}
