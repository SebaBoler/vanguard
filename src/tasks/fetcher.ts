import { escapePromptTags } from '../context/escape.js';

/** A child (sub-issue) of a task; identifier and title only (sub-issues carry no body in list shape). */
export interface SubTask {
  id: string;
  title: string;
}

export interface TaskComment {
  author: string;
  body: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  labels: string[];
  children: SubTask[];
  comments: TaskComment[];
  /** Provider-native short ref (`904`, `42`, `DEV-639`) — the board id mint's input (S9). Never in prompts. */
  ref?: string;
  /** Provider lifecycle state (`open`/`closed`/`opened`/Linear state name) — the board's column input (S9). */
  state?: string;
}

export interface TaskFilter {
  labels?: string[];
  state?: string;
  /**
   * Page/result cap (S9, board parity). STRICTLY conditional: unset ⇒ every fetcher's argv and
   * GraphQL variables are byte-identical to before this field existed — watch never sets it, and
   * its fetch size must not change. Set ⇒ gh -L / glab -P / Linear first: + single-page stop.
   */
  limit?: number;
}

/**
 * Source of work items. Impl: LinearCliTaskFetcher (the `linear` CLI; auth via
 * `linear auth login` or LINEAR_API_KEY) mapping an issue to prompt variables via taskToVariables().
 */
export interface TaskFetcher {
  fetch: (id: string) => Promise<Task>;
  list: (filter?: TaskFilter) => Promise<Task[]>;
}

/** Map a fetched task to prompt-engine {{KEY}} variables. */
export function taskToVariables(task: Task): Record<string, string> {
  return {
    TITLE: escapePromptTags(task.title),
    DESCRIPTION: escapePromptTags(task.description),
    LABELS: task.labels.map((label) => escapePromptTags(label)).join(', '),
    SUBTASKS: task.children.map((child) => escapePromptTags(`${child.id} ${child.title}`)).join('\n'),
    COMMENTS: escapePromptTags(task.comments.map((comment) => `${comment.author}: ${comment.body}`).join('\n')),
  };
}
