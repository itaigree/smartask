import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeRead, forgetOldWrites, replaceTask, restoreTask, ledgerTask, READ_GRACE_MS, FORGET_AFTER_MS,
  type RecentWrite,
} from '../src/lib/board-sync.ts';
import { cached, invalidate } from '../src/lib/cache.ts';
import type { Task } from '../src/lib/types.ts';

let seq = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title: `task ${seq}`, category: 'Inbox', priority: 'Normal', status: 'Todo',
  due: null, project: null, tags: [], note: null,
  createdAt: '2026-11-06T06:00:00Z', completedAt: null, url: null, ...o,
});
const T0 = 1_000_000;

test('R1-5: a read that started before a write cannot undo it', () => {
  const a = task({ title: 'a' });
  const b = task({ title: 'b' });
  const added = task({ title: 'new' });
  const writes = new Map<string, RecentWrite>([
    [a.id, { task: { ...a, status: 'Done' }, at: T0 + 500, pending: false }], // ticked
    [b.id, { task: null, at: T0 + 600, pending: false }], // deleted
    [added.id, { task: added, at: T0 + 700, pending: false }], // added
  ]);
  const merged = mergeRead([a, b], writes, T0);
  assert.deepEqual(merged.map((t) => `${t.title}:${t.status}`), ['new:Todo', 'a:Done']);
});

test('a pending write wins over any read; a long-finished one does not', () => {
  const a = task({ title: 'a', category: 'Inbox' });
  const pending = new Map<string, RecentWrite>([
    [a.id, { task: { ...a, category: 'Home' }, at: T0 - 10 * READ_GRACE_MS, pending: true }],
  ]);
  assert.equal(mergeRead([a], pending, T0)[0].category, 'Home');

  const old = new Map<string, RecentWrite>([
    [a.id, { task: { ...a, category: 'Home' }, at: T0 - READ_GRACE_MS - 1, pending: false }],
  ]);
  const fromNotion = { ...a, category: 'Work' }; // changed in Notion since
  assert.equal(mergeRead([fromNotion], old, T0)[0].category, 'Work');
});

test('no recent writes: the read is taken as is', () => {
  const list = [task(), task()];
  assert.deepEqual(mergeRead(list, new Map(), T0), list);
});

test('old finished writes are forgotten, pending ones never', () => {
  const writes = new Map<string, RecentWrite>([
    ['old', { task: null, at: T0 - FORGET_AFTER_MS - 1, pending: false }],
    ['fresh', { task: null, at: T0 - 5, pending: false }],
    ['waiting', { task: null, at: T0 - 10 * FORGET_AFTER_MS, pending: true }],
  ]);
  forgetOldWrites(writes, T0);
  assert.deepEqual([...writes.keys()], ['fresh', 'waiting']);
});

test('R1-6: a failed write touches only its own task', () => {
  const a = task({ title: 'a' });
  const b = task({ title: 'b', status: 'Done' }); // saved meanwhile
  const list = [{ ...a, status: 'Done' as const }, b];
  const reverted = replaceTask(list, a.id, a);
  assert.deepEqual(reverted.map((t) => `${t.title}:${t.status}`), ['a:Todo', 'b:Done']);

  const c = task({ title: 'c' });
  assert.deepEqual(restoreTask([a, b], c, 1).map((t) => t.title), ['a', 'c', 'b']);
  assert.deepEqual(restoreTask([a, c], c, 0).map((t) => t.title), ['a', 'c'], 'never twice');
});

test('R1-5: a read in flight during a write is not cached afterwards', async () => {
  let reads = 0;
  let release!: () => void;
  const slow = cached('k', 20_000, () => new Promise<number>((resolve) => {
    reads += 1;
    release = () => resolve(1);
  }));
  invalidate(); // a write lands while the read is in flight
  release();
  assert.equal(await slow, 1, 'the caller still gets its answer');
  assert.equal(await cached('k', 20_000, async () => { reads += 1; return 2; }), 2,
    'but the next read goes to the store');
  assert.equal(reads, 2);
});

test('device storage (grace 0): a read that started after a write shows changes made elsewhere', () => {
  const a = task({ title: 'a', category: 'Inbox' });
  const writes = new Map<string, RecentWrite>([
    [a.id, { task: a, at: T0 - 1, pending: false }], // written here just before the read
  ]);
  const movedInOtherCopy = { ...a, category: 'Home' };
  assert.equal(mergeRead([movedInOtherCopy], writes, T0, 0)[0].category, 'Home');
  assert.deepEqual(mergeRead([], writes, T0, 0), [], 'deleted in the other copy: not brought back');
  // ...but a read that started before the write still cannot undo it.
  const later = new Map<string, RecentWrite>([[a.id, { task: movedInOtherCopy, at: T0 + 1, pending: false }]]);
  assert.equal(mergeRead([a], later, T0, 0)[0].category, 'Home');
});

test('a ledger shows the confirmed task with every queued change applied', () => {
  const a = task({ title: 'a', category: 'Inbox', status: 'Todo' });
  const ledger = {
    confirmed: a,
    confirmedAt: T0,
    pending: [{ seq: 1, patch: { category: 'Home' } }, { seq: 2, patch: { status: 'Done' as const } }],
    tail: Promise.resolve(),
    index: 0,
  };
  const shown = ledgerTask(ledger);
  assert.equal(shown?.category, 'Home');
  assert.equal(shown?.status, 'Done');
  // The first change fails: only it is dropped, the second still shows.
  ledger.pending = ledger.pending.slice(1);
  assert.equal(ledgerTask(ledger)?.category, 'Inbox');
  assert.equal(ledgerTask(ledger)?.status, 'Done');
  assert.equal(ledgerTask({ ...ledger, pending: [{ seq: 3, patch: null }] }), null, 'a queued delete');
});
