import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortInbox, inboxTasks } from '../src/lib/recategorize.ts';
import type { CategorySignal } from '../src/lib/categorize/index.ts';
import type { Category, Task } from '../src/lib/types.ts';

let seq = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title: `task ${seq}`, category: 'Inbox', priority: 'Normal', status: 'Todo',
  due: null, project: null, tags: [], note: null,
  createdAt: '2026-11-06T06:00:00Z', completedAt: null, url: null, ...o,
});

const answer = (category: Category): CategorySignal =>
  ({ category, confidence: 0.9, reason: 'test', source: 'gemini' });

const noSleep = async () => {};

test('only open Inbox tasks are worked through', () => {
  const list = [
    task({ title: 'a' }),
    task({ title: 'b', category: 'Work' }),
    task({ title: 'c', status: 'Done' }),
  ];
  assert.deepEqual(inboxTasks(list).map((t) => t.title), ['a']);
});

test('each Inbox task is reclassified and saved', async () => {
  const list = [task({ title: 'בקשה אתית' }), task({ title: 'לכתוב ליואל' })];
  const verdicts: Record<string, Category> = { 'בקשה אתית': 'Work', 'לכתוב ליואל': 'Personal' };
  const saved: Array<[string, Category]> = [];

  const outcome = await sortInbox(
    list,
    async (input) => answer(verdicts[input.title]),
    async (t, category) => { saved.push([t.title, category]); return { ...t, category }; },
    { sleep: noSleep },
  );

  assert.deepEqual(saved, [['בקשה אתית', 'Work'], ['לכתוב ליואל', 'Personal']]);
  assert.deepEqual(outcome, { done: 2, total: 2, changed: 2, skipped: 0 });
});

test('a task Gemini still calls Inbox is left alone, not rewritten', async () => {
  let writes = 0;
  const outcome = await sortInbox(
    [task()],
    async () => answer('Inbox'),
    async (t) => { writes += 1; return t; },
    { sleep: noSleep },
  );
  assert.equal(writes, 0);
  assert.deepEqual(outcome, { done: 1, total: 1, changed: 0, skipped: 0 });
});

test('the first Gemini failure stops the run and says why', async () => {
  let calls = 0;
  const outcome = await sortInbox(
    [task(), task(), task()],
    async () => {
      calls += 1;
      if (calls === 2) throw new Error('Gemini rate limit reached.');
      return answer('Work');
    },
    async (t, category) => ({ ...t, category }),
    { sleep: noSleep },
  );
  assert.equal(calls, 2, 'it does not keep hammering a refusing API');
  assert.equal(outcome.changed, 1);
  assert.equal(outcome.done, 1);
  assert.match(outcome.stoppedReason ?? '', /rate limit/);
});

test('a Notion write failure also stops the run', async () => {
  const outcome = await sortInbox(
    [task(), task()],
    async () => answer('Work'),
    async () => { throw new Error('Notion is rate limiting'); },
    { sleep: noSleep },
  );
  assert.equal(outcome.changed, 0);
  assert.match(outcome.stoppedReason ?? '', /Notion/);
});

test('calls are spaced out for the free tier, and progress is reported', async () => {
  const waits: number[] = [];
  const progress: number[] = [];
  await sortInbox(
    [task(), task(), task()],
    async () => answer('Home'),
    async (t, category) => ({ ...t, category }),
    { delayMs: 1500, sleep: async (ms) => { waits.push(ms); }, onProgress: (p) => progress.push(p.done) },
  );
  assert.deepEqual(waits, [1500, 1500], 'a gap between calls, none before the first');
  assert.deepEqual(progress, [1, 2, 3]);
});

test('an empty Inbox is a no-op', async () => {
  const outcome = await sortInbox(
    [task({ category: 'Work' })],
    async () => { throw new Error('should not be called'); },
    async (t) => t,
    { sleep: noSleep },
  );
  assert.deepEqual(outcome, { done: 0, total: 0, changed: 0, skipped: 0 });
});

test('R1-7: a task moved, completed or deleted during the run is skipped, not overwritten', async () => {
  const a = task({ title: 'a' });
  const b = task({ title: 'b' });
  const c = task({ title: 'c' });
  const d = task({ title: 'd' });
  const live = new Map([a, b, c, d].map((t) => [t.id, t]));
  const saved: string[] = [];

  const outcome = await sortInbox(
    [a, b, c, d],
    async (input) => {
      // While Gemini thinks about "a", the user files "b" by hand, ticks "c"
      // and deletes "d".
      if (input.title === 'a') {
        live.set(b.id, { ...b, category: 'Home' });
        live.set(c.id, { ...c, status: 'Done' });
        live.delete(d.id);
      }
      return answer('Errands');
    },
    async (t, category) => {
      saved.push(`${t.title}:${category}`);
      return { ...t, category };
    },
    { sleep: noSleep, current: (id) => live.get(id) },
  );

  assert.deepEqual(saved, ['a:Errands'], 'only the untouched task is written');
  assert.equal(outcome.stoppedReason, undefined, 'a deleted task does not stop the run');
  assert.deepEqual(outcome, { done: 4, total: 4, changed: 1, skipped: 3 });
});

test('R1-7: the user filing a task while Gemini answers it wins', async () => {
  const a = task({ title: 'a' });
  const live = new Map([[a.id, a]]);
  const saved: string[] = [];
  await sortInbox(
    [a],
    async () => {
      live.set(a.id, { ...a, category: 'Home' });
      return answer('Errands');
    },
    async (t, category) => {
      saved.push(category);
      return t;
    },
    { sleep: noSleep, current: (id) => live.get(id) },
  );
  assert.deepEqual(saved, []);
});

test('R1-26/R3-4: an aborted run stops before the next request or write', async () => {
  const controller = new AbortController();
  const list = [task({ title: 'a' }), task({ title: 'b' }), task({ title: 'c' })];
  const asked: string[] = [];
  const saved: string[] = [];
  const outcome = await sortInbox(
    list,
    async (input) => {
      asked.push(input.title);
      if (input.title === 'a') controller.abort(); // key removed, board closed, or ⏻
      return answer('Work');
    },
    async (t, category) => {
      saved.push(t.title);
      return { ...t, category };
    },
    { sleep: noSleep, signal: controller.signal },
  );
  assert.deepEqual(asked, ['a']);
  assert.deepEqual(saved, [], 'not even the answer already in hand is written');
  assert.equal(outcome.cancelled, true);
});
