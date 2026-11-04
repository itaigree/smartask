export const CATEGORIES = [
  'Work',
  'Personal',
  'Errands',
  'Health',
  'Finance',
  'Learning',
  'Home',
  'Inbox',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = ['Todo', 'Doing', 'Done'] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITY_WEIGHT: Record<Priority, number> = {
  Urgent: 4,
  High: 3,
  Normal: 2,
  Low: 1,
};

export interface Task {
  id: string;
  title: string;
  category: Category;
  priority: Priority;
  status: Status;
  /** ISO calendar date, `YYYY-MM-DD`, or null when undated. */
  due: string | null;
  project: string | null;
  tags: string[];
  note: string | null;
  /** ISO datetime. */
  createdAt: string;
  completedAt: string | null;
  url: string | null;
}

/** What the app sends to the data layer when creating a task. */
export type NewTask = Omit<Task, 'id' | 'createdAt' | 'completedAt' | 'url'>;

/** The subset of a task the UI is allowed to change. */
export type TaskPatch = Partial<
  Pick<Task, 'title' | 'category' | 'priority' | 'status' | 'due' | 'project' | 'tags' | 'note'>
>;

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}
