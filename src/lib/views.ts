import { PRIORITY_WEIGHT, type Category, type Task } from './types.ts';
import { toISODate, addDays, localDateOf } from './parse.ts';

/**
 * The "smart" half of the app: turning a flat task list into views worth
 * looking at. Pure and clock-injected (PLAN.md decision 4).
 */

export const VIEWS = ['focus', 'today', 'upcoming', 'categories', 'done'] as const;
export type ViewId = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<ViewId, string> = {
  focus: 'Focus',
  today: 'Today',
  upcoming: 'Upcoming',
  categories: 'All',
  done: 'Done',
};

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

export interface ViewResult {
  id: ViewId;
  groups: TaskGroup[];
  /** Shown when the view has nothing in it. */
  emptyMessage: string;
}

export const FOCUS_SIZE = 5;
const DONE_WINDOW_DAYS = 14;
const UPCOMING_WINDOW_DAYS = 7;

export function isOpen(task: Task): boolean {
  return task.status !== 'Done';
}

/** Whole days from today to `due`. Negative means overdue. Null when undated. */
export function daysUntilDue(task: Task, now: Date): number | null {
  const day = localDateOf(task.due);
  if (!day) return null;
  const today = new Date(toISODate(now) + 'T00:00:00');
  const due = new Date(day + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

export function isOverdue(task: Task, now: Date): boolean {
  const d = daysUntilDue(task, now);
  return isOpen(task) && d !== null && d < 0;
}

export function isDueToday(task: Task, now: Date): boolean {
  return daysUntilDue(task, now) === 0;
}

/**
 * How loudly a task should be asking for attention.
 *
 *   priority (0–40) + urgency (0–30) + age (0–10, capped)
 *
 * Urgency is deliberately steep: an overdue Low task should outrank a Normal
 * task due next week, because the overdue one is already a broken promise.
 */
export function focusScore(task: Task, now: Date): number {
  let score = PRIORITY_WEIGHT[task.priority] * 10;

  const days = daysUntilDue(task, now);
  if (days !== null) {
    if (days < 0) score += 30 + Math.min(10, -days); // overdue, worse every day
    else if (days === 0) score += 25;
    else if (days === 1) score += 18;
    else if (days <= 3) score += 12;
    else if (days <= 7) score += 6;
    else score += 2;
  }

  const ageDays = (now.getTime() - new Date(task.createdAt).getTime()) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > 0) score += Math.min(10, ageDays * 0.5);

  if (task.status === 'Doing') score += 8; // already started: finish it

  return Math.round(score * 100) / 100;
}

/** Highest score first; undated tasks sink below dated ones at equal score. */
export function byFocus(now: Date) {
  return (a: Task, b: Task): number => {
    const diff = focusScore(b, now) - focusScore(a, now);
    if (diff !== 0) return diff;
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return a.title.localeCompare(b.title);
  };
}

function humanDay(iso: string, now: Date): string {
  const label = new Date(iso + 'T00:00:00');
  const offset = Math.round(
    (label.getTime() - new Date(toISODate(now) + 'T00:00:00').getTime()) / 86_400_000,
  );
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return label.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

/** Category order for the "All" view: the ones you act on first. */
const CATEGORY_ORDER: Category[] = [
  'Work', 'Finance', 'Health', 'Errands', 'Home', 'Learning', 'Personal', 'Inbox',
];

export function buildView(id: ViewId, tasks: Task[], now: Date = new Date()): ViewResult {
  const open = tasks.filter(isOpen);
  const sort = byFocus(now);

  switch (id) {
    case 'focus': {
      const picked = [...open].sort(sort).slice(0, FOCUS_SIZE);
      return {
        id,
        groups: picked.length ? [{ key: 'focus', label: `Top ${picked.length}`, tasks: picked }] : [],
        emptyMessage: 'Nothing open. Add a task above.',
      };
    }

    case 'today': {
      const overdue = open.filter((t) => isOverdue(t, now)).sort(sort);
      const today = open.filter((t) => isDueToday(t, now)).sort(sort);
      const groups: TaskGroup[] = [];
      if (overdue.length) groups.push({ key: 'overdue', label: 'Overdue', tasks: overdue });
      if (today.length) groups.push({ key: 'today', label: 'Today', tasks: today });
      return { id, groups, emptyMessage: 'Nothing due today. Enjoy it.' };
    }

    case 'upcoming': {
      const horizon = toISODate(addDays(now, UPCOMING_WINDOW_DAYS));
      const todayIso = toISODate(now);
      // Grouped by calendar day, even if a due date somehow still carries a time.
      const day = (t: Task) => localDateOf(t.due);
      const dated = open
        .filter((t) => {
          const d = day(t);
          return d !== null && d > todayIso && d <= horizon;
        })
        .sort((a, b) => (day(a)! < day(b)! ? -1 : day(a)! > day(b)! ? 1 : sort(a, b)));

      const byDay = new Map<string, Task[]>();
      for (const t of dated) {
        const list = byDay.get(day(t)!) ?? [];
        list.push(t);
        byDay.set(day(t)!, list);
      }
      const groups: TaskGroup[] = [...byDay].map(([iso, list]) => ({
        key: iso,
        label: humanDay(iso, now),
        tasks: list,
      }));

      const undated = open.filter((t) => !t.due).sort(sort);
      if (undated.length) groups.push({ key: 'undated', label: 'No date', tasks: undated });

      return { id, groups, emptyMessage: 'Nothing scheduled for the next week.' };
    }

    case 'categories': {
      // Built-ins in their usual order, then the user's own categories A-Z,
      // with Inbox last — so a new category gets its own group, not lost.
      const custom = [...new Set(open.map((t) => t.category))]
        .filter((c) => !CATEGORY_ORDER.includes(c))
        .sort((a, b) => a.localeCompare(b));
      const order = [...CATEGORY_ORDER.filter((c) => c !== 'Inbox'), ...custom, 'Inbox'];

      const groups: TaskGroup[] = [];
      for (const category of order) {
        const list = open.filter((t) => t.category === category).sort(sort);
        if (list.length) groups.push({ key: category, label: category, tasks: list });
      }
      return { id, groups, emptyMessage: 'No open tasks.' };
    }

    case 'done': {
      const cutoff = toISODate(addDays(now, -DONE_WINDOW_DAYS));
      const done = tasks
        .filter((t) => t.status === 'Done')
        .filter((t) => !t.completedAt || t.completedAt.slice(0, 10) >= cutoff)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
      return {
        id,
        groups: done.length ? [{ key: 'done', label: `Last ${DONE_WINDOW_DAYS} days`, tasks: done }] : [],
        emptyMessage: 'Nothing completed recently.',
      };
    }
  }
}

export interface Counts {
  open: number;
  overdue: number;
  today: number;
  done: number;
}

/** Badge numbers for the tab bar. */
export function countTasks(tasks: Task[], now: Date = new Date()): Counts {
  const open = tasks.filter(isOpen);
  return {
    open: open.length,
    overdue: open.filter((t) => isOverdue(t, now)).length,
    today: open.filter((t) => isDueToday(t, now) || isOverdue(t, now)).length,
    done: tasks.filter((t) => t.status === 'Done').length,
  };
}
