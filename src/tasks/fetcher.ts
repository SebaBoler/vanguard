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
}

export interface TaskFilter {
  labels?: string[];
  state?: string;
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
    LABELS: task.labels.join(', '),
    SUBTASKS: task.children.map((child) => `${child.id} ${child.title}`).join('\n'),
    COMMENTS: escapePromptTags(task.comments.map((comment) => `${comment.author}: ${comment.body}`).join('\n')),
  };
}
