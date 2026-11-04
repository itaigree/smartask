import type { Priority } from './types';

/**
 * Pure natural-language parser: plain text in, structured draft out.
 * No I/O and no implicit clock — `now` is always passed in so this is testable.
 */
export interface ParsedDraft {
  title: string;
  due: string | null;
  priority: Priority;
  project: string | null;
  tags: string[];
  note: string | null;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Format a Date as a local `YYYY-MM-DD` string (never UTC-shifted). */
export function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Midnight-local copy of `date`, shifted by `days`. */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Days from `now` to the next occurrence of `weekday`.
 * Today counts as an occurrence, so on a Friday "friday" means today.
 */
function daysUntilWeekday(now: Date, weekday: number): number {
  return (weekday - now.getDay() + 7) % 7;
}

interface DateMatch {
  due: string;
  start: number;
  end: number;
}

/** Ordered date matchers. The first one that matches wins. */
function matchDate(text: string, now: Date): DateMatch | null {
  const matchers: Array<[RegExp, (m: RegExpExecArray) => Date | null]> = [
    // Explicit ISO date: 2026-12-25
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) =>
      new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))],

    // Day/month, optional year: 25/12, 25.12.2026, 25-12
    [/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/, (m) => {
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      if (day < 1 || day > 31 || month < 0 || month > 11) return null;
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      if (year < 100) year += 2000;
      const candidate = new Date(year, month, day);
      // A bare day/month that already passed means next year.
      if (!m[3] && candidate < startOfDay(now)) candidate.setFullYear(year + 1);
      return candidate;
    }],

    // "dec 25" / "25 dec" / "december 25th"
    [/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/, (m) => {
      const month = MONTHS[m[1]];
      if (month === undefined) return null;
      return monthDay(now, month, Number(m[2]));
    }],
    [/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/, (m) => {
      const month = MONTHS[m[2]];
      if (month === undefined) return null;
      return monthDay(now, month, Number(m[1]));
    }],

    // Relative words
    [/\b(?:day after tomorrow)\b/, () => addDays(now, 2)],
    [/\b(?:today|tonight|this evening)\b/, () => addDays(now, 0)],
    [/\b(?:tomorrow|tmrw?|tmw)\b/, () => addDays(now, 1)],
    [/\bnext week\b/, () => addDays(now, 7)],
    [/\bnext month\b/, () => {
      const d = startOfDay(now);
      d.setMonth(d.getMonth() + 1);
      return d;
    }],
    [/\bin (\d{1,3}) (day|days|week|weeks|month|months)\b/, (m) => {
      const n = Number(m[1]);
      const unit = m[2];
      if (unit.startsWith('day')) return addDays(now, n);
      if (unit.startsWith('week')) return addDays(now, n * 7);
      const d = startOfDay(now);
      d.setMonth(d.getMonth() + n);
      return d;
    }],
    [/\bin a (day|week|month)\b/, (m) => {
      if (m[1] === 'day') return addDays(now, 1);
      if (m[1] === 'week') return addDays(now, 7);
      const d = startOfDay(now);
      d.setMonth(d.getMonth() + 1);
      return d;
    }],

    // "next friday" = the following occurrence plus a week.
    [/\bnext (sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/, (m) => {
      const wd = WEEKDAY_ALIASES[m[1]];
      if (wd === undefined) return null;
      return addDays(now, daysUntilWeekday(now, wd) + 7);
    }],

    // "friday" / "on friday" / "by friday" = next occurrence, today included.
    [/\b(?:on |by |due )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/, (m) => {
      const wd = WEEKDAY_ALIASES[m[1]];
      if (wd === undefined) return null;
      return addDays(now, daysUntilWeekday(now, wd));
    }],
  ];

  for (const [re, build] of matchers) {
    const m = re.exec(text);
    if (!m) continue;
    const date = build(m);
    if (!date || Number.isNaN(date.getTime())) continue;
    return { due: toISODate(date), start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A month/day in the current year, rolled to next year if already past. */
function monthDay(now: Date, month: number, day: number): Date | null {
  if (day < 1 || day > 31) return null;
  const candidate = new Date(now.getFullYear(), month, day);
  if (candidate < startOfDay(now)) candidate.setFullYear(now.getFullYear() + 1);
  return candidate;
}

const PRIORITY_WORDS: Array<[RegExp, Priority]> = [
  [/\b(?:urgent|asap|critical|emergency|now!)\b/, 'Urgent'],
  [/\b(?:important|high priority|soon)\b/, 'High'],
  [/\b(?:someday|whenever|eventually|low priority|no rush|backlog)\b/, 'Low'],
];

function matchPriority(text: string): { priority: Priority; spans: Array<[number, number]> } {
  const spans: Array<[number, number]> = [];
  let priority: Priority = 'Normal';

  // Bang notation wins: `!` high, `!!`+ urgent.
  const bang = /(?:^|\s)(!{1,3})(?=\s|$)/.exec(text);
  if (bang) {
    priority = bang[1].length >= 2 ? 'Urgent' : 'High';
    const at = bang.index + bang[0].indexOf('!');
    spans.push([at, at + bang[1].length]);
    return { priority, spans };
  }

  for (const [re, level] of PRIORITY_WORDS) {
    const m = re.exec(text);
    if (m) {
      priority = level;
      spans.push([m.index, m.index + m[0].length]);
      break;
    }
  }
  return { priority, spans };
}

function cutSpans(text: string, spans: Array<[number, number]>): string {
  const sorted = [...spans].sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of sorted) {
    out = out.slice(0, start) + ' ' + out.slice(end);
  }
  return out;
}

/** Trim filler words a date phrase leaves behind ("call bank on" -> "call bank"). */
function tidyTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*([,;:-])\s*$/, '')
    .replace(/\b(?:by|on|at|due|before|until|till)\s*$/i, '')
    .replace(/^\s*(?:and|then|also)\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse free text into a task draft.
 *
 * Syntax: `#project` sets the project, `@tag` adds a tag, `!`/`!!` set priority,
 * dates are recognised in plain English, and anything after a newline (or ` // `)
 * becomes the note.
 */
export function parseTask(input: string, now: Date = new Date()): ParsedDraft {
  const [headRaw, ...noteParts] = input.split(/\n|\s\/\/\s/);
  const note = noteParts.join('\n').trim() || null;
  let head = headRaw ?? '';

  const spans: Array<[number, number]> = [];

  // #project — last one wins.
  let project: string | null = null;
  const projectRe = /(?:^|\s)#([\wÀ-ɏ֐-׿-]+)/g;
  for (let m = projectRe.exec(head); m; m = projectRe.exec(head)) {
    project = m[1];
    const at = m.index + m[0].indexOf('#');
    spans.push([at, at + m[1].length + 1]);
  }

  // @tag — all of them, de-duplicated, order preserved.
  const tags: string[] = [];
  const tagRe = /(?:^|\s)@([\wÀ-ɏ֐-׿-]+)/g;
  for (let m = tagRe.exec(head); m; m = tagRe.exec(head)) {
    if (!tags.includes(m[1])) tags.push(m[1]);
    const at = m.index + m[0].indexOf('@');
    spans.push([at, at + m[1].length + 1]);
  }

  const { priority, spans: prioritySpans } = matchPriority(head);
  spans.push(...prioritySpans);

  // Date matching runs on text with the tokens blanked out, so `#dec` or `@25/12`
  // can never be read as a date, while indexes still line up with `head`.
  const masked = cutSpans(head, spans).toLowerCase();
  const dateMatch = matchDate(masked, now);
  if (dateMatch) spans.push([dateMatch.start, dateMatch.end]);

  const title = tidyTitle(cutSpans(head, spans));

  return {
    title: title || tidyTitle(headRaw ?? '') || 'Untitled task',
    due: dateMatch?.due ?? null,
    priority,
    project,
    tags,
    note,
  };
}
