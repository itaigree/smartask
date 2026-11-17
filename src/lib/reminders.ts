import { addDays, toISODate } from './parse.ts';
import type { Task } from './types.ts';

/**
 * Reminders: one optional moment per task.
 *
 * A reminder is stored on the task, so it follows the task to Notion and to a
 * backup file. It stays there until the user answers it — "Got it", a new
 * time, or completing the task — which is what lets one that came due while
 * the app was closed still be waiting when it opens. There is no server to
 * push it (PLAN.md decision 6b), so the app can only speak up while it runs;
 * the calendar hand-off below is for a reminder that must not be missed.
 *
 * Pure and clock-injected, like the rest of the logic (PLAN.md decision 4).
 * The browser side — permission, the service worker — lives in notify.ts.
 */

/** The hour a reminder gets when only a day is known ("the morning of"). */
export const MORNING_HOUR = 9;
/** The hour for "this evening" and "the evening before". */
export const EVENING_HOUR = 18;

/**
 * A stored reminder as an ISO instant in UTC, or null.
 *
 * Notion returns the time with its own offset, and a date typed there with
 * "Include time" off has no time at all: that one means the morning of that
 * day, here. Anything unreadable is no reminder — never a crash, never a
 * reminder at a made-up time.
 */
export function readReminder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), MORNING_HOUR)
    : /^\d{4}-\d{2}-\d{2}[Tt ]/.test(text)
      ? new Date(text.replace(' ', 'T'))
      : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  // 31/02 rolls over in `new Date`; a day that does not exist is refused instead.
  if (day && date.getDate() !== Number(day[3])) return null;
  return date.toISOString();
}

/** The reminder as a time in milliseconds, or null when there is none. */
export function reminderTime(task: Pick<Task, 'reminder'>): number | null {
  if (!task.reminder) return null;
  const time = new Date(task.reminder).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Its time has come and nobody has answered it yet. Done tasks never ring. */
export function isRinging(task: Task, now: Date): boolean {
  const time = reminderTime(task);
  return time !== null && task.status !== 'Done' && time <= now.getTime();
}

/** Every reminder waiting for an answer, the one that has waited longest first. */
export function ringingTasks(tasks: readonly Task[], now: Date): Task[] {
  return tasks
    .filter((t) => isRinging(t, now))
    .sort((a, b) => reminderTime(a)! - reminderTime(b)!);
}

/** When the next reminder comes due, so the board can wake itself then; null when none is set. */
export function nextReminderAt(tasks: readonly Task[], now: Date): number | null {
  let next: number | null = null;
  for (const task of tasks) {
    const time = reminderTime(task);
    if (time === null || task.status === 'Done' || time <= now.getTime()) continue;
    if (next === null || time < next) next = time;
  }
  return next;
}

export interface ReminderPreset {
  key: string;
  label: string;
  at: Date;
}

function atHour(day: Date, hour: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
}

/**
 * The one-tap choices offered for a task. Only moments still ahead are
 * offered, and two choices never mean the same moment — a task due tomorrow
 * gets "Tomorrow morning" once, not twice.
 */
export function reminderPresets(now: Date, due: string | null): ReminderPreset[] {
  const inAnHour = new Date(now.getTime() + 60 * 60_000);
  inAnHour.setSeconds(0, 0);

  const candidates: ReminderPreset[] = [
    { key: 'hour', label: 'In 1 hour', at: inAnHour },
    { key: 'evening', label: 'This evening', at: atHour(now, EVENING_HOUR) },
    { key: 'tomorrow', label: 'Tomorrow morning', at: atHour(addDays(now, 1), MORNING_HOUR) },
  ];

  const dueDay = due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T00:00:00`) : null;
  if (dueDay && !Number.isNaN(dueDay.getTime())) {
    candidates.push(
      { key: 'before', label: 'The evening before it is due', at: atHour(addDays(dueDay, -1), EVENING_HOUR) },
      { key: 'due', label: 'The morning it is due', at: atHour(dueDay, MORNING_HOUR) },
    );
  }

  // A choice minutes away is not worth a button: "In 1 hour" already covers it.
  const earliest = now.getTime() + 30 * 60_000;
  const seen = new Set<number>();
  return candidates.filter(({ key, at }) => {
    if (key !== 'hour' && at.getTime() < earliest) return false;
    if (seen.has(at.getTime())) return false;
    seen.add(at.getTime());
    return true;
  });
}

/** Whole days from today to the day `date` falls on, in local time. */
function dayOffset(date: Date, now: Date): number {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((to - from) / 86_400_000);
}

/** "Today 17:00", "Tomorrow 09:00", "Friday 09:00", "18 Nov 09:00" — the way a person says it. */
export function reminderLabel(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const offset = dayOffset(date, now);
  let day: string;
  if (offset === 0) day = 'Today';
  else if (offset === 1) day = 'Tomorrow';
  else if (offset === -1) day = 'Yesterday';
  else if (offset > 1 && offset <= 6) day = date.toLocaleDateString(locale, { weekday: 'long' });
  else {
    day = date.toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
  }
  return `${day} ${time}`;
}

/** A date as a `datetime-local` input wants it: local time, `YYYY-MM-DDTHH:mm`. */
export function toLocalInput(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${toISODate(date)}T${hh}:${mm}`;
}

/** What a `datetime-local` input holds, as a date; null while it is empty or half-typed. */
export function fromLocalInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  // An impossible day or time is refused, not rolled into the next one.
  return date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour
    ? date
    : null;
}

