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
}

export interface SortOutcome extends SortProgress {
  /** Present when the run stopped early; the remaining tasks are untouched. */
  stoppedReason?: string;
}

export interface SortOptions {
  delayMs?: number;
  onProgress?: (progress: SortProgress) => void;
  onUpdated?: (task: Task) => void;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

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
  const { delayMs = 1500, onProgress, onUpdated, sleep = realSleep } = options;
  const targets = inboxTasks(tasks);
  const progress: SortProgress = { done: 0, total: targets.length, changed: 0 };

  for (const [index, task] of targets.entries()) {
    if (index > 0) await sleep(delayMs);

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

    // Still Inbox means the model genuinely could not tell. Leave it alone
    // rather than spend a Notion write on a no-op.
    if (signal.category !== 'Inbox') {
      try {
        const saved = await update(task, signal.category);
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
