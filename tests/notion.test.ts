import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageToTask, newTaskToProperties, patchToProperties, PROPS, SCHEMA,
} from '../src/lib/notion-mapping.ts';
import { toISODate } from '../src/lib/parse.ts';
import { CATEGORIES, PRIORITIES, STATUSES, type NewTask } from '../src/lib/types.ts';

function page(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    object: 'page',
    id: 'page-1',
    created_time: '2026-11-01T10:00:00.000Z',
    url: 'https://notion.so/page-1',
    properties,
    ...extra,
  };
}

const full = page({
  [PROPS.title]: { title: [{ plain_text: 'Pay ' }, { plain_text: 'rent' }] },
  [PROPS.category]: { select: { name: 'Finance' } },
  [PROPS.priority]: { select: { name: 'Urgent' } },
  [PROPS.status]: { select: { name: 'Doing' } },
  [PROPS.due]: { date: { start: '2026-11-06' } },
  [PROPS.project]: { rich_text: [{ plain_text: 'home' }] },
  [PROPS.tags]: { multi_select: [{ name: 'bills' }, { name: 'monthly' }] },
  [PROPS.note]: { rich_text: [{ plain_text: 'standing order' }] },
  [PROPS.completedAt]: { date: null },
});

test('a complete Notion page maps to a complete Task', () => {
  const task = pageToTask(full);
  assert.deepEqual(task, {
    id: 'page-1',
    title: 'Pay rent',
    category: 'Finance',
    priority: 'Urgent',
    status: 'Doing',
    due: '2026-11-06',
    project: 'home',
    tags: ['bills', 'monthly'],
    note: 'standing order',
    createdAt: '2026-11-01T10:00:00.000Z',
    completedAt: null,
    url: 'https://notion.so/page-1',
  });
});

test('a page hand-edited in Notion falls back instead of throwing', () => {
  const task = pageToTask(page({
    [PROPS.title]: { title: [] },
    [PROPS.category]: { select: { name: 'Bad, name' } },
    [PROPS.priority]: { select: null },
    // Status, Due, Tags, Note removed entirely.
  }));
  assert.equal(task?.title, 'Untitled task');
  assert.equal(task?.category, 'Inbox', 'a name Notion could never hold falls back to Inbox');
  assert.equal(task?.priority, 'Normal');
  assert.equal(task?.status, 'Todo');
  assert.equal(task?.due, null);
  assert.deepEqual(task?.tags, []);
});

test('non-pages and trashed pages are skipped', () => {
  assert.equal(pageToTask({ object: 'data_source', id: 'x' }), null);
  assert.equal(pageToTask(page({}, { in_trash: true })), null);
  assert.equal(pageToTask(page({}, { archived: true })), null);
  assert.equal(pageToTask(null), null);
  assert.equal(pageToTask({ object: 'page', id: 'x' }), null, 'no properties');
});

test('a new task becomes a valid property payload', () => {
  const draft: NewTask = {
    title: 'Buy milk',
    category: 'Errands',
    priority: 'Normal',
    status: 'Todo',
    due: '2026-11-05',
    project: null,
    tags: ['shop'],
    note: null,
  };
  const props = newTaskToProperties(draft) as Record<string, any>;
  assert.equal(props[PROPS.title].title[0].text.content, 'Buy milk');
  assert.equal(props[PROPS.category].select.name, 'Errands');
  assert.deepEqual(props[PROPS.due].date, { start: '2026-11-05' });
  assert.deepEqual(props[PROPS.tags].multi_select, [{ name: 'shop' }]);
  assert.deepEqual(props[PROPS.project].rich_text, [], 'an absent field clears, not undefined');
});

test('a patch only sends the keys it was given', () => {
  const props = patchToProperties({ title: 'New title' });
  assert.deepEqual(Object.keys(props), [PROPS.title]);
  assert.deepEqual(Object.keys(patchToProperties({})), [],
    'an empty patch sends nothing, so a partial update never blanks a Notion edit');
});

test('completing stamps the Completed date and reopening clears it', () => {
  const done = patchToProperties({ status: 'Done' }) as Record<string, any>;
  assert.equal(done[PROPS.status].select.name, 'Done');
  assert.match(done[PROPS.completedAt].date.start, /^\d{4}-\d{2}-\d{2}$/);

  const reopened = patchToProperties({ status: 'Todo' }) as Record<string, any>;
  assert.equal(reopened[PROPS.completedAt].date, null);
});

test('clearing a due date sends null rather than omitting it', () => {
  const props = patchToProperties({ due: null }) as Record<string, any>;
  assert.equal(props[PROPS.due].date, null);
});

test('the schema offers exactly the values the app can produce', () => {
  const names = (prop: any) => prop.select.options.map((o: any) => o.name);
  assert.deepEqual(names(SCHEMA[PROPS.category]), [...CATEGORIES]);
  assert.deepEqual(names(SCHEMA[PROPS.priority]), [...PRIORITIES]);
  assert.deepEqual(names(SCHEMA[PROPS.status]), [...STATUSES]);
});

test('a category the user created — in the app or in Notion — is kept, not turned into Inbox', () => {
  const task = pageToTask(page({
    [PROPS.title]: { title: [{ plain_text: 'x' }] },
    [PROPS.category]: { select: { name: '  Research  ' } },
  }));
  assert.equal(task?.category, 'Research', 'kept, with stray spaces trimmed');

  const lower = pageToTask(page({
    [PROPS.title]: { title: [{ plain_text: 'x' }] },
    [PROPS.category]: { select: { name: 'work' } },
  }));
  assert.equal(lower?.category, 'Work', 'a built-in in other casing is not a second category');
});

test('R1-2: a Notion date with "Include time" becomes the local day', () => {
  const stamp = '2026-11-06T14:00:00.000+02:00';
  const task = pageToTask(page({
    [PROPS.title]: { title: [{ plain_text: 'timed' }] },
    [PROPS.due]: { date: { start: stamp } },
  }));
  assert.equal(task?.due, toISODate(new Date(stamp)));
  assert.match(task?.due ?? '', /^\d{4}-\d{2}-\d{2}$/);
});

test('R1-34: Completed is stamped with the local day, not the UTC one', (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Jerusalem';
  // 22:30 UTC on Friday is 00:30 on Saturday in Israel.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T22:30:00Z') });
  try {
    const done = patchToProperties({ status: 'Done' }) as Record<string, any>;
    assert.equal(done[PROPS.completedAt].date.start, '2026-11-07');
  } finally {
    t.mock.timers.reset();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
