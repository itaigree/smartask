import {
  BUILT_IN_CATEGORIES, categoryKey, readCategoryName, type Category, type Task,
} from './types.ts';

/**
 * The user's category list: the built-ins, then their own.
 *
 * Their own ones come from two places, merged: names they created on this
 * device (kept in local storage), and names found on their tasks — which is how
 * a category made on another phone, or added straight in Notion, shows up here.
 *
 * Names are compared by `categoryKey` (letter case and invisible marks
 * ignored). Where the saved list and the tasks spell one category differently,
 * the tasks' spelling wins: it is what the store holds, so it is also what the
 * next task filed there should get.
 */

const STORAGE_KEY = 'smartask.categories.v1';

/** Custom names only, one per category, in the order given; the first spelling wins. */
function uniqueCustom(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = readCategoryName(item);
    if (!name || !isCustomCategory(name) || seen.has(categoryKey(name))) continue;
    seen.add(categoryKey(name));
    out.push(name);
  }
  return out;
}

/** Built-ins in their usual order (Inbox last), then custom names A to Z. */
export function categoryList(custom: readonly string[], tasks: readonly Task[] = []): Category[] {
  const builtIns = BUILT_IN_CATEGORIES.filter((c) => c !== 'Inbox');
  const extra = uniqueCustom([...tasks.map((t) => t.category), ...custom]);
  extra.sort((a, b) => a.localeCompare(b));
  return [...builtIns, ...extra, 'Inbox'];
}

/**
 * The saved list brought up to date with the tasks: a saved name takes the
 * spelling the tasks use, a second spelling of one category is dropped, and
 * custom names found only on tasks are added. Null when nothing changed, so
 * there is nothing to save.
 */
export function learnCategories(custom: readonly string[], tasks: readonly Task[]): string[] | null {
  const onTasks = new Map(uniqueCustom(tasks.map((t) => t.category)).map((n) => [categoryKey(n), n]));
  const next = uniqueCustom([...custom, ...onTasks.values()])
    .map((name) => onTasks.get(categoryKey(name)) ?? name);

  const unchanged = next.length === custom.length && next.every((name, i) => name === custom[i]);
  return unchanged ? null : next;
}

/** How many titles stand for one category, and how much of each is kept. */
const EXAMPLES_PER_CATEGORY = 3;
const EXAMPLE_LENGTH = 60;

/**
 * A few task titles from each of the user's own categories, keyed by
 * `categoryKey` — shown to Gemini so it can judge whether a new task belongs
 * with what a category already holds, not only with its name. The first ones
 * in the list are taken (the stores list newest first); built-in categories
 * are described in the prompt already and get none.
 */
export function categoryExamples(tasks: readonly Task[]): Map<string, string[]> {
  const examples = new Map<string, string[]>();
  for (const task of tasks) {
    if (!isCustomCategory(task.category)) continue;
    const key = categoryKey(task.category);
    const list = examples.get(key) ?? [];
    const title = task.title.replace(/\s+/g, ' ').trim();
    if (!title || list.length >= EXAMPLES_PER_CATEGORY || list.includes(title)) continue;
    list.push(title.length > EXAMPLE_LENGTH ? `${title.slice(0, EXAMPLE_LENGTH - 1)}…` : title);
    examples.set(key, list);
  }
  return examples;
}

export function isCustomCategory(name: string): boolean {
  const key = categoryKey(name);
  return !BUILT_IN_CATEGORIES.some((c) => categoryKey(c) === key);
}

export function loadCustomCategories(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    // Names learned from tasks may be longer than a typed one, so the
    // lenient read rule applies here, not the rule for typed names.
    return Array.isArray(parsed) ? uniqueCustom(parsed) : [];
  } catch {
    return [];
  }
}

export function saveCustomCategories(names: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // The list is re-learned from tasks, so a failed save loses nothing that matters.
  }
}

/**
 * A stable hue for a custom category, so "Research" is the same colour on
 * every card and every device without anyone choosing one.
 */
export function categoryHue(name: string): number {
  let hash = 0;
  for (const ch of categoryKey(name)) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
}
