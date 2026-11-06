import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalRepository, readTasks, sanitizeStoredTask, exportBackup, importBackup,
  countLocalTasks, LocalStoreError, type KeyValueStore,
} from '../src/lib/local-store.ts';
import { resolveStorageMode, loadLocalChosen } from '../src/lib/config.ts';
import type { Categorizer } from '../src/lib/categorize/index.ts';

/** localStorage stand-in. `full` makes every write throw, like a quota error. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore & { full: boolean; data: Map<string, string> } = {
    full: false,
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (store.full) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
  };
  return store;
}

const finance: Categorizer = {
  name: 'stub',
  async categorize() {
    return { category: 'Finance', confidence: 0.9, reason: 'stub', source: 'gemini' };
  },
};

test('a captured task is categorized, stored, and listed back', async () => {
  const store = memoryStore();
  const repo = createLocalRepository(finance, store);

  const { task, signal } = await repo.captureTask('pay rent friday !!');
  assert.equal(task.title, 'pay rent');
  assert.equal(task.category, 'Finance');
  assert.equal(task.priority, 'Urgent');
  assert.equal(signal.source, 'gemini', 'the classifier verdict comes back for the UI');
  assert.equal(task.url, null, 'no Notion page to link to');

  const listed = await repo.listTasks();
  assert.deepEqual(listed.map((t) => t.id), [task.id]);
});

test('tasks survive a fresh repository — that is, an app reload', async () => {
  const store = memoryStore();
  await createLocalRepository(finance, store).captureTask('one');
  await createLocalRepository(finance, store).captureTask('two');
  const titles = (await createLocalRepository(finance, store).listTasks()).map((t) => t.title);
  assert.deepEqual(titles.sort(), ['one', 'two']);
});

test('completing stamps a date and reopening clears it, like the Notion store', async () => {
  const store = memoryStore();
  const repo = createLocalRepository(finance, store);
  const { task } = await repo.captureTask('x');

  const done = await repo.updateTask(task.id, { status: 'Done' });
  assert.match(done.completedAt ?? '', /^\d{4}-\d{2}-\d{2}$/);
  const reopened = await repo.updateTask(task.id, { status: 'Todo' });
  assert.equal(reopened.completedAt, null);

  const renamed = await repo.updateTask(task.id, { category: 'Home' });
  assert.equal(renamed.category, 'Home');
  assert.equal((await repo.listTasks())[0].category, 'Home', 'and it is persisted');
});

test('deleting removes the task for good', async () => {
  const store = memoryStore();
  const repo = createLocalRepository(finance, store);
  const { task } = await repo.captureTask('x');
  await repo.archiveTask(task.id);
  assert.deepEqual(await repo.listTasks(), []);
});

test('updating a task that is gone says so plainly', async () => {
  const repo = createLocalRepository(finance, memoryStore());
  await assert.rejects(() => repo.updateTask('nope', { status: 'Done' }), LocalStoreError);
});

test('a full device gives a clear message, not a raw browser error', async () => {
  const store = memoryStore();
  store.full = true;
  const repo = createLocalRepository(finance, store);
  await assert.rejects(
    () => repo.captureTask('x'),
    (e: Error) => e instanceof LocalStoreError && /out of browser storage/.test(e.message),
  );
});

test('corrupt storage starts empty instead of crashing every launch', () => {
  assert.deepEqual(readTasks(memoryStore({ 'smartask.tasks.v1': '{not json' })), []);
  assert.deepEqual(readTasks(memoryStore({ 'smartask.tasks.v1': '{"tasks": 7}' })), []);
});

test('malformed stored tasks are dropped or repaired, never trusted', () => {
  assert.equal(sanitizeStoredTask(null), null);
  assert.equal(sanitizeStoredTask({ id: 'a' }), null, 'no title');
  assert.equal(sanitizeStoredTask({ title: 'x' }), null, 'no id');
  const repaired = sanitizeStoredTask({ id: 'a', title: 'x', category: 42, due: 'soon' });
  assert.equal(repaired?.category, 'Inbox', 'a non-name falls back to Inbox');
  assert.equal(sanitizeStoredTask({ id: 'b', title: 'y', category: 'Research' })?.category, 'Research',
    'a custom category survives a reload');
  assert.equal(repaired?.due, null);
  assert.equal(repaired?.url, null);
});

test('a backup round-trips, and restoring it twice adds nothing', async () => {
  const source = memoryStore();
  const repo = createLocalRepository(finance, source);
  await repo.captureTask('לשלם חשבון חשמל');
  await repo.captureTask('second');
  const backup = exportBackup(source);

  const target = memoryStore();
  assert.deepEqual(importBackup(backup, target), { added: 2, skipped: 0 });
  assert.deepEqual(importBackup(backup, target), { added: 0, skipped: 2 }, 'idempotent');
  assert.equal(countLocalTasks(target), 2);
  assert.ok(readTasks(target).some((t) => t.title === 'לשלם חשבון חשמל'), 'Hebrew survives');
});

test('restoring an old backup never deletes tasks created since', async () => {
  const store = memoryStore();
  const repo = createLocalRepository(finance, store);
  await repo.captureTask('old');
  const backup = exportBackup(store);
  await repo.captureTask('new since the backup');
  importBackup(backup, store);
  assert.deepEqual((await repo.listTasks()).map((t) => t.title).sort(), ['new since the backup', 'old']);
});

test('a file that is not a backup is refused', () => {
  const store = memoryStore();
  assert.throws(() => importBackup('hello', store), LocalStoreError);
  assert.throws(() => importBackup('{"tasks": []}', store), LocalStoreError, 'missing format marker');
});

test('Notion credentials always win, so a connected user never sees the new choice', () => {
  const notion = { token: 'ntn_x', databaseId: 'db' };
  assert.equal(resolveStorageMode(notion, false), 'notion');
  assert.equal(resolveStorageMode(notion, true), 'notion', 'even if local was once chosen');
  assert.equal(resolveStorageMode(null, true), 'local');
  assert.equal(resolveStorageMode(null, false), null, 'first launch: ask');
  assert.equal(loadLocalChosen(), false, 'no browser: nothing chosen, no crash');
});
