import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageToTask, newTaskToProperties, patchToProperties, PROPS, SCHEMA, listFilter, doneSince,
} from '../src/lib/notion-mapping.ts';
import { addDays, toISODate } from '../src/lib/parse.ts';
import { buildView } from '../src/lib/views.ts';
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
    [PROPS.category]: { select: { name: ' \u200F ' } },
    [PROPS.priority]: { select: null },
    // Status, Due, Tags, Note removed entirely.
  }));
  assert.equal(task?.title, 'Untitled task');
  assert.equal(task?.category, 'Inbox', 'a name with nothing visible in it falls back to Inbox');
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

test('R2-1: a Notion category longer than the app lets you type is kept, not read as Inbox', () => {
  const long = 'Thesis chapter 3 revisions for my supervisor';
  const task = pageToTask(page({
    [PROPS.title]: { title: [{ plain_text: 'x' }] },
    [PROPS.category]: { select: { name: long } },
  }));
  assert.equal(task?.category, long, 'so Sort with Gemini leaves it alone and the picker lists it');
});

test('R2-12: spacing inside a Notion category is kept, so writing it back matches the option', () => {
  const task = pageToTask(page({
    [PROPS.title]: { title: [{ plain_text: 'x' }] },
    [PROPS.category]: { select: { name: 'Side  Project' } },
  }));
  assert.equal(task?.category, 'Side  Project');
  const props = patchToProperties({ category: task!.category }) as Record<string, any>;
  assert.equal(props[PROPS.category].select.name, 'Side  Project');
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

/* R1-37 and R1-25: Done tasks, and which pages the list reads. */

/** Friday 6 November 2026, midday in Israel. */
const NOW = new Date(2026, 10, 6, 12, 0, 0);
const daysAgo = (n: number) => toISODate(addDays(NOW, -n));

function donePage(
  id: string,
  { completed = null, edited = '2026-11-06T09:00:00.000Z', status = 'Done' }:
    { completed?: string | null; edited?: string; status?: string | null } = {},
) {
  return page({
    [PROPS.title]: { title: [{ plain_text: id }] },
    [PROPS.status]: { select: status ? { name: status } : null },
    [PROPS.completedAt]: { date: completed ? { start: completed } : null },
  }, { id, last_edited_time: edited });
}

test('R1-37: a task set to Done in Notion itself is dated by its last edit', () => {
  const edited = '2026-03-10T12:00:00.000Z';
  const march = pageToTask(donePage('march', { edited }));
  assert.equal(march?.completedAt, toISODate(new Date(edited)), 'the local day of the last edit');

  const stamped = pageToTask(donePage('stamped', { completed: '2026-11-01', edited: '2026-11-05T12:00:00.000Z' }));
  assert.equal(stamped?.completedAt, '2026-11-01', 'a real Completed date always wins');

  const open = pageToTask(donePage('open', { status: 'Todo' }));
  assert.equal(open?.completedAt, null, 'an open task is never given a completion date');
});

test('R1-37: a task marked Done in Notion in March is not "done in the last 14 days"', () => {
  const tasks = [
    pageToTask(donePage('march', { edited: '2026-03-10T12:00:00.000Z' }))!,
    pageToTask(donePage('this week', { edited: '2026-11-04T12:00:00.000Z' }))!,
  ];
  const shown = buildView('done', tasks, NOW).groups.flatMap((g) => g.tasks.map((t) => t.title));
  assert.deepEqual(shown, ['this week']);
});

/**
 * Applies a query filter to a page the way Notion documents it, for the
 * conditions `listFilter` uses. A stand-in for the real API, which the tests
 * cannot reach.
 */
function matches(filter: any, pg: any): boolean {
  if (filter.or) return filter.or.some((f: any) => matches(f, pg));
  if (filter.and) return filter.and.every((f: any) => matches(f, pg));
  if (filter.timestamp) {
    const value = pg[filter.timestamp] as string;
    return value.slice(0, 10) >= filter[filter.timestamp].on_or_after;
  }
  const prop = pg.properties[filter.property];
  if (filter.select) {
    const name = prop?.select?.name ?? null;
    if ('is_empty' in filter.select) return name === null;
    return name !== null && name !== filter.select.does_not_equal;
  }
  if (filter.date) {
    const start = prop?.date?.start ?? null;
    if ('is_empty' in filter.date) return start === null;
    return start !== null && start.slice(0, 10) >= filter.date.on_or_after;
  }
  throw new Error(`unexpected filter ${JSON.stringify(filter)}`);
}

test('R1-25: the list reads every open task, however old, but only recent Done ones', () => {
  const filter = listFilter(NOW);
  const pages = {
    oldOpen: donePage('oldOpen', { status: 'Todo', edited: '2025-01-01T00:00:00.000Z' }),
    oldDoing: donePage('oldDoing', { status: 'Doing', edited: '2025-01-01T00:00:00.000Z' }),
    noStatus: donePage('noStatus', { status: null, edited: '2025-01-01T00:00:00.000Z' }),
    unknownStatus: donePage('unknownStatus', { status: 'Cancelled', edited: '2025-01-01T00:00:00.000Z' }),
    doneLastWeek: donePage('doneLastWeek', { completed: daysAgo(7), edited: '2025-01-01T00:00:00.000Z' }),
    doneLongAgo: donePage('doneLongAgo', { completed: '2025-06-01' }),
    doneInNotionRecently: donePage('doneInNotionRecently', { edited: '2026-11-04T12:00:00.000Z' }),
    doneInNotionInMarch: donePage('doneInNotionInMarch', { edited: '2026-03-10T12:00:00.000Z' }),
  };
  const read = Object.entries(pages).filter(([, pg]) => matches(filter, pg)).map(([name]) => name);
  assert.deepEqual(read, [
    'oldOpen', 'oldDoing', 'noStatus', 'unknownStatus', 'doneLastWeek', 'doneInNotionRecently',
  ]);
  assert.match(JSON.stringify(filter), /"Status"/);
  assert.match(JSON.stringify(filter), /"Completed"/);
});

test('R1-25: the list never leaves out a Done task the Done view would show', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Jerusalem';
  try {
    // 00:30 on Saturday in Israel is still Friday in UTC.
    const late = new Date(Date.parse('2026-11-06T22:30:00Z'));
    const since = doneSince(late);
    let shown = 0;
    for (let d = 0; d <= 30; d += 1) {
      const day = toISODate(addDays(late, -d));
      const task = pageToTask(donePage(`d${d}`, { completed: day }))!;
      if (buildView('done', [task], late).groups.length === 0) continue;
      shown += 1;
      assert.ok(day >= since, `${day} is in the Done view, so the list must read it`);
    }
    assert.ok(shown >= 14, 'the check covered the whole Done window');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
