import { captureDraft, ValidationError } from './capture.ts';
import { getCategorizer, type Categorizer } from './categorize/index.ts';
import { toISODate } from './parse.ts';
import type { CaptureResult, TaskRepository } from './tasks.ts';
import {
  isCategory, isPriority, isStatus,
  type NewTask, type Task, type TaskPatch,
} from './types.ts';

/**
 * Standalone storage: every task kept in this browser, no account, no sync.
 *
 * Implements the same TaskRepository the Notion store does, so the board,
 * capture, Gemini and voice work identically on top of either. The trade is
 * stated to the user wherever it matters: these tasks live on one device, in
 * one browser, and are only as safe as that browser's storage — hence the
 * backup and restore below.
 */

const TASKS_KEY = 'smartask.tasks.v1';
const BACKUP_FORMAT = 'smartask-backup';

/** The slice of localStorage this module needs, so tests can pass a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class LocalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStoreError';
  }
}

function browserStore(): KeyValueStore {
  if (typeof window === 'undefined') throw new LocalStoreError('No browser storage here.');
  return window.localStorage;
}

/**
 * Accept a stored task only if it has the shape the app relies on. Anything
 * malformed — a hand-edited backup, an old format — is dropped, never crashes.
 */
export function sanitizeStoredTask(raw: unknown): Task | null {
  const t = raw as Partial<Task> | null;
  if (!t || typeof t !== 'object') return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.title !== 'string' || !t.title.trim()) return null;

  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null);

  return {
    id: t.id,
    title: t.title,
    category: isCategory(t.category) ? t.category : 'Inbox',
    priority: isPriority(t.priority) ? t.priority : 'Normal',
    status: isStatus(t.status) ? t.status : 'Todo',
    due: date(t.due),
    project: typeof t.project === 'string' && t.project ? t.project : null,
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
    note: typeof t.note === 'string' && t.note ? t.note : null,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    completedAt: date(t.completedAt),
    url: null, // there is no page to open for a local task
  };
}

export function readTasks(store: KeyValueStore): Task[] {
  let raw: string | null;
  try {
    raw = store.getItem(TASKS_KEY);
  } catch {
    throw new LocalStoreError('This browser is not letting the app read its storage.');
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown[] };
    const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    return list.map(sanitizeStoredTask).filter((t): t is Task => t !== null);
  } catch {
    // Corrupt storage must not brick the app. Starting empty is recoverable
    // (restore a backup); a crash on every launch is not.
    return [];
  }
}

function writeTasks(store: KeyValueStore, tasks: Task[]): void {
  try {
    store.setItem(TASKS_KEY, JSON.stringify({ version: 1, tasks }));
  } catch {
    throw new LocalStoreError(
      'Could not save — this device is out of browser storage. Back up, then delete old tasks.',
    );
  }
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const byNewest = (a: Task, b: Task) => b.createdAt.localeCompare(a.createdAt);

export function createLocalRepository(
  categorizer: Categorizer = getCategorizer(),
  store: KeyValueStore = browserStore(),
): TaskRepository {
  async function createTask(draft: NewTask): Promise<Task> {
    const task: Task = {
      ...draft,
      id: newId(),
      createdAt: new Date().toISOString(),
      completedAt: null,
      url: null,
    };
    writeTasks(store, [task, ...readTasks(store)]);
    return task;
  }

  return {
    async listTasks() {
      return readTasks(store).sort(byNewest);
    },

    async captureTask(text, now = new Date()): Promise<CaptureResult> {
      const { draft, signal } = await captureDraft(text, now, categorizer);
      return { task: await createTask(draft), signal };
    },

    createTask,

    async updateTask(id: string, patch: TaskPatch) {
      if (Object.keys(patch).length === 0) throw new ValidationError('Nothing to update.');

      const tasks = readTasks(store);
      const index = tasks.findIndex((t) => t.id === id);
      if (index === -1) throw new LocalStoreError('That task no longer exists on this device.');

      const updated: Task = { ...tasks[index], ...patch };
      // Same rule as the Notion store: completing stamps the date, reopening clears it.
      if (patch.status !== undefined) {
        updated.completedAt = patch.status === 'Done' ? toISODate(new Date()) : null;
      }

      tasks[index] = updated;
      writeTasks(store, tasks);
      return updated;
    },

    /** Unlike Notion there is no trash: this is permanent, and the UI says so. */
    async archiveTask(id: string) {
      writeTasks(store, readTasks(store).filter((t) => t.id !== id));
    },
  };
}

export function countLocalTasks(store?: KeyValueStore): number {
  try {
    return readTasks(store ?? browserStore()).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Backup and restore
 * ------------------------------------------------------------------ */

export function exportBackup(store: KeyValueStore = browserStore(), now = new Date()): string {
  return JSON.stringify(
    { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), tasks: readTasks(store) },
    null,
    2,
  );
}

/**
 * Merge a backup into what is already here. Tasks are matched by id, so
 * restoring the same file twice adds nothing, and restoring an old backup
 * never deletes tasks created since.
 */
export function importBackup(
  json: string,
  store: KeyValueStore = browserStore(),
): { added: number; skipped: number } {
  let parsed: { format?: unknown; tasks?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LocalStoreError('That file is not a SmartTask backup.');
  }
  if (parsed?.format !== BACKUP_FORMAT || !Array.isArray(parsed.tasks)) {
    throw new LocalStoreError('That file is not a SmartTask backup.');
  }

  const existing = readTasks(store);
  const known = new Set(existing.map((t) => t.id));
  const incoming = parsed.tasks.map(sanitizeStoredTask).filter((t): t is Task => t !== null);
  const fresh = incoming.filter((t) => !known.has(t.id));

  writeTasks(store, [...existing, ...fresh]);
  return { added: fresh.length, skipped: parsed.tasks.length - fresh.length };
}

/**
 * Ask the browser not to evict this site's storage under pressure. Granted
 * readily for an installed app on Android; a refusal is not an error, it just
 * means backups matter more.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage;
    return (await storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