/* ------------------------------------------------------------------ *
 * Which reminders this device has already notified about
 * ------------------------------------------------------------------ */

/**
 * Task id -> the reminder time this device last showed a notification for.
 * A ringing reminder stays on screen until answered, but the notification is
 * sent once: opening the app again must not buzz the phone again. Kept per
 * device, because each device does its own notifying.
 */
export type Announced = Record<string, string>;

const ANNOUNCED_KEY = 'smartask.reminders.announced.v1';

/** The ringing reminders this device has not notified about yet. */
export function unannounced(ringing: readonly Task[], announced: Announced): Task[] {
  return ringing.filter((t) => announced[t.id] !== t.reminder);
}

/**
 * The record after notifying about `shown`, with entries dropped for tasks
 * whose reminder is gone or has moved — so it never grows past the reminders
 * that exist, and a reminder moved to a new time notifies again.
 */
export function rememberAnnounced(
  announced: Announced,
  shown: readonly Task[],
  tasks: readonly Task[],
): Announced {
  const current = new Map(tasks.map((t) => [t.id, t.reminder]));
  const next: Announced = {};
  for (const [id, at] of Object.entries(announced)) {
    if (current.get(id) === at) next[id] = at;
  }
  for (const task of shown) {
    if (task.reminder) next[task.id] = task.reminder;
  }
  return next;
}

export function loadAnnounced(): Announced {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ANNOUNCED_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

export function saveAnnounced(announced: Announced): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(announced));
  } catch {
    // Storage blocked: the worst case is a second notification for one reminder.
  }
}

/* ------------------------------------------------------------------ *
 * Handing a reminder to the phone's calendar
 * ------------------------------------------------------------------ */

/** How long the calendar entry lasts. A reminder is a moment; calendars want a span. */
const EVENT_MINUTES = 15;

/** `20261118T070000Z` — the UTC form both iCalendar and Google's link take. */
function calendarStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * A link that opens Google Calendar with the event filled in, ready to save.
 * The alert itself is whatever the user's calendar gives new events.
 */
export function googleCalendarUrl(title: string, at: Date, note?: string | null): string {
  const end = new Date(at.getTime() + EVENT_MINUTES * 60_000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${calendarStamp(at)}/${calendarStamp(end)}`,
  });
  if (note) params.set('details', note);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Text as iCalendar wants it: backslash, semicolon, comma and line breaks escaped. */
function icsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Lines longer than 75 bytes must be folded, and never in the middle of a
 * character — a Hebrew letter is two bytes, an emoji four.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    // 73, not 75: a folded line starts with a space, which counts.
    if (bytes + size > 73) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * The reminder as a calendar file (.ics) with an alarm at the moment itself.
 * Opening it adds the event to the phone's own calendar, which then alerts
 * whether or not this app is running.
 */
export function calendarFile(
  task: Pick<Task, 'id' | 'title' | 'note'>,
  at: Date,
  now: Date,
): string {
  const end = new Date(at.getTime() + EVENT_MINUTES * 60_000);
  const summary = icsText(task.title);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SmartTask//Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The time is part of the id, so moving a reminder makes a new entry
    // rather than silently failing to replace the old one.
    `UID:${task.id}-${calendarStamp(at)}@smartask`,
    `DTSTAMP:${calendarStamp(now)}`,
    `DTSTART:${calendarStamp(at)}`,
    `DTEND:${calendarStamp(end)}`,
    `SUMMARY:${summary}`,
    ...(task.note ? [`DESCRIPTION:${icsText(task.note)}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${summary}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
