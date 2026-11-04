#!/usr/bin/env node
/**
 * One-off: create the SmartTask database in Notion with the exact schema the
 * app expects, and print the id to put in NOTION_DATABASE_ID.
 *
 * Usage:
 *   NOTION_TOKEN=... NOTION_PARENT_PAGE_ID=... npm run setup:notion
 *
 * Safe to re-run: it creates a new database each time, it never edits one.
 */
// The Notion SDK is CommonJS, so Node's ESM loader cannot name-import from it.
import notionSdk from '@notionhq/client';
const { Client } = notionSdk;
import { loadEnv, normalizeId, describeFailure } from './lib/env.mjs';

loadEnv();

const CATEGORIES = ['Work', 'Personal', 'Errands', 'Health', 'Finance', 'Learning', 'Home', 'Inbox'];
const PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];
const STATUSES = ['Todo', 'Doing', 'Done'];

const COLORS = {
  Work: 'blue', Personal: 'purple', Errands: 'orange', Health: 'green',
  Finance: 'yellow', Learning: 'pink', Home: 'brown', Inbox: 'default',
  Urgent: 'red', High: 'orange', Normal: 'default', Low: 'gray',
  Todo: 'default', Doing: 'blue', Done: 'green',
};

const options = (names) => names.map((name) => ({ name, color: COLORS[name] ?? 'default' }));

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const token = process.env.NOTION_TOKEN?.trim();
if (!token) fail('NOTION_TOKEN is not set. Create an integration at https://www.notion.so/my-integrations');

const parentId = normalizeId(process.env.NOTION_PARENT_PAGE_ID);
if (!parentId) {
  fail(
    'NOTION_PARENT_PAGE_ID is not set or is not a Notion id.\n' +
    '  Open the Notion page the database should live in, use "Copy link",\n' +
    '  and paste the whole URL into NOTION_PARENT_PAGE_ID in .env.local.\n' +
    '  Then share that page with your integration: ••• → Connections → your integration.',
  );
}

const notion = new Client({ auth: token });

console.log('Creating the SmartTask database in Notion…');

let database;
try {
  database = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentId },
    title: [{ type: 'text', text: { content: 'SmartTask' } }],
    icon: { type: 'emoji', emoji: '✅' },
    initial_data_source: {
      properties: {
        Name: { title: {} },
        Category: { select: { options: options(CATEGORIES) } },
        Priority: { select: { options: options(PRIORITIES) } },
        Status: { select: { options: options(STATUSES) } },
        Due: { date: {} },
        Project: { rich_text: {} },
        Tags: { multi_select: { options: [] } },
        Note: { rich_text: {} },
        Completed: { date: {} },
      },
    },
  });
} catch (error) {
  const { summary, advice } = describeFailure(error);
  fail([summary, ...advice.map((line) => `  ${line}`)].join('\n'));
}

console.log('\n✓ Database created.\n');
console.log('  Add this to .env.local:\n');
console.log(`  NOTION_DATABASE_ID=${database.id}\n`);
if (database.url) console.log(`  Open it in Notion: ${database.url}\n`);
