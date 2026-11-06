import { BUILT_IN_CATEGORIES, normalizeCategoryName, type Category, type Task } from './types.ts';

/**
 * The user's category list: the built-ins, then their own.
 *
 * Their own ones come from two places, merged: names they created on this
 * device (kept in local storage), and names found on their tasks — which is how
 * a category made on another phone, or added straight in Notion, shows up here.
 */

const STORAGE_KEY = 'smartask.categories.v1';

/** Built-ins in their usual order (Inbox last), then custom names A to Z. */
export function categoryList(custom: readonly string[], tasks: readonly Task[] = []): Category[] {
  const builtIns = BUILT_IN_CATEGORIES.filter((c) => c !== 'Inbox');
  const seen = new Set<string>(BUILT_IN_CATEGORIES.map((c) => c.toLowerCase()));
  const extra: string[] = [];

  for (const raw of [...custom, ...tasks.map((t) => t.category)]) {
    const name = normalizeCategoryName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    extra.push(name);
  }

  extra.sort((a, b) => a.localeCompare(b));
  return [...builtIns, ...extra, 'Inbox'];
}

/** Custom names on tasks that the saved list does not know yet. */
export function unseenCategories(custom: readonly string[], tasks: readonly Task[]): string[] {
  const known = new Set(categoryList(custom).map((c) => c.toLowerCase()));
  const found: string[] = [];
  for (const task of tasks) {
    const name = normalizeCategoryName(task.category);
    if (name && !known.has(name.toLowerCase())) {
      known.add(name.toLowerCase());
      found.push(name);
    }
  }
  return found;
}

export function isCustomCategory(name: string): boolean {
  return !BUILT_IN_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase());
}

export function loadCustomCategories(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCategoryName)
      .filter((n): n is string => n !== null && isCustomCategory(n));
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
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
}
