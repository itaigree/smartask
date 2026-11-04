import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/lib/types.ts';
import { toISODate, addDays } from '../src/lib/parse.ts';
import {
  buildView, focusScore, countTasks, daysUntilDue, isOverdue, FOCUS_SIZE,
} from '../src/lib/views.ts';

const NOW = new Date(2026, 10, 4, 9, 0, 0); // Wednesday
const iso = (days: number) => toISODate(addDays(NOW, days));

let seq = 0;
function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    title: `task ${seq}`,
    category: 'Inbox',
    priority: 'Normal',
    status: 'Todo',
    due: null,
    project: null,
    tags: [],
    note: null,
    createdAt: NOW.toISOString(),
    completedAt: null,
    url: null,
    ...overrides,
  };
}

const titles = (groups: { tasks: Task[] }[]) => groups.flatMap((g) => g.tasks.map((t) => t.title));

test('daysUntilDue and isOverdue', () => {
  assert.equal(daysUntilDue(task({ due: iso(0) }), NOW), 0);
  assert.equal(daysUntilDue(task({ due: iso(3) }), NOW), 3);
  assert.equal(daysUntilDue(task({ due: iso(-2) }), NOW), -2);
  assert.equal(daysUntilDue(task(), NOW), null);
  assert.equal(isOverdue(task({ due: iso(-1) }), NOW), true);
  assert.equal(isOverdue(task({ due: iso(0) }), NOW), false);
  assert.equal(isOverdue(task({ due: iso(-1), status: 'Done' }), NOW), false,
    'a completed task is never overdue');
});

test('an overdue Low task outranks a Normal task due next week', () => {
  const overdue = task({ priority: 'Low', due: iso(-1) });
  const later = task({ priority: 'Normal', due: iso(6) });
  assert.ok(focusScore(overdue, NOW) > focusScore(later, NOW));
});

test('focus score rises with priority, urgency and age', () => {
  assert.ok(focusScore(task({ priority: 'Urgent' }), NOW) > focusScore(task({ priority: 'Low' }), NOW));
  assert.ok(focusScore(task({ due: iso(0) }), NOW) > focusScore(task({ due: iso(5) }), NOW));
  const old = task({ createdAt: addDays(NOW, -10).toISOString() });
  assert.ok(focusScore(old, NOW) > focusScore(task(), NOW));
});

test('age credit is capped so stale tasks cannot outrank urgent ones', () => {
  const ancient = task({ priority: 'Low', createdAt: addDays(NOW, -400).toISOString() });
  const urgentToday = task({ priority: 'Urgent', due: iso(0) });
  assert.ok(focusScore(urgentToday, NOW) > focusScore(ancient, NOW));
});

test('an in-progress task gets a nudge over an identical untouched one', () => {
  assert.ok(focusScore(task({ status: 'Doing' }), NOW) > focusScore(task(), NOW));
});

test('focus returns at most FOCUS_SIZE open tasks, best first', () => {
  const tasks = [
    task({ title: 'low', priority: 'Low' }),
    task({ title: 'urgent-overdue', priority: 'Urgent', due: iso(-3) }),
    task({ title: 'normal-today', due: iso(0) }),
    task({ title: 'done', status: 'Done', priority: 'Urgent', due: iso(-5) }),
    ...Array.from({ length: 8 }, () => task({ priority: 'Low' })),
  ];
  const view = buildView('focus', tasks, NOW);
  const picked = titles(view.groups);
  assert.equal(picked.length, FOCUS_SIZE);
  assert.equal(picked[0], 'urgent-overdue');
  assert.equal(picked[1], 'normal-today');
  assert.ok(!picked.includes('done'), 'completed tasks never appear in focus');
});

test('today separates overdue from due-today and excludes future work', () => {
  const view = buildView('today', [
    task({ title: 'late', due: iso(-2) }),
    task({ title: 'now', due: iso(0) }),
    task({ title: 'later', due: iso(2) }),
    task({ title: 'undated' }),
  ], NOW);
  assert.deepEqual(view.groups.map((g) => g.label), ['Overdue', 'Today']);
  assert.deepEqual(titles(view.groups), ['late', 'now']);
});

test('upcoming groups by day within a week and labels today/tomorrow', () => {
  const view = buildView('upcoming', [
    task({ title: 'tmr-a', due: iso(1) }),
    task({ title: 'tmr-b', due: iso(1), priority: 'Urgent' }),
    task({ title: 'in5', due: iso(5) }),
    task({ title: 'in30', due: iso(30) }),
    task({ title: 'past', due: iso(-1) }),
    task({ title: 'nodate' }),
  ], NOW);
  const labels = view.groups.map((g) => g.label);
  assert.equal(labels[0], 'Tomorrow');
  assert.equal(labels.at(-1), 'No date');
  assert.deepEqual(view.groups[0].tasks.map((t) => t.title), ['tmr-b', 'tmr-a'],
    'within a day, higher focus first');
  const shown = titles(view.groups);
  assert.ok(!shown.includes('in30'), 'beyond the 7-day horizon is excluded');
  assert.ok(!shown.includes('past'), 'overdue belongs to Today, not Upcoming');
});

test('categories groups open tasks and drops empty categories', () => {
  const view = buildView('categories', [
    task({ title: 'w', category: 'Work' }),
    task({ title: 'f', category: 'Finance' }),
    task({ title: 'closed', category: 'Home', status: 'Done' }),
  ], NOW);
  assert.deepEqual(view.groups.map((g) => g.label), ['Work', 'Finance']);
});

test('done shows recent completions newest first and drops old ones', () => {
  const view = buildView('done', [
    task({ title: 'yesterday', status: 'Done', completedAt: iso(-1) }),
    task({ title: 'last week', status: 'Done', completedAt: iso(-6) }),
    task({ title: 'ancient', status: 'Done', completedAt: iso(-60) }),
    task({ title: 'open' }),
  ], NOW);
  assert.deepEqual(titles(view.groups), ['yesterday', 'last week']);
});

test('every view reports empty rather than throwing', () => {
  for (const id of ['focus', 'today', 'upcoming', 'categories', 'done'] as const) {
    const view = buildView(id, [], NOW);
    assert.deepEqual(view.groups, []);
    assert.ok(view.emptyMessage.length > 0);
  }
});

test('counts drive the tab badges', () => {
  const counts = countTasks([
    task({ due: iso(-1) }),
    task({ due: iso(0) }),
    task({ due: iso(4) }),
    task({ status: 'Done', completedAt: iso(0) }),
  ], NOW);
  assert.deepEqual(counts, { open: 3, overdue: 1, today: 2, done: 1 });
});
