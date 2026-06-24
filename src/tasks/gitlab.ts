import { execa } from 'execa';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

export interface GitLabNote {
  id: number;
  body: string;
  author: { username: string };
  system: boolean;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
}

/** Runs a `glab` subcommand and returns its stdout. Injected so unit tests never call real glab. */
export type GlabRunner = (args: string[]) => Promise<string>;

export const defaultGlabRunner: GlabRunner = async (args: string[]): Promise<string> =>
  (await execa('glab', args)).stdout;

/** Strips an optional `group/project#` prefix, returning just the numeric IID part. */
export function issueIID(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

/** URL-encodes a GitLab project path for use in `glab api` calls (slashes → %2F). */
export function encodeProject(project: string): string {
  return project.replace(/\//g, '%2F');
}

function toGitLabTask(project: string, issue: GitLabIssue, notes: GitLabNote[] = []): Task {
  const comments: TaskComment[] = notes
    .filter((n) => !n.system)
    .map((n) => ({ author: n.author.username, body: n.body }));
  return {
    id: `${project}#${issue.iid}`,
    title: issue.title,
    description: issue.description ?? '',
    labels: issue.labels,
    children: [],
    comments,
  };
}

/** Fetches GitLab issues (via the glab CLI) and maps them to Vanguard tasks. */
export class GitLabTaskFetcher implements TaskFetcher {
  constructor(
    private readonly project: string,
    private readonly glab: GlabRunner = defaultGlabRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const iid = issueIID(id);
    const issueOut = await this.glab(['issue', 'view', iid, '--repo', this.project, '--output', 'json']);
    const issue = JSON.parse(issueOut) as GitLabIssue;
    // notes fetched separately — glab issue view does not include them
    const notesOut = await this.glab(['api', `projects/${encodeProject(this.project)}/issues/${iid}/notes?per_page=100`]);
    const notes = JSON.parse(notesOut) as GitLabNote[];
    return toGitLabTask(this.project, issue, notes);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const args = [
      'issue', 'list',
      '--repo', this.project,
      '--output', 'json',
      '--state', filter?.state ?? 'opened',
    ];
    for (const label of filter?.labels ?? []) args.push('--label', label);
    const out = await this.glab(args);
    // comments are not fetched on bulk list() — avoids N+1; only fetch() returns them
    return (JSON.parse(out) as GitLabIssue[]).map((issue) => toGitLabTask(this.project, issue));
  }
}

/** Post a note on a GitLab issue. */
export async function commentGitlabIssue(
  project: string,
  issueRef: string,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await glab(['issue', 'note', 'create', issueIID(issueRef), '--repo', project, '-m', body]);
}

/** Comment an MR link back onto the source GitLab issue (closes the loop). */
export async function linkMergeRequest(
  project: string,
  issueRef: string,
  mrUrl: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await commentGitlabIssue(project, issueRef, `Vanguard opened an MR for review: ${mrUrl}`, glab);
}

/** Add/remove labels on a GitLab issue (used to claim/advance it in the watch loop). */
export async function editGitlabLabels(
  project: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  const args = ['issue', 'update', issueIID(issueRef), '--repo', project];
  for (const label of labels.add ?? []) args.push('--label', label);
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  if (args.length > 5) await glab(args);
}
