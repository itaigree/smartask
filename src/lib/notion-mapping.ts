import {
  CATEGORIES, PRIORITIES, STATUSES,
  normalizeCategoryName, isPriority, isStatus,
  type NewTask, type Task, type TaskPatch,
} from './types.ts';

/**
 * The Notion page <-> Task mapping, with no SDK import, so it stays pure and
 * directly testable (PLAN.md decision 4). All network access lives in notion.ts.
 */

/** Property names in the Notion database. The setup script creates exactly these. */
export const PROPS = {
  title: 'Name',
  category: 'Category',
  priority: 'Priority',
  status: 'Status',
  due: 'Due',
  project: 'Project',
  tags: 'Tags',
  note: 'Note',
  completedAt: 'Completed',
} as const;

/** The schema `databases.create` is given, and what the app expects to find. */
export const SCHEMA = {
  [PROPS.title]: { title: {} },
  [PROPS.category]: { select: { options: CATEGORIES.map((name) => ({ name })) } },
  [PROPS.priority]: { select: { options: PRIORITIES.map((name) => ({ name })) } },
  [PROPS.status]: { select: { options: STATUSES.map((name) => ({ name })) } },
  [PROPS.due]: { date: {} },
  [PROPS.project]: { rich_text: {} },
  [PROPS.tags]: { multi_select: { options: [] } },
  [PROPS.note]: { rich_text: {} },
  [PROPS.completedAt]: { date: {} },
} as const;

/* ------------------------------------------------------------------ *
 * Reading: Notion page -> Task
 * ------------------------------------------------------------------ */

type Props = Record<string, unknown>;

function prop(props: Props, name: string): Record<string, unknown> | null {
  const value = props[name];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readTitle(props: Props, name: string): string {
  const p = prop(props, name);
  const parts = p?.title;
  if (!Array.isArray(parts)) return '';
  return parts.map((r: { plain_text?: string }) => r.plain_text ?? '').join('').trim();
}

function readRichText(props: Props, name: string): string | null {
  const p = prop(props, name);
  const parts = p?.rich_text;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((r: { plain_text?: string }) => r.plain_text ?? '').join('').trim();
  return text || null;
}

function readSelect(props: Props, name: string): string | null {
  const p = prop(props, name);
  const select = p?.select;
  if (!select || typeof select !== 'object') return null;
  const value = (select as { name?: string }).name;
  return value ?? null;
}

function readDate(props: Props, name: string): string | null {
  const p = prop(props, name);
  const date = p?.date;
  if (!date || typeof date !== 'object') return null;
  return (date as { start?: string }).start ?? null;
}

function readMultiSelect(props: Props, name: string): string[] {
  const p = prop(props, name);
  const items = p?.multi_select;
  if (!Array.isArray(items)) return [];
  return items
    .map((i: { name?: string }) => i.name)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Map a Notion page to a Task. Anything unexpected in the page falls back to a
 * sane default rather than throwing — a task hand-edited in Notion (decision 2)
 * must never break the whole list.
 */
export function pageToTask(page: unknown): Task | null {
  const p = page as {
    id?: string;
    object?: string;
    properties?: Props;
    created_time?: string;
    url?: string;
    in_trash?: boolean;
    archived?: boolean;
  };
  if (!p?.id || p.object !== 'page' || !p.properties) return null;
  if (p.in_trash || p.archived) return null;

  const props = p.properties;
  const category = readSelect(props, PROPS.category);
  const priority = readSelect(props, PROPS.priority);
  const status = readSelect(props, PROPS.status);

  return {
    id: p.id,
    title: readTitle(props, PROPS.title) || 'Untitled task',
    // A category added in the app, or straight in Notion, is kept as is.
    category: normalizeCategoryName(category) ?? 'Inbox',
    priority: isPriority(priority) ? priority : 'Normal',
    status: isStatus(status) ? status : 'Todo',
    due: readDate(props, PROPS.due),
    project: readRichText(props, PROPS.project),
    tags: readMultiSelect(props, PROPS.tags),
    note: readRichText(props, PROPS.note),
    createdAt: p.created_time ?? new Date().toISOString(),
    completedAt: readDate(props, PROPS.completedAt),
    url: p.url ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Writing: Task -> Notion properties
 * ------------------------------------------------------------------ */

const richText = (text: string) => [{ type: 'text' as const, text: { content: text } }];

/** Build the Notion property payload for a new page. */
export function newTaskToProperties(task: NewTask): Record<string, unknown> {
  return {
    [PROPS.title]: { title: richText(task.title) },
    [PROPS.category]: { select: { name: task.category } },
    [PROPS.priority]: { select: { name: task.priority } },
    [PROPS.status]: { select: { name: task.status } },
    [PROPS.due]: { date: task.due ? { start: task.due } : null },
    [PROPS.project]: { rich_text: task.project ? richText(task.project) : [] },
    [PROPS.tags]: { multi_select: task.tags.map((name) => ({ name })) },
    [PROPS.note]: { rich_text: task.note ? richText(task.note) : [] },
  };
}

/**
 * Build the property payload for a patch. Only the keys actually present in the
 * patch are sent, so a partial update never blanks a field edited in Notion.
 * Completing a task stamps `Completed`; reopening one clears it.
 */
export function patchToProperties(patch: TaskPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.title !== undefined) out[PROPS.title] = { title: richText(patch.title) };
  if (patch.category !== undefined) out[PROPS.category] = { select: { name: patch.category } };
  if (patch.priority !== undefined) out[PROPS.priority] = { select: { name: patch.priority } };
  if (patch.due !== undefined) out[PROPS.due] = { date: patch.due ? { start: patch.due } : null };
  if (patch.project !== undefined) {
    out[PROPS.project] = { rich_text: patch.project ? richText(patch.project) : [] };
  }
  if (patch.tags !== undefined) {
    out[PROPS.tags] = { multi_select: patch.tags.map((name) => ({ name })) };
  }
  if (patch.note !== undefined) {
    out[PROPS.note] = { rich_text: patch.note ? richText(patch.note) : [] };
  }
  if (patch.status !== undefined) {
    out[PROPS.status] = { select: { name: patch.status } };
    out[PROPS.completedAt] = patch.status === 'Done'
      ? { date: { start: new Date().toISOString().slice(0, 10) } }
      : { date: null };
  }
  return out;
}
