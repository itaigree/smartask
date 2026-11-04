import { draftFromText, ValidationError } from './capture.ts';
import { cached, invalidate, DEFAULT_TTL_MS } from './cache.ts';
import {
  getClient, getDataSourceId, isConfigured,
  newTaskToProperties, pageToTask, patchToProperties, PROPS,
} from './notion.ts';
import type { NewTask, Task, TaskPatch } from './types.ts';

/**
 * The repository the API routes talk to. Notion is the store (PLAN.md
 * decision 2); this module owns paging, caching and the capture pipeline.
 */

const LIST_CACHE_KEY = 'tasks:all';
const PAGE_SIZE = 100;
/** Enough for a personal backlog; stops a runaway loop against a huge database. */
const MAX_PAGES = 20;

export { isConfigured };

async function fetchAllTasks(): Promise<Task[]> {
  const notion = getClient();
  const dataSourceId = await getDataSourceId();

  const tasks: Task[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      page_size: PAGE_SIZE,
      start_cursor: cursor,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    });

    for (const result of response.results) {
      const task = pageToTask(result);
      if (task) tasks.push(task);
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return tasks;
}

/** Every open and recently-closed task. Cached for {@link DEFAULT_TTL_MS}. */
export async function listTasks(options: { fresh?: boolean } = {}): Promise<Task[]> {
  if (options.fresh) invalidate();
  return cached(LIST_CACHE_KEY, DEFAULT_TTL_MS, fetchAllTasks);
}

/** Create a task from raw captured text. */
export async function captureTask(text: string, now: Date = new Date()): Promise<Task> {
  return createTask(await draftFromText(text, now));
}

export async function createTask(draft: NewTask): Promise<Task> {
  const notion = getClient();
  const dataSourceId = await getDataSourceId();

  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: newTaskToProperties(draft) as never,
  });

  invalidate();

  const task = pageToTask(page);
  if (!task) throw new Error('Notion accepted the task but returned an unreadable page.');
  return task;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const properties = patchToProperties(patch);
  if (Object.keys(properties).length === 0) {
    throw new ValidationError('Nothing to update.');
  }

  const page = await getClient().pages.update({
    page_id: id,
    properties: properties as never,
  });

  invalidate();

  const task = pageToTask(page);
  if (!task) throw new Error('Notion accepted the update but returned an unreadable page.');
  return task;
}

/**
 * Archive rather than delete: the page moves to the Notion trash, so nothing is
 * destroyed and it can be restored from Notion itself.
 */
export async function archiveTask(id: string): Promise<void> {
  await getClient().pages.update({ page_id: id, in_trash: true } as never);
  invalidate();
}

export { PROPS };
export { ValidationError, draftFromText };

