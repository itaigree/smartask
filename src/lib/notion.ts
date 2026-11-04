import { Client } from '@notionhq/client';

export {
  PROPS, SCHEMA, pageToTask, newTaskToProperties, patchToProperties,
} from './notion-mapping.ts';

/**
 * Notion access: configuration, the SDK client, and data-source resolution.
 * The pure mapping lives in notion-mapping.ts and is re-exported here so
 * callers have a single import.
 *
 * PLAN.md decision 1: this module reads the token from the environment and must
 * never be imported by a client component.
 */

export interface NotionConfig {
  token: string;
  databaseId: string;
}

/** Null when the app has not been configured yet (PLAN.md decision 5). */
export function getNotionConfig(): NotionConfig | null {
  const token = process.env.NOTION_TOKEN?.trim();
  const databaseId = process.env.NOTION_DATABASE_ID?.trim();
  if (!token || !databaseId) return null;
  return { token, databaseId };
}

export function isConfigured(): boolean {
  return getNotionConfig() !== null;
}

export class NotionNotConfiguredError extends Error {
  constructor() {
    super('NOTION_TOKEN and NOTION_DATABASE_ID must be set. See README.md.');
    this.name = 'NotionNotConfiguredError';
  }
}

let client: Client | null = null;

export function getClient(): Client {
  const config = getNotionConfig();
  if (!config) throw new NotionNotConfiguredError();
  if (!client) client = new Client({ auth: config.token });
  return client;
}

let dataSourceId: string | null = null;

/**
 * Notion's 2025 API splits a database into one or more data sources, and reads
 * and page creation address the data source rather than the database. Resolve it
 * once per process from the configured database id.
 */
export async function getDataSourceId(): Promise<string> {
  if (dataSourceId) return dataSourceId;
  const config = getNotionConfig();
  if (!config) throw new NotionNotConfiguredError();

  const db = await getClient().databases.retrieve({ database_id: config.databaseId });
  const sources = (db as { data_sources?: Array<{ id: string }> }).data_sources;
  const first = sources?.[0]?.id;
  if (!first) {
    throw new Error(
      `Notion database ${config.databaseId} has no data source. ` +
        'Re-run `npm run setup:notion`, or check NOTION_DATABASE_ID points at a database.',
    );
  }
  dataSourceId = first;
  return first;
}

/** Test seam, and a way to recover after a config change without a restart. */
export function resetNotionClient(): void {
  client = null;
  dataSourceId = null;
}
