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
 * Add calendar months, clamping the day to the target month's length, so
 * "next month" on 31 January is 28 (or 29) February rather than 3 March.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getFullYear();
  const month = date.getMonth() + months;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(date.getDate(), lastDay));
}

/**
 * The local calendar day of a stored date, as `YYYY-MM-DD`.
 *
 * Notion returns a full timestamp when "Include time" is on
 * (`2026-11-06T14:00:00.000+02:00`); the app works in whole days, so a
 * timestamp becomes the day it falls on *here*. That is not always its first
 * ten characters: a UTC time can belong to a different local day.
 */
export function localDateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](.+))?$/.exec(text);
  if (!m) return null;
  // An impossible day is refused with or without a time, never rolled over.
  if (!makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return day;
  // "2026-11-20 09:30" (a hand-edited backup) parses once the space is a T. A
  // time that still does not parse leaves the day itself, rather than nothing.
  const parsed = new Date(`${day}T${m[4]}`);
  return Number.isNaN(parsed.getTime()) ? day : toISODate(parsed);
}

/**
 * Days from `now` to the next occurrence of `weekday`.
 * Today counts as an occurrence, so on a Friday "friday" means today.
 */
function daysUntilWeekday(now: Date, weekday: number): number {
  return (weekday - now.getDay() + 7) % 7;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A real calendar date, or null for 31/02 or month 13 — never a silent rollover. */
function makeDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null;
}

/**
 * A day and month with no year: this year, or the first later year in which
 * that day exists and has not passed — so 29/02 waits for the next leap year.
 */
function nextDayMonth(now: Date, month: number, day: number): Date | null {
  const today = startOfDay(now);
  for (let year = now.getFullYear(); year <= now.getFullYear() + 4; year++) {
    const date = makeDate(year, month, day);
    if (date && date >= today) return date;
  }
  return null;
}

/** `26` means 2026; only two- or four-digit years are accepted at all. */
function fullYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

/* ------------------------------------------------------------------ *
 * Matching
 *
 * `\b` treats `/`, `-`, `'` and `?` as word edges, which made "today" inside
 * a link or "today's" count as a date. These edges are stricter.
 * ------------------------------------------------------------------ */

/** Start and end of a word: not inside a longer word, a path, or a possessive. */
const WS = "(?<![\\p{L}\\p{N}_'’/])";
const WE = "(?![\\p{L}\\p{N}_/]|['’]\\p{L})";
/**
 * Start and end of a number. A Hebrew prefix letter or a hyphen may touch the
 * start (ב10.11, ב-10/11); a Latin letter, another digit or a decimal point
 * may not (v3.12, 1.5.2).
 */
const NS = "(?<![\\p{N}A-Za-z_/.,'’])(?<!\\p{N}:)";
const NE = "(?![\\p{N}A-Za-z_]|[./:,]\\p{N})";

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_NAMES = WEEKDAYS.join('|');

/** Words after a number that make it a quantity, not a date: "1.5 ליטר", "1/2 kg". */
const UNITS = [
  'kg', 'g', 'gr', 'gram', 'grams', 'mg', 'l', 'lt', 'liter', 'liters', 'litre', 'litres',
  'ml', 'km', 'm', 'cm', 'mm', 'inch', 'inches', 'in', 'ft', 'feet', 'foot', 'lb', 'lbs',
  'oz', 'kilo', 'kilos', 'cup', 'cups', 'tbsp', 'tsp', 'teaspoon', 'teaspoons',
  'tablespoon', 'tablespoons', 'spoon', 'spoons', 'dozen', 'pcs', 'pieces', 'packs',
  'hrs', 'hours', 'min', 'mins', 'minute', 'minutes', 'sec', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'percent', 'pct', 'x', 'nis', 'ils', 'usd', 'eur',
  'euro', 'euros', 'dollar', 'dollars', 'shekel', 'shekels', 'bucks',
  'ליטר', 'ליטרים', 'קילו', 'קילוגרם', 'ק"ג', 'קג', 'גרם', 'גר', 'מ"ל', 'מל', 'ק"מ', 'קמ',
  'מטר', 'מטרים', 'ס"מ', 'סמ', 'מ"מ', 'אינץ\'', 'שעות', 'דקה', 'דקות', 'ימים', 'יום',
  'שבועות', 'חודשים', 'שנים', 'ש"ח', 'שח', 'שקל', 'שקלים', 'דולר', 'דולרים', 'יורו',
  'אחוז', 'אחוזים', 'יחידות', 'כוס', 'כוסות', 'כף', 'כפות', 'כפית', 'כפיות', 'מנות',
  'קופסאות', 'בקבוק', 'בקבוקים', 'חבילה', 'חבילות',
];
const UNIT_AFTER = new RegExp(`^\\s*(?:[%₪$€£]|(?:${UNITS.join('|')})${WE})`, 'u');

