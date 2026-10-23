import type { Task, TaskComment } from './fetcher.js';

/** GitHub CommentAuthorAssociation values that imply write-ish standing in the repo. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface TrustOptions {
  /** Issue/PR author login (Task.author). Trusted for spec/tech-spec/manifest inputs. */
  issueAuthor?: string | undefined;
  /** Explicit allowlist (--feedback-authors; the workflow's allowed-actors). Case-insensitive. */
  allowedAuthors?: readonly string[] | undefined;
  /** Extra bot logins, as ActionableOptions.botLogins today. */
  botLogins?: readonly string[] | undefined;
}

export type AuthorTrust = 'association' | 'allowed' | 'issue-author' | 'bot' | 'untrusted';

/** Shared bot recognition. A login merely containing "vanguard" must never grant trust. */
export function isBotLogin(login: string, extraBotLogins?: readonly string[]): boolean {
  const lower = login.toLowerCase();
  return (
    lower === 'vanguard' ||
    lower.endsWith('[bot]') ||
    lower === 'github-actions' ||
    (extraBotLogins ?? []).some((b) => lower === b.toLowerCase())
  );
}

/** Bot check first (so Vanguard's own comments classify as 'bot', never 'association'). */
export function classifyAuthor(author: string, association: string | undefined, opts: TrustOptions = {}): AuthorTrust {
  if (isBotLogin(author, opts.botLogins)) return 'bot';
  const lowerAuthor = author.toLowerCase();
  if ((opts.allowedAuthors ?? []).some((a) => a.toLowerCase() === lowerAuthor)) return 'allowed';
  if (association !== undefined && TRUSTED_ASSOCIATIONS.has(association.trim().toUpperCase())) return 'association';
  if (opts.issueAuthor !== undefined && opts.issueAuthor.toLowerCase() === lowerAuthor) return 'issue-author';
  return 'untrusted';
}

/** true for every classification except 'untrusted' — i.e. the SPEC/marker trust set (bot included). */
export function isTrustedComment(comment: TaskComment, opts: TrustOptions = {}): boolean {
  return classifyAuthor(comment.author, comment.authorAssociation, opts) !== 'untrusted';
}

/** task.comments filtered by isTrustedComment; issueAuthor defaults to task.author. */
export function trustedComments(task: Task, opts: TrustOptions = {}): TaskComment[] {
  const trust: TrustOptions = { ...opts, issueAuthor: opts.issueAuthor ?? task.author };
  return task.comments.filter((comment) => isTrustedComment(comment, trust));
}

/** Bodies of trustedComments joined with '\n' — the replacement for the ad-hoc joins. */
export function trustedSpecText(task: Task, opts: TrustOptions = {}): string {
  return trustedComments(task, opts).map((comment) => comment.body).join('\n');
}

/** Short render for summaries/logs: `@mallory (NONE)`; association '' renders as `(none)`. */
export function describeIgnoredAuthor(author: string, association?: string): string {
  const label = association === undefined || association === '' ? 'none' : association;
  return `@${author} (${label})`;
}
