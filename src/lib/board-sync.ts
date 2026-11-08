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
 * How long a finished write outranks what a read says. A read may come from
 * the 20-second cache or from a query that has not caught up yet, so this is a
 * little longer than the cache.
 */
export const READ_GRACE_MS = 25_000;

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
): Task[] {
  const cutoff = readStartedAt - READ_GRACE_MS;
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