/** A clock time or a price, not a date: "at 9.05", "בשעה 9.30", "₪5.10". */
const TIME_OR_MONEY_BEFORE = /(?:(?:^|\s)(?:at|@|בשעה|שעה)\s*|[₪$€£]\s*)$/u;

/** English words that can sit right before a date: "pay rent by 25.12". */
const DATE_WORDS_BEFORE = new Set(['on', 'by', 'due', 'before', 'until', 'till', 'til', 'for']);

/**
 * Is a day/month with no year really meant as a date?
 *
 * A bare `1.5` is far more often a quantity, a version or a price than the
 * first of May, and a wrong date is worse than a missed one: a missed date
 * keeps the text in the title, and Gemini can still read it. So when in doubt,
 * this says no.
 */
function plausibleDayMonth(
  text: string,
  start: number,
  end: number,
  separator: string,
  day: number,
  month: number,
): boolean {
  const before = text.slice(0, start);
  if (separator === '/' && day === 24 && month === 7) return false; // "24/7 pharmacy"
  // A unit after a quantity-like number: "1.5 ליטר", "ב-1.5 חודשים", "1/2 kg" —
  // but "15/11 חבילה" (a day after a month cannot be a fraction) is still a date.
  const quantityLike = separator === '.' || day < month;
  if (quantityLike && UNIT_AFTER.test(text.slice(end))) return false;
  // "by", "עד", "ב-" right before it: otherwise, this is a date.
  if (DATE_LEAD_IN.test(before)) return true;
  if (separator === '.') {
    if (TIME_OR_MONEY_BEFORE.test(before)) return false;
    // "python 3.12", "pay 5.10": a dotted number right after an English word is
    // a version or an amount. Hebrew writes dates this way (פגישה 25.12), English rarely does.
    const word = /(?:^|\s)([a-z][a-z0-9'’]*)\s*$/.exec(before);
    if (word && !DATE_WORDS_BEFORE.has(word[1])) return false;
  } else if (/[₪$€£]\s*$/.test(before)) {
    return false;
  }
  return true;
}

type Builder = (m: RegExpExecArray, text: string) => Date | null;

/** Ordered date matchers. The first one that yields a real date wins. */
function dateMatchers(now: Date): Array<[RegExp, Builder]> {
  const re = (source: string) => new RegExp(source, 'gu');
  return [
    // Explicit ISO date: 2026-12-25
    [re(`${NS}(\\d{4})-(\\d{2})-(\\d{2})${NE}`), (m) =>
      makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]))],

    // Day/month with a year: 25/12/2026, 25.12.26 — but not a version such as
    // "update app to 1.5.20", whose "year" is long past.
    [re(`${NS}(\\d{1,2})([./])(\\d{1,2})\\2(\\d{4}|\\d{2})${NE}`), (m) => {
      const year = fullYear(m[4]);
      return plausibleYear(year, now) ? makeDate(year, Number(m[3]) - 1, Number(m[1])) : null;
    }],

    // "december 25th, 2027", "3rd of march 2028" — the year only when it is a
    // believable one and not an amount ("dec 3 2000 nis"); otherwise the
    // matchers below take the day and month alone.
    [re(`${WS}(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${NE}`), (m, text) =>
      yearFits(m, text, Number(m[3]), now)
        ? makeDate(Number(m[3]), MONTHS[m[1]], Number(m[2]))
        : null],
    [re(`${NS}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?,?\\s+(\\d{4})${NE}`), (m, text) =>
      yearFits(m, text, Number(m[3]), now)
        ? makeDate(Number(m[3]), MONTHS[m[2]], Number(m[1]))
        : null],
    // "dec 25", "25 dec"
    [re(`${WS}(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${NE}`), (m) =>
      nextDayMonth(now, MONTHS[m[1]], Number(m[2]))],
    [re(`${NS}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?${WE}`), (m) =>
      nextDayMonth(now, MONTHS[m[2]], Number(m[1]))],

    // Relative words for the next two days beat a bare day/month ("at 9.05 tomorrow").
    [re(`${WS}day after tomorrow${WE}`), () => addDays(now, 2)],
    [re(`${WS}(?:today|tonight|this evening)${WE}`), () => addDays(now, 0)],
    [re(`${WS}(?:tomorrow|tmrw?|tmw)${WE}`), () => addDays(now, 1)],

    // Day/month with no year: 25/12, 25.12, ב-10/11. More specific than a
    // weekday, so "dentist monday 16/11" is the 16th; refused when it looks
    // like a quantity, a version, a price or a time.
    [re(`${NS}(\\d{1,2})([./])(\\d{1,2})${NE}`), (m, text) => {
      const day = Number(m[1]);
      const month = Number(m[3]);
      if (!plausibleDayMonth(text, m.index, m.index + m[0].length, m[2], day, month)) return null;
      return nextDayMonth(now, month - 1, day);
    }],

    [re(`${WS}next week${WE}`), () => addDays(now, 7)],
    [re(`${WS}next month${WE}`), () => addMonths(startOfDay(now), 1)],
    [re(`${WS}in (\\d{1,3}) (days?|weeks?|months?)${WE}`), (m) => {
      const n = Number(m[1]);
      if (m[2].startsWith('day')) return addDays(now, n);
      if (m[2].startsWith('week')) return addDays(now, n * 7);
      return addMonths(startOfDay(now), n);
    }],
    [re(`${WS}in a (day|week|month)${WE}`), (m) => {
      if (m[1] === 'day') return addDays(now, 1);
      if (m[1] === 'week') return addDays(now, 7);
      return addMonths(startOfDay(now), 1);
    }],

    // "next friday" = the following occurrence plus a week.
    [re(`${WS}next (sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?${WE}`), (m) => {
      const wd = WEEKDAY_ALIASES[m[1]];
      return wd === undefined ? null : addDays(now, daysUntilWeekday(now, wd) + 7);
    }],

    // "friday" / "on friday" / "by friday" = next occurrence, today included.
    [re(`${WS}(?:(?:on|by|due)\\s+)?(${WEEKDAY_NAMES})${WE}`), (m) => {
      const wd = WEEKDAY_ALIASES[m[1]];
      return wd === undefined ? null : addDays(now, daysUntilWeekday(now, wd));
    }],
  ];
}

