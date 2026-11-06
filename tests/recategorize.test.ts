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
  assert.deepEqual(outcome, { done: 2, total: 2, changed: 2 });
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
  assert.deepEqual(outcome, { done: 1, total: 1, changed: 0 });
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
  assert.deepEqual(outcome, { done: 0, total: 0, changed: 0 });
});
