import type { Client } from '@notionhq/client';
import { captureDraft, draftFromText, ValidationError } from './capture.ts';
import { getCategorizer, type Categorizer, type CategorySignal } from './categorize/index.ts';
import { cached, invalidate, DEFAULT_TTL_MS } from './cache.ts';
import type { NotionConfig } from './config.ts';
import {
  createClient, getDataSourceId, mayHaveSaved, notionErrorCode,
  listFilter, newTaskToProperties, pageToTask, patchToProperties,
  OPTIONAL_SCHEMA, PROPS, ReminderSetupError, TaskGoneError, UnconfirmedSaveError,
} from './notion.ts';
import type { NewTask, Task, TaskPatch } from './types.ts';

/**
 * The repository the UI talks to. Built from a config rather than reading the
 * environment, because there is no environment any more — the credentials come
 * from local storage at runtime (PLAN.md decision 1, revised).
 */

const PAGE_SIZE = 100;
/**
 * Stops a runaway loop against a huge database. The list reads open and
 * recently done tasks only, so a personal backlog never comes near it.
 */
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

  async function readTasks(dataSourceId: string, filter?: object): Promise<Task[]> {
    const tasks: Task[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: PAGE_SIZE,
        start_cursor: cursor,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        ...(filter ? { filter: filter as never } : {}),
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

  /**
   * A database built by hand may lack Completed, or use Notion's own Status
   * type, which the list filter cannot name. Reading everything, as before,
   * beats reading nothing; once refused, the filter is not tried again.
   */
  let filterRefused = false;

  async function fetchAllTasks(): Promise<Task[]> {
    const dataSourceId = await dataSource();
    if (filterRefused) return readTasks(dataSourceId);
    try {
      return await readTasks(dataSourceId, listFilter(new Date()));
    } catch (e) {
      if (notionErrorCode(e) !== 'validation_error') throw e;
      filterRefused = true;
      return readTasks(dataSourceId);
    }
  }

  /**
   * Notion answers "not found" both for a task deleted there and for a
   * database the integration can no longer see. Asking for the database tells
   * them apart, so a deleted task is not reported as a missing database.
   */
  async function pageIsGone(error: unknown): Promise<boolean> {
    if (notionErrorCode(error) !== 'object_not_found') return false;
    try {
      await client.databases.retrieve({ database_id: config.databaseId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the database has the Reminder property; true is remembered. One
   * of another type (a "Reminder" checkbox someone added) cannot hold a time,
   * and Notion's own refusal would not say which property is wrong.
   */
  let reminderReady = false;

  async function hasReminderProperty(): Promise<boolean> {
    if (reminderReady) return true;
    const source = await client.dataSources.retrieve({ data_source_id: await dataSource() });
    const found = (source as { properties?: Record<string, { type?: string }> })
      .properties?.[PROPS.reminder];
    if (!found) return false;
    if (found.type !== 'date') {
      throw new ReminderSetupError(
        `Your Notion database has a "${PROPS.reminder}" property that is not a Date, so it cannot hold a reminder.`,
      );
    }
    reminderReady = true;
    return true;
  }

  /** A database made before reminders existed gets the property the first time one is set. */
  async function addReminderProperty(): Promise<void> {
    try {
      await client.dataSources.update({
        data_source_id: await dataSource(),
        properties: OPTIONAL_SCHEMA as never,
      });
      reminderReady = true;
    } catch (e) {
      // Not a database problem: let "no connection" or "bad token" say so itself.
      const code = notionErrorCode(e);
      if (code !== 'validation_error' && code !== 'restricted_resource') throw e;
      throw new ReminderSetupError('The app could not add the reminder property to your Notion database.');
    }
  }

  /**
   * Send a page update. If Notion refuses it because the database has no
   * Reminder property yet, add the property and send again — or, when the
   * change only clears a reminder, send the rest: there is nothing to clear.
   */
  async function sendUpdate(id: string, properties: Record<string, unknown>): Promise<unknown> {
    const send = (props: Record<string, unknown>) =>
      client.pages.update({ page_id: id, properties: props as never });
    try {
      return await send(properties);
    } catch (e) {
      const reminder = properties[PROPS.reminder] as { date: unknown } | undefined;
      if (!reminder || notionErrorCode(e) !== 'validation_error') throw e;
      if (await hasReminderProperty()) throw e; // refused for some other reason

      if (reminder.date) {
        await addReminderProperty();
        return send(properties);
      }
      const { [PROPS.reminder]: _nothingToClear, ...rest } = properties;
      return Object.keys(rest).length ? send(rest) : client.pages.retrieve({ page_id: id });
    }
  }

  async function createTask(draft: NewTask): Promise<Task> {
    const dataSourceId = await dataSource();
    // Offline before sending means the request never left (see mayHaveSaved).
    const offlineBefore = typeof navigator !== 'undefined' && navigator.onLine === false;
    let page: unknown;
    try {
      page = await client.pages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: newTaskToProperties(draft) as never,
      });
    } catch (e) {
      if (!mayHaveSaved(e, offlineBefore)) throw e;
      // The answer, not the request, may be what was lost: the task may be in
      // Notion now. Say so, rather than invite a second Add and a duplicate.
      invalidate();
      throw new UnconfirmedSaveError();
    }

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

      let page: unknown;
      try {
        page = await sendUpdate(id, properties);
      } catch (e) {
        if (!(await pageIsGone(e))) throw e;
        invalidate(); // a cached list would still show it
        throw new TaskGoneError();
      }

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
      try {
        await client.pages.update({ page_id: id, in_trash: true } as never);
      } catch (e) {
        // Already deleted in Notion: what the user asked for is done.
        if (!(await pageIsGone(e))) throw e;
      }
      invalidate();
    },
  };
}

export { ValidationError, draftFromText };