/** A typed year a task could mean: last year up to ten years ahead. */
function plausibleYear(year: number, now: Date): boolean {
  return year >= now.getFullYear() - 1 && year <= now.getFullYear() + 10;
}

/** Is the four-digit number after a month-name date its year, or an amount? */
function yearFits(m: RegExpExecArray, text: string, year: number, now: Date): boolean {
  return plausibleYear(year, now) && !UNIT_AFTER.test(text.slice(m.index + m[0].length));
}

/**
 * Words that introduce a date and should leave with it: "by 25/12",
 * "עד 10/11", "ב-10/11", "ב10.11", "עד ה-15/11". Matched against the text
 * just before the date, so a title that merely *ends* in "on" keeps it.
 */
const LEAD_IN =
  /(?<=^|\s)(?:(?:by|on|at|due|before|until|till)\s+|(?:עד|לפני|בתאריך|ביום|לתאריך|תאריך)\s*(?:[הל]\s*[-־–—]?\s*)?|ו?[בלמה]\s*[-־–—]?\s*)$/u;

/** The same words minus "at", which introduces a time ("at 9.05") as often as a date. */
const DATE_LEAD_IN =
  /(?<=^|\s)(?:(?:by|on|due|before|until|till)\s+|(?:עד|לפני|בתאריך|ביום|לתאריך|תאריך)\s*(?:[הל]\s*[-־–—]?\s*)?|ו?[בלמה]\s*[-־–—]?\s*)$/u;

interface DateMatch {
  due: string;
  start: number;
  end: number;
}

