import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answeredByCompleting, calendarFile, fromLocalInput, googleCalendarUrl, isRinging, nextReminderAt, readReminder,
  reminderLabel, reminderPresets, rememberAnnounced, ringingTasks, toLocalInput, unannounced,
} from '../src/lib/reminders.ts';
import type { Task } from '../src/lib/types.ts';

const NOW = new Date(2026, 10, 17, 10, 0, 0); // Tuesday 17 November 2026, 10:00 local
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

let seq = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title: `task ${seq}`, category: 'Inbox', priority: 'Normal', status: 'Todo',
  due: null, project: null, tags: [], note: null, reminder: null,
  createdAt: '2026-11-06T06:00:00Z', completedAt: null, url: null, ...o,
});

test('a stored reminder is one exact moment, or nothing', () => {
  assert.equal(readReminder('2026-11-18T09:00:00+02:00'), '2026-11-18T07:00:00.000Z');
  assert.equal(readReminder('2026-11-18T07:00:00.000Z'), '2026-11-18T07:00:00.000Z');
  assert.equal(readReminder('2026-11-18 09:30'), at(18, 9, 30).toISOString(), 'a hand-edited backup');
  // A day with no time means that morning, here.
  assert.equal(readReminder('2026-11-18'), at(18, 9).toISOString());

  for (const bad of [null, undefined, 42, '', 'tomorrow', '2026-02-31', '2026-11-18Tnope', {}]) {
    assert.equal(readReminder(bad), null, `${JSON.stringify(bad)} is no reminder`);
  }
});

test('a reminder rings from its time until it is answered; done tasks never ring', () => {
  const past = task({ reminder: at(17, 9).toISOString() });
  const exactlyNow = task({ reminder: NOW.toISOString() });
  const future = task({ reminder: at(17, 11).toISOString() });
  const done = task({ reminder: at(17, 9).toISOString(), status: 'Done' });
  const none = task();

  assert.equal(isRinging(past, NOW), true);
  assert.equal(isRinging(exactlyNow, NOW), true);
  assert.equal(isRinging(future, NOW), false);
  assert.equal(isRinging(done, NOW), false);
  assert.equal(isRinging(none, NOW), false);
  assert.equal(isRinging(task({ reminder: 'garbage' }), NOW), false);
});

test('ringing reminders are listed longest-waiting first', () => {
  const yesterday = task({ reminder: at(16, 18).toISOString() });
  const thisMorning = task({ reminder: at(17, 9).toISOString() });
  const later = task({ reminder: at(17, 12).toISOString() });
  assert.deepEqual(
    ringingTasks([thisMorning, later, yesterday], NOW).map((t) => t.id),
    [yesterday.id, thisMorning.id],
  );
});

test('the board wakes for the next reminder still ahead, ignoring past and done ones', () => {
  const tasks = [
    task({ reminder: at(17, 9).toISOString() }), // already ringing
    task({ reminder: at(18, 9).toISOString() }),
    task({ reminder: at(17, 15).toISOString() }),
    task({ reminder: at(17, 11).toISOString(), status: 'Done' }),
    task(),
  ];
  assert.equal(nextReminderAt(tasks, NOW), at(17, 15).getTime());
  assert.equal(nextReminderAt([task(), tasks[0]], NOW), null);
});

test('the one-tap choices are all ahead of now and never repeat a moment', () => {
  const keys = (now: Date, due: string | null) => reminderPresets(now, due).map((p) => p.key);

  assert.deepEqual(keys(NOW, null), ['hour', 'evening', 'tomorrow']);
  assert.equal(reminderPresets(NOW, null)[0].at.getTime(), at(17, 11).getTime());
  assert.equal(reminderPresets(NOW, null)[1].at.getTime(), at(17, 18).getTime());
  assert.equal(reminderPresets(NOW, null)[2].at.getTime(), at(18, 9).getTime());

  // 19:00: this evening has passed, so it is not offered.
  assert.deepEqual(keys(at(17, 19), null), ['hour', 'tomorrow']);
  // 17:45: the evening is minutes away — "In 1 hour" is the useful choice.
  assert.deepEqual(keys(at(17, 17, 45), null), ['hour', 'tomorrow']);

  // Due on Friday the 20th: the evening before and that morning are added.
  const friday = reminderPresets(NOW, '2026-11-20');
  assert.deepEqual(friday.map((p) => p.key), ['hour', 'evening', 'tomorrow', 'before', 'due']);
  assert.equal(friday[3].at.getTime(), at(19, 18).getTime());
  assert.equal(friday[4].at.getTime(), at(20, 9).getTime());

  // Due tomorrow: "the evening before" is this evening and "that morning" is
  // tomorrow morning — each is offered once.
  assert.deepEqual(keys(NOW, '2026-11-18'), ['hour', 'evening', 'tomorrow']);
  // Already overdue: nothing about the due date is still ahead.
  assert.deepEqual(keys(NOW, '2026-11-10'), ['hour', 'evening', 'tomorrow']);

  for (const preset of [...reminderPresets(NOW, '2026-11-20'), ...reminderPresets(at(17, 23, 30), null)]) {
    assert.ok(preset.at.getTime() > 0 && preset.at.getSeconds() === 0, preset.key);
  }
  assert.ok(reminderPresets(at(17, 23, 30), null).every((p) => p.at > at(17, 23, 30)));
});

