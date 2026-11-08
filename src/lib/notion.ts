// A named import: the bundler resolves it. (Node's own ESM loader cannot name-
// import this CommonJS package, which is why unit tests import notion-mapping.ts
// and notion-errors.ts and never this file.)
import { Client } from '@notionhq/client';
import type { NotionConfig } from './config.ts';

export {
  PROPS, SCHEMA, pageToTask, newTaskToProperties, patchToProperties, listFilter,
} from './notion-mapping.ts';
export {
  describeNotionError, mayHaveSaved, notionErrorCode, TaskGoneError, UnconfirmedSaveError,
} from './notion-errors.ts';

/**
 * The Notion client, running in the browser.
 *
 * The Notion API sends CORS headers, so a page can call `api.notion.com`
 * directly. The SDK refuses to hold a token in a browser unless
 * `dangerouslyAllowBrowser` is set — which is correct of it, and deliberate
 * here: the token is the user's own, entered by them, kept on their device.
 */
export function createClient(config: NotionConfig): Client {
  return new Client({ auth: config.token, dangerouslyAllowBrowser: true });
}

/**
 * Notion's 2025 API splits a database into data sources; reads and page
 * creation address the data source, not the database. Resolved once per
 * database id and remembered for the life of the page.
 */
const dataSourceIds = new Map<string, string>();

export async function getDataSourceId(client: Client, databaseId: string): Promise<string> {
  const cached = dataSourceIds.get(databaseId);
  if (cached) return cached;

  const database = await client.databases.retrieve({ database_id: databaseId });
  const sources = (database as { data_sources?: Array<{ id: string }> }).data_sources;
  const first = sources?.[0]?.id;
  if (!first) {
    throw new Error(
      'That Notion database has no data source to read. Check the link is to the database ' +
        'itself, not a page or a linked view of it.',
    );
  }

  dataSourceIds.set(databaseId, first);
  return first;
}

export function forgetDataSources(): void {
  dataSourceIds.clear();
}
