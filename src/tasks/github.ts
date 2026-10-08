import { execa } from 'execa';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

export interface GitHubLabel {
  name: string;
}

export interface GitHubCommentAuthor {
  login: string;
}

export interface GitHubComment {
  author: GitHubCommentAuthor | null; // gh returns null for deleted accounts; justifies optional chaining in toTask()
  body: string;
  createdAt: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: GitHubLabel[];
  comments?: GitHubComment[];
  /** Present only when list() requests it (S9 board). */
  state?: string;
}

/** Runs a `gh` subcommand and returns its stdout. Injected so unit tests never call real gh. */
export type GhRunner = (args: string[]) => Promise<string>;

export const defaultGhRunner: GhRunner = async (args: string[]): Promise<string> => (await execa('gh', args)).stdout;

/** Strips an optional `owner/repo#` prefix, returning just the numeric part. */
export function issueNumber(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

export function toTask(repo: string, issue: GitHubIssue): Task {
  const comments: TaskComment[] = (issue.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? '',
    body: comment.body ?? '',
  }));
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    children: [], // the gh issue mapping does not fetch sub-issues
    comments,
    ref: String(issue.number),
    ...(issue.state !== undefined ? { state: issue.state } : {}),
  };
}

/** Fetches GitHub issues (via the gh CLI) and maps them to Vanguard tasks. */
export class GitHubTaskFetcher implements TaskFetcher {
  constructor(
    private readonly repo: string,
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const number = issueNumber(id);
    const out = await this.gh(['issue', 'view', number, '--repo', this.repo, '--json', 'number,title,body,labels,comments']);
    return toTask(this.repo, JSON.parse(out) as GitHubIssue);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    // comments are not fetched on bulk list() (avoids N+1); only fetch() returns them.
    // `state` joins --json ONLY when a limit is set (the board call): keeping the unset-limit argv
    // byte-identical protects watch's fetch shape (S9 — conditional by contract, test-pinned).
    const fields = filter?.limit !== undefined ? 'number,title,body,labels,state' : 'number,title,body,labels';
    const args = ['issue', 'list', '--repo', this.repo, '--json', fields, '--state', filter?.state ?? 'open'];
    if (filter?.limit !== undefined) args.push('-L', String(filter.limit));
    if (filter?.labels !== undefined && filter.labels.length > 0) args.push('--label', filter.labels.join(','));
    const out = await this.gh(args);
    return (JSON.parse(out) as GitHubIssue[]).map((issue) => toTask(this.repo, issue));
  }
}

/** Comment a PR link back onto the source GitHub issue (closes the loop). */
export async function commentGithubIssue(
  repo: string,
  issueRef: string,
  body: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await gh(['issue', 'comment', issueNumber(issueRef), '--repo', repo, '--body', body]);
}

export async function linkPullRequest(
  repo: string,
  issueRef: string,
  prUrl: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await commentGithubIssue(repo, issueRef, `Vanguard opened a PR for review: ${prUrl}`, gh);
}

/**
 * Best-effort: ensure a label exists and add it to a PR (used to flag failed proofs for triage).
 * Both steps swallow errors — labeling a draft PR must never block the run.
 */
export async function addPrFailureLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  try {
    await execa('gh', ['label', 'create', label, '--force'], { cwd: repoPath });
  } catch { /* best-effort */ }
  try {
    await execa('gh', ['pr', 'edit', prUrl, '--add-label', label], { cwd: repoPath });
  } catch { /* best-effort */ }
}

/** Add/remove labels on a GitHub issue (used to claim/advance it in the watch loop). */
export async function editGithubLabels(
  repo: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const args = ['issue', 'edit', issueNumber(issueRef), '--repo', repo];
  for (const label of labels.add ?? []) args.push('--add-label', label);
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  if (args.length > 4) await gh(args);
}