test('a reminder is labelled the way a person would say it', () => {
  const label = (date: Date) => reminderLabel(date.toISOString(), NOW, 'en-GB');
  assert.equal(label(at(17, 17)), 'Today 17:00');
  assert.equal(label(at(18, 9)), 'Tomorrow 09:00');
  assert.equal(label(at(16, 18, 30)), 'Yesterday 18:30');
  assert.equal(label(at(20, 9)), 'Friday 09:00');
  assert.equal(label(at(30, 9)), '30 Nov 09:00');
  assert.equal(label(new Date(2027, 0, 5, 9)), '5 Jan 2027 09:00');
  assert.equal(reminderLabel('garbage', NOW), '');
});

test('the date-and-time field round-trips in local time and refuses impossible values', () => {
  assert.equal(toLocalInput(at(18, 9, 5)), '2026-11-18T09:05');
  assert.equal(fromLocalInput('2026-11-18T09:05')?.getTime(), at(18, 9, 5).getTime());
  assert.equal(fromLocalInput(toLocalInput(NOW))?.getTime(), NOW.getTime());
  for (const bad of ['', '2026-11-18', '2026-02-31T09:00', '2026-11-18T25:00', 'soon']) {
    assert.equal(fromLocalInput(bad), null, bad);
  }
});

test('each device notifies once per reminder, and again when the reminder moves', () => {
  const a = task({ reminder: at(17, 9).toISOString() });
  const b = task({ reminder: at(17, 9, 30).toISOString() });

  assert.deepEqual(unannounced([a, b], {}).map((t) => t.id), [a.id, b.id]);
  const after = rememberAnnounced({}, [a, b], [a, b]);
  assert.deepEqual(unannounced([a, b], after), [], 'opening the app again does not buzz again');

  // Moved to a new time: when that comes, it is a new reminder.
  const moved = { ...a, reminder: at(17, 9, 45).toISOString() };
  assert.deepEqual(unannounced([moved, b], after).map((t) => t.id), [a.id]);

  // The record keeps only reminders that still exist as they were announced.
  const pruned = rememberAnnounced(after, [], [moved, { ...b, reminder: null }]);
  assert.deepEqual(pruned, {});
});

test('the Google Calendar link carries the title, the moment in UTC and the note', () => {
  const url = new URL(googleCalendarUrl('לשלם חשבון & more', new Date('2026-11-18T07:00:00Z'), 'bring ID'));
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), 'לשלם חשבון & more');
  assert.equal(url.searchParams.get('dates'), '20261118T070000Z/20261118T071500Z');
  assert.equal(url.searchParams.get('details'), 'bring ID');
  assert.equal(new URL(googleCalendarUrl('x', new Date('2026-11-18T07:00:00Z'))).searchParams.has('details'), false);
});

test('the calendar file is a valid event with an alarm at the moment itself', () => {
  const file = calendarFile(
    { id: 'abc', title: 'Pay rent; call, then \\ confirm', note: 'line one\nline two' },
    new Date('2026-11-18T07:00:00Z'),
    new Date('2026-11-17T08:00:00Z'),
  );
  const lines = file.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-2), 'END:VCALENDAR');
  assert.equal(lines.at(-1), '', 'ends with a line break');
  assert.ok(!file.replace(/\r\n/g, '').includes('\n'), 'every line break is CRLF');

  assert.ok(lines.includes('UID:abc-20261118T070000Z@smartask'));
  assert.ok(lines.includes('DTSTAMP:20261117T080000Z'));
  assert.ok(lines.includes('DTSTART:20261118T070000Z'));
  assert.ok(lines.includes('DTEND:20261118T071500Z'));
  assert.ok(lines.includes('SUMMARY:Pay rent\\; call\\, then \\\\ confirm'), 'special characters escaped');
  assert.ok(lines.includes('DESCRIPTION:line one\\nline two'));
  assert.ok(lines.includes('TRIGGER:PT0M'));
  assert.ok(lines.includes('ACTION:DISPLAY'));

  // Without a note there is no event description (the alarm keeps its own).
  const bare = calendarFile({ id: 'x', title: 't', note: null }, new Date('2026-11-18T07:00:00Z'), NOW);
  assert.equal(bare.split('\r\n').filter((l) => l.startsWith('DESCRIPTION:')).length, 1);
});

test('a long Hebrew title is folded at 75 bytes without splitting a letter', () => {
  const title = 'לשלם את חשבון החשמל ולהתקשר לחברת הביטוח לגבי הפוליסה החדשה של הרכב 🚗 עד סוף השבוע';
  const file = calendarFile({ id: 'x', title, note: null }, new Date('2026-11-18T07:00:00Z'), NOW);
  const encoder = new TextEncoder();
  for (const line of file.split('\r\n')) {
    assert.ok(encoder.encode(line).length <= 75, `line too long: ${line}`);
  }
  // Unfolding gives the title back whole.
  const unfolded = file.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`SUMMARY:${title}`));
});

test('completing a task answers its reminder: reopened later, it does not ring again', () => {
  const past = at(17, 9).toISOString();
  const ahead = at(17, 18).toISOString();
  // Done, and the time came: reopening drops it rather than ringing about the past.
  assert.equal(answeredByCompleting(task({ status: 'Done', reminder: past }), NOW), true);
  // Still ahead: the reopened task keeps its reminder.
  assert.equal(answeredByCompleting(task({ status: 'Done', reminder: ahead }), NOW), false);
  // Completing itself changes nothing, so a tick undone at once keeps the reminder.
  assert.equal(answeredByCompleting(task({ status: 'Todo', reminder: past }), NOW), false);
  assert.equal(answeredByCompleting(task({ status: 'Done' }), NOW), false);
});