function matchDate(text: string, now: Date): DateMatch | null {
  for (const [re, build] of dateMatchers(now)) {
    for (const m of text.matchAll(re)) {
      const date = build(m as RegExpExecArray, text);
      if (!date || Number.isNaN(date.getTime())) continue;
      const index = m.index ?? 0;
      const leadIn = LEAD_IN.exec(text.slice(0, index));
      return {
        due: toISODate(date),
        start: leadIn ? leadIn.index : index,
        end: index + m[0].length,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

/** Unambiguous wherever they appear: nobody writes "asap" by accident. */
const PRIORITY_PHRASES: Array<[RegExp, Priority]> = [
  // A negated priority is Low, wherever it is: "not really urgent", "non-urgent".
  [new RegExp(`${WS}(?:(?:it|this|that)(?:['’]s)?\\s+)?(?:not|non|isn['’]?t|is not|nothing)[\\s-]+(?:(?:very|that|so|too|really|super|particularly)\\s+)?(?:urgent|important|critical|(?:a\\s+)?(?:top|high)\\s+priority)${WE}`, 'u'), 'Low'],
  [new RegExp(`${WS}(?:asap|as soon as possible|top priority)${WE}`, 'u'), 'Urgent'],
  [new RegExp(`${WS}now!+(?=\\s|$)`, 'u'), 'Urgent'],
  [new RegExp(`${WS}high priority${WE}`, 'u'), 'High'],
  [new RegExp(`${WS}(?:low priority|no rush|no hurry)${WE}`, 'u'), 'Low'],
];

/**
 * Ordinary words that only mean a priority when they stand at the start or
 * the end of the task: "Urgent: call the bank", "call the plumber, not
 * urgent" — but not "buy emergency kit" or "file important documents".
 */
const PRIORITY_MARKERS: Array<[RegExp, Priority]> = [
  // Not when the word is part of a name for something: "urgent care",
  // "emergency room", "kit for emergency".
  [new RegExp(`${WS}(?<!(?:^|\\s)(?:for|of|in|an|the|case)\\s+)(?:urgent|critical|emergency)(?!\\s+(?:care|room|rooms|services?|kits?|contacts?|numbers?|fund|exit|vet|clinic|department|ward|line|brake)${WE})${WE}`, 'u'), 'Urgent'],
  [new RegExp(`${WS}(?:important|soon)${WE}`, 'u'), 'High'],
  [new RegExp(`${WS}(?:someday|whenever|eventually)${WE}`, 'u'), 'Low'],
];

/** A #project or @tag that names a priority sets it too: `@urgent`, `#asap`. */
const PRIORITY_TOKENS: Record<string, Priority> = {
  urgent: 'Urgent', asap: 'Urgent', critical: 'Urgent', emergency: 'Urgent',
  important: 'High', high: 'High',
  low: 'Low', someday: 'Low',
};

/** Nothing but space, punctuation, symbols and emoji parts (variation selectors, ZWJ). */
const EDGE = /^[\s\p{P}\p{S}\p{M}\p{Cf}]*$/u;

function matchPriority(text: string): { priority: Priority; spans: Span[] } {
  // Bang notation wins: `!` high, `!!` or more urgent.
  const bang = /(?:^|\s)(!+)(?=\s|$)/.exec(text);
  if (bang) {
    const at = bang.index + bang[0].indexOf('!');
    return {
      priority: bang[1].length >= 2 ? 'Urgent' : 'High',
      spans: [[at, at + bang[1].length]],
    };
  }

  for (const [re, level] of PRIORITY_PHRASES) {
    const m = re.exec(text);
    if (m) return { priority: level, spans: [[m.index, m.index + m[0].length]] };
  }

  for (const [re, level] of PRIORITY_MARKERS) {
    const global = new RegExp(re.source, 'gu');
    for (const m of text.matchAll(global)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (EDGE.test(text.slice(0, start)) || EDGE.test(text.slice(end))) {
        return { priority: level, spans: [[start, end]] };
      }
    }
  }
  return { priority: 'Normal', spans: [] };
}

/* ------------------------------------------------------------------ *
 * Cutting
 * ------------------------------------------------------------------ */

type Span = [number, number];

/**
 * Blank out spans with spaces of the same length, so every index into the
 * result is still an index into the original. (Replacing each span with one
 * space shifted later positions and cut dates out of the wrong place.)
 */
function blank(text: string, spans: Span[], filler = ' '): string {
  let out = text;
  for (const [start, end] of spans) {
    out = out.slice(0, start) + filler.repeat(end - start) + out.slice(end);
  }
  return out;
}

/**
 * A link is blanked with a character that is not a space, so it still stands
 * between the words around it: "on <link> by friday" must not treat "on" as
 * the word right before the date and cut the link out with it.
 */
const OPAQUE = '\uFFFF';

/**
 * The text as the matchers see it: lowercased, and with Hebrew gershayim and
 * geresh as the plain quotes phone keyboards usually type (ק״ג = ק"ג) — every
 * character mapped to exactly one, so indexes still line up with the original.
 */
function scanText(text: string): string {
  return text
    .split('')
    .map((c) => {
      if (c === '״') return '"';
      if (c === '׳') return "'";
      const lower = c.toLowerCase();
      return lower.length === 1 ? lower : c;
    })
    .join('');
}

/** Remove spans from `text`, merging any that overlap or touch first. */
function cutSpans(text: string, spans: Span[]): string {
  const merged: Span[] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = text;
  for (const [start, end] of merged.reverse()) {
    out = out.slice(0, start) + ' ' + out.slice(end);
  }
  return out;
}

/** Tidy what is left once tokens and the date are gone. */
function tidyTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[([]\s*[)\]]/g, '') // brackets a cut left empty: "(non-urgent)"
    .replace(/\s+([,;:.!?])(?=\s|$)/g, '$1') // "call bank , please", but not "to .env"
    .replace(/^[\s,;:\-–—־]+/, '')
    .replace(/[\s,;:\-–—־]+$/, '')
    .replace(/^(?:and|then|also)\s+/i, '')
    .trim();
}

/** Links stay in the title, but nothing inside them is read as a date or priority. */
const LINK = /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}_@])[\p{L}\p{N}_-]+(?:\.[a-z][\w-]*)+\/\S*/giu;

