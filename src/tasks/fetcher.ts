export interface Task {
  id: string;
  title: string;
  description: string;
  labels: string[];
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
    TITLE: task.title,
    DESCRIPTION: task.description,
    LABELS: task.labels.join(', '),
  };
}
