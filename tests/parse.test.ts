import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, toISODate, addDays } from '../src/lib/parse.ts';

/** Wednesday 2026-11-04, so weekday maths is deterministic. */
const NOW = new Date(2026, 10, 4, 9, 0, 0);
const iso = (days: number) => toISODate(addDays(NOW, days));

test('plain text with no tokens becomes a Normal, undated task', () => {
  const d = parseTask('write the quarterly summary', NOW);
  assert.equal(d.title, 'write the quarterly summary');
  assert.equal(d.due, null);
  assert.equal(d.priority, 'Normal');
  assert.equal(d.project, null);
  assert.deepEqual(d.tags, []);
  assert.equal(d.note, null);
});

test('the PLAN.md acceptance case', () => {
  const d = parseTask('pay rent friday !! #home @bills', NOW);
  assert.equal(d.title, 'pay rent');
  assert.equal(d.due, iso(2)); // Wed -> Fri
  assert.equal(d.priority, 'Urgent');
  assert.equal(d.project, 'home');
  assert.deepEqual(d.tags, ['bills']);
});

test('relative dates', () => {
  assert.equal(parseTask('x today', NOW).due, iso(0));
  assert.equal(parseTask('x tomorrow', NOW).due, iso(1));
  assert.equal(parseTask('x day after tomorrow', NOW).due, iso(2));
  assert.equal(parseTask('x in 3 days', NOW).due, iso(3));
  assert.equal(parseTask('x in 2 weeks', NOW).due, iso(14));
  assert.equal(parseTask('x next week', NOW).due, iso(7));
});

test('weekday names resolve to the next occurrence, today included', () => {
  assert.equal(parseTask('x wednesday', NOW).due, iso(0), 'today is Wednesday');
  assert.equal(parseTask('x on monday', NOW).due, iso(5));
  assert.equal(parseTask('x next monday', NOW).due, iso(12));
});

test('explicit date formats', () => {
  assert.equal(parseTask('x 2026-12-25', NOW).due, '2026-12-25');
  assert.equal(parseTask('x 25/12', NOW).due, '2026-12-25');
  assert.equal(parseTask('x dec 25', NOW).due, '2026-12-25');
  assert.equal(parseTask('x 25 dec', NOW).due, '2026-12-25');
});

test('a bare day/month that already passed rolls to next year', () => {
  assert.equal(parseTask('x 3/1', NOW).due, '2027-01-03');
});

test('priority notation', () => {
  assert.equal(parseTask('x !', NOW).priority, 'High');
  assert.equal(parseTask('x !!', NOW).priority, 'Urgent');
  assert.equal(parseTask('fix this asap', NOW).priority, 'Urgent');
  assert.equal(parseTask('read it someday', NOW).priority, 'Low');
});

test('bang notation is stripped from the title', () => {
  assert.equal(parseTask('ship the release !!', NOW).title, 'ship the release');
});

test('multiple tags, de-duplicated, last project wins', () => {
  const d = parseTask('plan trip @travel @budget @travel #q4 #holiday', NOW);
  assert.deepEqual(d.tags, ['travel', 'budget']);
  assert.equal(d.project, 'holiday');
  assert.equal(d.title, 'plan trip');
});

test('text after a newline or " // " becomes the note', () => {
  assert.equal(parseTask('call plumber\nring the side door', NOW).note, 'ring the side door');
  assert.equal(parseTask('call plumber // ring the side door', NOW).note, 'ring the side door');
});

test('a date phrase does not leave dangling filler in the title', () => {
  assert.equal(parseTask('call the bank about the overdraft tomorrow', NOW).title,
    'call the bank about the overdraft');
  assert.equal(parseTask('send invoice by friday', NOW).title, 'send invoice');
});

test('tokens are never mistaken for dates', () => {
  assert.equal(parseTask('review notes #dec', NOW).due, null);
  assert.equal(parseTask('review notes @monday', NOW).due, null);
});

test('an empty-ish input still yields a title', () => {
  assert.equal(parseTask('tomorrow', NOW).title, 'tomorrow');
});
