import type { CategorySignal, RuleInput } from './categorize/index.ts';
import type { Category, Task } from './types.ts';

/**
 * Re-sort tasks stuck in Inbox — usually ones captured before AI was turned on,
 * or while it was failing.
 *
 * Deliberately sequential with a gap between calls: the Gemini free tier allows
 * only a handful of requests a minute, and a burst would fail half-way. On the
 * first classification error it stops and says why, rather than hammering an
 * API that is already refusing.
 */

export interface SortProgress {
  done: number;
  total: number;
  changed: number;
  /** Tasks left alone because they changed during the run (moved, done, deleted). */
  skipped?: number;
}

export interface SortOutcome extends SortProgress {
  /** Present when the run stopped early; the remaining tasks are untouched. */
  stoppedReason?: string;
  /** True when the run was cancelled (the board closed, or the AI settings changed). */
  cancelled?: boolean;
}

export interface SortOptions {
  delayMs?: number;
  onProgress?: (progress: SortProgress) => void;
  onUpdated?: (task: Task) => void;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The task as it is *now*. The run takes a while, and the user keeps
   * working: a task they moved, completed or deleted meanwhile is skipped,
   * never overwritten.
   */
  current?: (id: string) => Task | undefined;
  /** Stops the run before the next request or write. */
  signal?: AbortSignal;
}

/** Still an open Inbox task, so still the sort's to file. */
const stillInbox = (task: Task | undefined): task is Task =>
  task !== undefined && task.category === 'Inbox' && task.status !== 'Done';

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Open tasks still in Inbox — what the sort will work through. */
export function inboxTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.category === 'Inbox' && t.status !== 'Done');
}

export async function sortInbox(
  tasks: Task[],
  /** Must throw on failure — a fallback answer here would silently re-file into Inbox. */
  classify: (input: RuleInput) => Promise<CategorySignal>,
  update: (task: Task, category: Category) => Promise<Task>,
  options: SortOptions = {},
): Promise<SortOutcome> {
  const { delayMs = 1500, onProgress, onUpdated, sleep = realSleep, current, signal: abort } = options;
  const targets = inboxTasks(tasks);
  const progress: SortProgress = { done: 0, total: targets.length, changed: 0, skipped: 0 };
  const live = (task: Task) => (current ? current(task.id) : task);
  const cancelled = (): SortOutcome => ({ ...progress, cancelled: true });
  const skip = () => {
    progress.skipped = (progress.skipped ?? 0) + 1;
    progress.done += 1;
    onProgress?.({ ...progress });
  };

  for (const [index, queued] of targets.entries()) {
    if (abort?.aborted) return cancelled();
    if (index > 0) await sleep(delayMs);
    if (abort?.aborted) return cancelled();

    const task = live(queued);
    if (!stillInbox(task)) {
      skip();
      continue;
    }

    let signal: CategorySignal;
    try {
      signal = await classify({
        title: task.title,
        note: task.note,
        project: task.project,
        tags: task.tags,
      });
    } catch (error) {
      return {
        ...progress,
        stoppedReason: error instanceof Error ? error.message : 'Classification failed.',
      };
    }

    if (abort?.aborted) return cancelled();
    // Gemini took a moment: if the user filed it themselves meanwhile, theirs wins.
    const latest = live(task);
    if (!stillInbox(latest)) {
      skip();
      continue;
    }

    // Still Inbox means the model genuinely could not tell. Leave it alone
    // rather than spend a Notion write on a no-op.
    if (signal.category !== 'Inbox') {
      try {
        const saved = await update(latest, signal.category);
        progress.changed += 1;
        onUpdated?.(saved);
      } catch (error) {
        return {
          ...progress,
          stoppedReason: error instanceof Error ? error.message : 'Could not save to Notion.',
        };
      }
    }

    progress.done += 1;
    onProgress?.({ ...progress });
  }

  return progress;
}
