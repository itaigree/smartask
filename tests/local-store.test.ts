import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalRepository, readTasks, sanitizeStoredTask, exportBackup, importBackup,
  countLocalTasks, deviceStorageWorks, LocalStoreError, type KeyValueStore,
} from '../src/lib/local-store.ts';
import { toISODate } from '../src/lib/parse.ts';
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
  assert.deepEqual(importBackup(backup, target), { added: 2, skipped: 0, unreadable: 0 });
  assert.deepEqual(importBackup(backup, target), { added: 0, skipped: 2, unreadable: 0 }, 'idempotent');
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

test('R1-2: a restored task with a timestamp due date keeps its local day', () => {
  const stamp = '2026-11-08T10:00:00.000+02:00';
  const t = sanitizeStoredTask({ id: 'a', title: 'x', due: stamp, completedAt: '2026-11-07T23:30:00Z' });
  assert.equal(t?.due, toISODate(new Date(stamp)));
  assert.equal(t?.completedAt, toISODate(new Date('2026-11-07T23:30:00Z')));
  assert.equal(sanitizeStoredTask({ id: 'b', title: 'y', due: '2026-02-31' })?.due, null);
});

test('R1-38: a task twice in one backup is restored once, the repeat counted as skipped', async () => {
  const source = memoryStore();
  const { task } = await createLocalRepository(finance, source).captureTask('pay rent');
  const file = JSON.parse(exportBackup(source));
  file.tasks = [...file.tasks, { ...task, status: 'Done' }]; // two backups joined by hand

  const target = memoryStore();
  assert.deepEqual(importBackup(JSON.stringify(file), target), { added: 1, skipped: 1, unreadable: 0 });
  const repo = createLocalRepository(finance, target);
  assert.equal((await repo.listTasks()).length, 1);

  await repo.updateTask(task.id, { status: 'Done' });
  assert.equal((await repo.listTasks())[0].status, 'Done', 'a tick sticks after a reload');
});

test('R1-38: tasks already stored twice are read once, so a tick or delete acts on one task', async () => {
  const twice = { id: 'a', title: 'x', createdAt: '2026-11-01T10:00:00.000Z' };
  const store = memoryStore({
    'smartask.tasks.v1': JSON.stringify({ tasks: [twice, { ...twice, title: 'y' }] }),
  });
  const repo = createLocalRepository(finance, store);
  assert.deepEqual((await repo.listTasks()).map((t) => t.title), ['x'], 'the first copy wins');
  await repo.updateTask('a', { status: 'Done' });
  assert.equal(readTasks(store).length, 1);
  assert.equal(readTasks(store)[0].status, 'Done');
});

test('R1-39: entries that cannot be read are reported apart from tasks already here', async () => {
  const source = memoryStore();
  await createLocalRepository(finance, source).captureTask('valid');
  const file = JSON.parse(exportBackup(source));
  file.tasks.push({ id: 'no title' }, 'junk', null);

  const empty = memoryStore();
  assert.deepEqual(importBackup(JSON.stringify(file), empty), { added: 1, skipped: 0, unreadable: 3 },
    'nothing was here, so nothing is "already here"');
  assert.deepEqual(importBackup(JSON.stringify(file), empty), { added: 0, skipped: 1, unreadable: 3 });
});

test('R1-40: with site data blocked, phone-only storage reports it instead of crashing', async () => {
  const g = globalThis as { window?: unknown };
  g.window = {
    get localStorage(): never {
      throw new Error('SecurityError: Access is denied for this document.');
    },
  };
  try {
    assert.equal(deviceStorageWorks(), false, 'the choice screen can refuse phone-only up front');
    // The store is built while the board renders; that must not throw.
    const repo = createLocalRepository(finance);
    await assert.rejects(() => repo.listTasks(), LocalStoreError, 'a message, not a crash');
    assert.equal(countLocalTasks(), 0);
  } finally {
    delete g.window;
  }
});

test('R1-40: a browser that keeps data passes the storage check, and the probe is removed', () => {
  const g = globalThis as { window?: unknown };
  const data = new Map<string, string>();
  g.window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    },
  };
  try {
    assert.equal(deviceStorageWorks(), true);
    assert.equal(data.size, 0);
  } finally {
    delete g.window;
  }
});
