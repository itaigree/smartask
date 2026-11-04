#!/usr/bin/env node
/**
 * Diagnose the Notion connection, one step at a time, and say exactly what to
 * fix. Run it whenever the app says it cannot reach Notion.
 *
 *   npm run check:notion
 *
 * Read-only: it never creates or changes anything in your workspace.
 */
// The Notion SDK is CommonJS, so Node's ESM loader cannot name-import from it.
import notionSdk from '@notionhq/client';
const { Client } = notionSdk;
import { loadEnv, normalizeId, describeFailure, ok, bad, warn, info } from './lib/env.mjs';
import { SCHEMA, PROPS } from '../src/lib/notion-mapping.ts';

loadEnv();

let failed = false;
const fail = (msg) => {
  bad(msg);
  failed = true;
};

/** The property type the app expects, derived from the schema it ships with. */
const EXPECTED = Object.fromEntries(
  Object.entries(SCHEMA).map(([name, definition]) => [name, Object.keys(definition)[0]]),
);

console.log('\nChecking the Notion connection…\n');

/* 1 — the token ------------------------------------------------------- */

console.log('1. Integration token');
const token = process.env.NOTION_TOKEN?.trim();

if (!token) {
  fail('NOTION_TOKEN is not set.');
  info('Put it in .env.local. Create one at https://www.notion.so/my-integrations');
  process.exit(1);
}
if (!/^(ntn_|secret_)/.test(token)) {
  warn('NOTION_TOKEN does not start with "ntn_" or "secret_" — check you copied the');
  info('Internal Integration Secret, not the integration id or a database link.');
} else {
  ok(`NOTION_TOKEN is set (${token.slice(0, 4)}…, ${token.length} chars)`);
}

const notion = new Client({ auth: token });

let me;
try {
  me = await notion.users.me({});
  ok(`Notion accepted the token — integration "${me.name ?? 'unnamed'}"`);
  const workspace = me.bot?.workspace_name;
  if (workspace) info(`Workspace: ${workspace}`);
} catch (error) {
  const { summary, advice } = describeFailure(error);
  fail(summary);
  advice.forEach(info);
  process.exit(1);
}

/* 2 — the database ---------------------------------------------------- */

console.log('\n2. Tasks database');
const databaseId = normalizeId(process.env.NOTION_DATABASE_ID);

if (!databaseId) {
  warn('NOTION_DATABASE_ID is not set — the app will show its setup screen.');

  const parentId = normalizeId(process.env.NOTION_PARENT_PAGE_ID);
  if (!parentId) {
    info('Set NOTION_PARENT_PAGE_ID to the Notion page the database should live in,');
    info('then run: npm run setup:notion');
    process.exit(1);
  }

  info('Checking the parent page instead…');
  try {
    await notion.pages.retrieve({ page_id: parentId });
    ok('The integration can see the parent page.');
    info('You are ready to run: npm run setup:notion');
  } catch (error) {
    const { summary, advice } = describeFailure(error);
    fail(summary);
    advice.forEach(info);
  }
  process.exit(failed ? 1 : 0);
}

ok(`NOTION_DATABASE_ID is set (${databaseId})`);

let database;
try {
  database = await notion.databases.retrieve({ database_id: databaseId });
  const title = database.title?.map((t) => t.plain_text).join('') || 'untitled';
  ok(`Found the database: "${title}"`);
  if (database.url) info(database.url);
} catch (error) {
  const { summary, advice } = describeFailure(error);
  fail(summary);
  advice.forEach(info);
  process.exit(1);
}

/* 3 — the data source and its schema ---------------------------------- */

console.log('\n3. Schema');
const dataSourceId = database.data_sources?.[0]?.id;

if (!dataSourceId) {
  fail('That database has no data source, so the app cannot read or write it.');
  info('Check NOTION_DATABASE_ID points at a database, not a plain page.');
  process.exit(1);
}
ok(`Data source resolved (${dataSourceId})`);

let dataSource;
try {
  dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
} catch (error) {
  fail(`Cannot read the data source (${error?.code ?? 'error'}).`);
  process.exit(1);
}

const actual = dataSource.properties ?? {};
let schemaProblems = 0;

for (const [name, expectedType] of Object.entries(EXPECTED)) {
  const found = actual[name];
  if (!found) {
    fail(`Missing property "${name}" (expected type ${expectedType}).`);
    schemaProblems += 1;
  } else if (found.type !== expectedType) {
    fail(`Property "${name}" is type "${found.type}", the app expects "${expectedType}".`);
    schemaProblems += 1;
  }
}

if (schemaProblems === 0) {
  ok(`All ${Object.keys(EXPECTED).length} properties present with the right types`);
} else {
  info('Rename the properties in Notion to match, or run `npm run setup:notion`');
  info('to create a fresh database and point NOTION_DATABASE_ID at that instead.');
}

// Select options are not fatal — Notion creates a missing one on write — but a
// missing option usually means someone renamed a category by hand.
for (const name of [PROPS.category, PROPS.priority, PROPS.status]) {
  const expectedOptions = SCHEMA[name]?.select?.options?.map((o) => o.name) ?? [];
  const actualOptions = actual[name]?.select?.options?.map((o) => o.name) ?? [];
  const missing = expectedOptions.filter((o) => !actualOptions.includes(o));
  if (missing.length) {
    warn(`"${name}" is missing option(s): ${missing.join(', ')} (Notion will add them on write)`);
  }
}

/* 4 — an actual read -------------------------------------------------- */

console.log('\n4. Reading tasks');
try {
  const page = await notion.dataSources.query({ data_source_id: dataSourceId, page_size: 3 });
  ok(`Query succeeded — ${page.results.length} task(s) returned${page.has_more ? ', more available' : ''}`);
  for (const row of page.results) {
    const title = row.properties?.[PROPS.title]?.title?.map((t) => t.plain_text).join('');
    if (title) info(`• ${title}`);
  }
  if (page.results.length === 0) info('The database is empty — add a task in the app.');
} catch (error) {
  fail(`Query failed (${error?.code ?? 'error'}): ${error?.message ?? error}`);
}

console.log(
  failed
    ? '\n\x1b[31mSomething is not right — see the ✗ lines above.\x1b[0m\n'
    : '\n\x1b[32mNotion is connected correctly. Run `npm run dev`.\x1b[0m\n',
);
process.exit(failed ? 1 : 0);
