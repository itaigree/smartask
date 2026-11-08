import type { Task } from './types.ts';

/**
 * Keeping the on-screen list honest while reads and writes overlap.
 *
 * The board shows a copy of the list. A read can take seconds (mobile data,
 * a big Notion database), and the user keeps working meanwhile: a read that
 * started before a tick, an add or a delete must not land afterwards and
 * quietly undo it. Notion's query can also lag a moment behind a write it has
 * already confirmed.
 *
 * So every write is remembered here for a while — pending ones until they
 * finish, finished ones for a grace period — and each read is merged with them
 * instead of replacing the list. Pure functions, so they are tested directly.
 */

/** What the board knows about one task because of its own recent write. */
export interface RecentWrite {
  /** The task as this device last wrote it; null when it was deleted. */
  task: Task | null;
  /** When the write finished (or started, while pending). */
  at: number;
  /** Still waiting for the store to answer. */
  pending: boolean;
}

/**
 * Default for how long a finished write outranks a read that started after it
 * (a query that has not caught up yet). Callers pick their own: 0 for device
 * storage, which never lags, and a few seconds for Notion. A read that started
 * *before* the write finished never wins, whatever the grace.
 */
export const READ_GRACE_MS = 5_000;

/** Finished writes older than this are forgotten. */
export const FORGET_AFTER_MS = 60_000;

/**
 * Merge a list read with this device's recent writes.
 *
 * - A pending write always wins: the store has not answered yet.
 * - A finished write wins over a read that started before it (or within the
 *   grace period after it), because that read cannot have seen it.
 * - Anything older, the read wins — it may include an edit made in Notion.
 */
export function mergeRead(
  loaded: readonly Task[],
  writes: ReadonlyMap<string, RecentWrite>,
  readStartedAt: number,
  graceMs: number = READ_GRACE_MS,
): Task[] {
  const cutoff = readStartedAt - graceMs;
  const relevant = new Map<string, RecentWrite>();
  for (const [id, write] of writes) {
    if (write.pending || write.at > cutoff) relevant.set(id, write);
  }
  if (relevant.size === 0) return [...loaded];

  const merged: Task[] = [];
  for (const task of loaded) {
    const write = relevant.get(task.id);
    if (!write) merged.push(task);
    else if (write.task) merged.push(write.task);
    // write.task === null: deleted here, the read is out of date.
  }
  // Written here but missing from the read: an add the read predates.
  const present = new Set(merged.map((t) => t.id));
  const added = [...relevant.values()]
    .map((w) => w.task)
    .filter((t): t is Task => t !== null && !present.has(t.id));
  return [...added, ...merged];
}

/** Drop finished writes that can no longer matter. */
export function forgetOldWrites(writes: Map<string, RecentWrite>, now: number): void {
  for (const [id, write] of writes) {
    if (!write.pending && write.at < now - FORGET_AFTER_MS) writes.delete(id);
  }
}

/** Replace one task in the list, leaving every other task as it is now. */
export function replaceTask(list: readonly Task[] | null, id: string, next: Task): Task[] {
  return (list ?? []).map((t) => (t.id === id ? next : t));
}

/**
 * Put a task back after a failed delete — at its old position, and only if it
 * is not already there.
 */
export function restoreTask(list: readonly Task[] | null, task: Task, index: number): Task[] {
  const current = [...(list ?? [])];
  if (current.some((t) => t.id === task.id)) return current;
  const at = index < 0 ? 0 : Math.min(index, current.length);
  current.splice(at, 0, task);
  return current;
}

/**
 * One task's saves. They are sent one after another (each waits on `tail`),
 * so answers arrive in the order they were sent and the last answer is the
 * task's real state.
 */
export interface Ledger {
  /** The task as the store last confirmed it (null once deleted). */
  confirmed: Task | null;
  /** When it confirmed that; 0 when `confirmed` came from a read. */
  confirmedAt: number;
  /** Changes waiting for an answer, oldest first; a null patch is a delete. */
  pending: Array<{ seq: number; patch: Partial<Task> | null }>;
  /** The newest save in the queue; the next one starts after it settles. */
  tail: Promise<void>;
  /** Where the task sat in the list, to put it back there after a failed delete. */
  index: number;
}

/** What to show for a task: its confirmed state with every queued change applied. */
export function ledgerTask(ledger: Ledger): Task | null {
  let task = ledger.confirmed;
  for (const op of ledger.pending) {
    task = op.patch === null || task === null ? null : { ...task, ...op.patch };
  }
  return task;
}
