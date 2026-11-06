// A named import: the bundler resolves it. (Node's own ESM loader cannot name-
// import this CommonJS package, which is why unit tests import notion-mapping.ts
// and never this file.)
import { Client } from '@notionhq/client';
import type { NotionConfig } from './config.ts';

export {
  PROPS, SCHEMA, pageToTask, newTaskToProperties, patchToProperties,
} from './notion-mapping.ts';

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
      'That Notion database has no data source. Check the id points at a database, not a page.',
    );
  }

  dataSourceIds.set(databaseId, first);
  return first;
}

export function forgetDataSources(): void {
  dataSourceIds.clear();
}

/**
 * Turn whatever the SDK threw into something worth showing a person.
 * A network failure and a rejected token are different problems.
 */
export function describeNotionError(error: unknown): string {
  const err = error as { code?: string; message?: string; name?: string };
  const message = String(err?.message ?? error);

  if (err?.name === 'BrowserTokenNotAllowedError') {
    return 'The Notion client refused to use a token in the browser. This is a bug in the app, not your setup.';
  }

  switch (err?.code) {
    case 'unauthorized':
      return 'Notion rejected the token. Check you pasted the Internal Integration Secret in full.';
    case 'restricted_resource':
    case 'object_not_found':
      return 'Notion cannot find that database. Open it in Notion, then ••• → Connections, and add your integration.';
    case 'rate_limited':
      return 'Notion is rate limiting (about 3 requests a second). Wait a moment and try again.';
    case 'validation_error':
      return `Notion rejected the data: ${message}`;
    default:
      break;
  }

  if (!err?.code || /fetch|network|failed/i.test(message)) {
    return 'Could not reach Notion. Check your connection and try again.';
  }
  return message;
}
