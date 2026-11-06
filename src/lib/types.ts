/**
 * The categories every install starts with. The keyword rules, Gemini's
 * descriptions and the colour palette know these by name.
 */
export const BUILT_IN_CATEGORIES = [
  'Work',
  'Personal',
  'Errands',
  'Health',
  'Finance',
  'Learning',
  'Home',
  'Inbox',
] as const;
export type BuiltInCategory = (typeof BUILT_IN_CATEGORIES)[number];

/** Kept as an alias: most callers mean "the built-in set". */
export const CATEGORIES = BUILT_IN_CATEGORIES;

/**
 * Any category name — built in, or one the user created. A plain string,
 * validated by {@link normalizeCategoryName}.
 */
export type Category = string;

export const MAX_CATEGORY_LENGTH = 40;

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

export function isBuiltInCategory(value: unknown): value is BuiltInCategory {
  return typeof value === 'string' && (BUILT_IN_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Clean a category name, or reject it. Whitespace is collapsed; commas are
 * refused because Notion select options cannot contain them; and a name that
 * matches a built-in in any letter case becomes that built-in, so "work" never
 * turns into a second Work.
 */
export function normalizeCategoryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_CATEGORY_LENGTH || name.includes(',')) return null;
  const builtIn = BUILT_IN_CATEGORIES.find((c) => c.toLowerCase() === name.toLowerCase());
  return builtIn ?? name;
}

/** A usable category name — built in or custom. */
export function isCategory(value: unknown): value is Category {
  return normalizeCategoryName(value) !== null;
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}
