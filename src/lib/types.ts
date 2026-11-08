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

/*
 * Category identity. One rule, used everywhere a category is compared:
 * two names are the same category when they match after invisible marks are
 * removed, Unicode is normalised, runs of spaces are collapsed and letter case
 * is ignored. "Research", "research" and "מחקר" + a right-to-left mark copied
 * from WhatsApp are each one category, not two.
 */

/**
 * Marks that never show but make two names differ: direction marks and
 * embeddings, zero-width spaces, the word joiner and the byte-order mark.
 */
const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
/** Zero-width (non-)joiners shape letters and emoji inside a name, so only stray ones at the ends go. */
const EDGE_JOINERS = /^[\u200C\u200D\s]+|[\u200C\u200D\s]+$/g;

/** A name with invisible marks removed and Unicode normalised; spacing inside is kept. */
function cleanCategoryText(raw: string): string {
  return raw.replace(INVISIBLE, '').normalize('NFC').replace(EDGE_JOINERS, '');
}

/** What two names are compared by. Equal keys mean the same category. */
export function categoryKey(name: string): string {
  return cleanCategoryText(name).replace(/\s+/g, ' ').toLowerCase();
}

export function sameCategory(a: string, b: string): boolean {
  return categoryKey(a) === categoryKey(b);
}

/** The built-in a name means in any letter case or marking, if any. */
function builtInFor(name: string): BuiltInCategory | undefined {
  const key = categoryKey(name);
  return BUILT_IN_CATEGORIES.find((c) => c.toLowerCase() === key);
}

/**
 * Clean a category name typed in the app (or given by Gemini), or reject it.
 * Invisible marks go and whitespace is collapsed; commas are refused because
 * Notion select options cannot contain them; and a built-in in any letter case
 * becomes that built-in, so "work" never turns into a second Work.
 */
export function normalizeCategoryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = cleanCategoryText(raw).replace(/\s+/g, ' ');
  if (!name || name.length > MAX_CATEGORY_LENGTH || name.includes(',')) return null;
  return builtInFor(name) ?? name;
}

/**
 * A category name read back from where tasks are kept (Notion, or a list
 * learned from tasks). Any non-empty name is kept as it is stored — the
 * length and comma rules are for names typed here — so a long name made in
 * Notion is shown and written back unchanged, not read as Inbox. Only
 * invisible marks and spaces at the ends go, and a built-in in other casing
 * is the built-in.
 */
export function readCategoryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = cleanCategoryText(raw);
  if (!name) return null;
  return builtInFor(name) ?? name;
}

/** A usable category name — built in or custom. */
export function isCategory(value: unknown): value is Category {
  return readCategoryName(value) !== null;
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}
