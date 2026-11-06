import type { Client } from '@notionhq/client';
import { captureDraft, draftFromText, ValidationError } from './capture.ts';
import { getCategorizer, type Categorizer, type CategorySignal } from './categorize/index.ts';
import { cached, invalidate, DEFAULT_TTL_MS } from './cache.ts';
import type { NotionConfig } from './config.ts';
import {
  createClient, getDataSourceId,
  newTaskToProperties, pageToTask, patchToProperties,
} from './notion.ts';
import type { NewTask, Task, TaskPatch } from './types.ts';

/**
 * The repository the UI talks to. Built from a config rather than reading the
 * environment, because there is no environment any more — the credentials come
 * from local storage at runtime (PLAN.md decision 1, revised).
 */

const PAGE_SIZE = 100;
/** Enough for a personal backlog; stops a runaway loop against a huge database. */
const MAX_PAGES = 20;

export interface CaptureResult {
  task: Task;
  /** Who filed it and why — shown to the user straight after capture. */
  signal: CategorySignal;
}

export interface TaskRepository {
  listTasks(options?: { fresh?: boolean }): Promise<Task[]>;
  captureTask(text: string, now?: Date): Promise<CaptureResult>;
  createTask(draft: NewTask): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  archiveTask(id: string): Promise<void>;
}

export function createTaskRepository(
  config: NotionConfig,
  categorizer: Categorizer = getCategorizer(),
): TaskRepository {
  const client: Client = createClient(config);
  const cacheKey = `tasks:${config.databaseId}`;

  const dataSource = () => getDataSourceId(client, config.databaseId);

  async function fetchAllTasks(): Promise<Task[]> {
    const dataSourceId = await dataSource();
    const tasks: Task[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await client.dataSources.query({
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

  async function createTask(draft: NewTask): Promise<Task> {
    const dataSourceId = await dataSource();
    const page = await client.pages.create({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: newTaskToProperties(draft) as never,
    });

    invalidate();

    const task = pageToTask(page);
    if (!task) throw new Error('Notion accepted the task but returned an unreadable page.');
    return task;
  }

  return {
    listTasks(options = {}) {
      if (options.fresh) invalidate();
      return cached(cacheKey, DEFAULT_TTL_MS, fetchAllTasks);
    },

    async captureTask(text, now = new Date()) {
      const { draft, signal } = await captureDraft(text, now, categorizer);
      return { task: await createTask(draft), signal };
    },

    createTask,

    async updateTask(id, patch) {
      const properties = patchToProperties(patch);
      if (Object.keys(properties).length === 0) {
        throw new ValidationError('Nothing to update.');
      }

      const page = await client.pages.update({
        page_id: id,
        properties: properties as never,
      });

      invalidate();

      const task = pageToTask(page);
      if (!task) throw new Error('Notion accepted the update but returned an unreadable page.');
      return task;
    },

    /**
     * Archive rather than delete: the page moves to the Notion trash, so nothing
     * is destroyed and it can be restored from Notion itself.
     */
    async archiveTask(id) {
      await client.pages.update({ page_id: id, in_trash: true } as never);
      invalidate();
    },
  };
}

export { ValidationError, draftFromText };