/**
 * A #project or @tag name. Hebrew acronyms keep their quote mark even when the
 * keyboard types a plain `"` or `'` (ביה"ס, עו"ד).
 */
const TOKEN = '((?:[\\wÀ-ɏ֐-׿-]|(?<=[֐-׿])["\'](?=[֐-׿]))+)';

/**
 * Parse free text into a task draft.
 *
 * Syntax: `#project` sets the project, `@tag` adds a tag, `!`/`!!` set priority,
 * dates are recognised in plain English and in numeric form, and anything after
 * a newline (or ` // `) becomes the note.
 */
export function parseTask(input: string, now: Date = new Date()): ParsedDraft {
  const [headRaw, ...noteParts] = input.split(/\n|\s\/\/\s/);
  const note = noteParts.join('\n').trim() || null;
  const head = headRaw ?? '';

  // Everything is matched against `scan`: the head lowercased and, step by
  // step, with already-claimed text blanked — always the same length as `head`.
  let scan = scanText(head);
  scan = blank(
    scan,
    [...scan.matchAll(LINK)].map((m) => [m.index!, m.index! + m[0].length]),
    OPAQUE,
  );

  const cut: Span[] = [];

  // #project — last one wins.
  let project: string | null = null;
  for (const m of scan.matchAll(new RegExp(`(?:^|\\s)#${TOKEN}`, 'gu'))) {
    const at = m.index! + m[0].indexOf('#');
    project = head.slice(at + 1, at + 1 + m[1].length);
    cut.push([at, at + m[1].length + 1]);
  }

  // @tag — all of them, de-duplicated, order preserved.
  const tags: string[] = [];
  for (const m of scan.matchAll(new RegExp(`(?:^|\\s)@${TOKEN}`, 'gu'))) {
    const at = m.index! + m[0].indexOf('@');
    const tag = head.slice(at + 1, at + 1 + m[1].length);
    if (!tags.includes(tag)) tags.push(tag);
    cut.push([at, at + m[1].length + 1]);
  }
  scan = blank(scan, cut);

  // The date, on text with the tokens blanked, so `#dec` or `@25/12` is never a date.
  const dateMatch = matchDate(scan, now);
  if (dateMatch) {
    cut.push([dateMatch.start, dateMatch.end]);
    scan = blank(scan, [[dateMatch.start, dateMatch.end]]);
  }

  // Priority last, so "urgent" inside `@urgent` or a link is never a second cut.
  const found = matchPriority(scan);
  cut.push(...found.spans);
  let priority = found.priority;
  if (priority === 'Normal') {
    for (const token of [...tags, project ?? '']) {
      const level = PRIORITY_TOKENS[token.toLowerCase()];
      if (level) {
        priority = level;
        break;
      }
    }
  }

  const title = tidyTitle(cutSpans(head, cut));

  return {
    title: title || tidyTitle(head) || 'Untitled task',
    due: dateMatch?.due ?? null,
    priority,
    project,
    tags,
    note,
  };
}
