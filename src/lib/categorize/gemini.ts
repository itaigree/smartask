import {
  BUILT_IN_CATEGORIES, categoryKey, normalizeCategoryName, readCategoryName, sameCategory,
  type BuiltInCategory, type Category,
} from '../types.ts';
import { addDays, toISODate } from '../parse.ts';
import { categoryNamedByTags } from './rules.ts';
import type { CategorySignal, Categorizer, RuleInput } from './index.ts';

/**
 * Classification by Gemini, called straight from the browser.
 *
 * `generativelanguage.googleapis.com` sends CORS headers that echo the calling
 * origin and allow the `x-goog-api-key` header, so no server is needed. The key
 * goes in that header rather than a `key=` query parameter: keys in URLs leak
 * into history, logs and `Referer`.
 *
 * Nothing here is allowed to break capture. Every failure path falls back to
 * the keyword rules, because a filed task in the wrong category beats a task
 * that never got saved.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiSettings {
  apiKey: string;
  model: string;
}

/** What each category means, so the model files tasks the way the app's views expect. */
const CATEGORY_GUIDE: Record<BuiltInCategory, string> = {
  Work:
    'a job or an academic career: research, lab, thesis, papers, grants, ethics ' +
    'approvals, supervisors, colleagues, clients, meetings, deadlines, work email',
  Personal: 'friends and family, social plans, gifts, travel, personal messages and calls',
  Errands: 'short trips and pickups: shops, post, deliveries, laundry, fuel',
  Health: 'doctors, dentists, medication, fitness, mental health, appointments',
  Finance: 'money: bills, rent, tax, banking, insurance, invoices, budgeting',
  Learning: 'courses, studying, exams, homework, reading to learn, practising a skill',
  Home: 'the home itself: repairs, cleaning, furniture, garden, utilities setup',
  Inbox:
    'LAST RESORT: only when there is genuinely no clue at all what the task is about — ' +
    'not even enough to name a new category',
};

/**
 * Worked examples, deliberately including Hebrew. Short, terse tasks in any
 * language are the normal case, not an edge case — the model should commit to
 * its best guess rather than fall back to Inbox.
 */
const EXAMPLES: Array<[string, BuiltInCategory]> = [
  ['לשלם חשבון חשמל', 'Finance'],
  ['לקבוע תור לרופאת שיניים', 'Health'],
  ['להגיש טופס לוועדת אתיקה', 'Work'],
  ['להתקשר לאמא', 'Personal'],
  ['email the supervisor about the draft', 'Work'],
  ['buy milk', 'Errands'],
];

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * The next two weeks written out. Models are unreliable at weekday arithmetic,
 * and "ביום שלישי" is only answerable if the model can look the date up.
 */
export function calendarLines(now: Date): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const day = addDays(now, i);
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    return `  ${WEEKDAY_NAMES[day.getDay()]} ${toISODate(day)}${label}`;
  });
}

/** How a category is described to the model. Custom ones have no guide — just their name. */
function describeCategory(name: string): string {
  const guide = (CATEGORY_GUIDE as Record<string, string>)[name];
  return guide
    ? `- ${name}: ${guide}`
    : `- ${name}: the user's own category — use it whenever the task clearly fits it`;
}

/**
 * The categories to offer: the built-ins plus any the user created, one entry
 * per category, Inbox kept last so it reads as the fallback it is.
 */
function offered(categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of [...BUILT_IN_CATEGORIES, ...categories]) {
    const name = readCategoryName(raw);
    if (!name || name === 'Inbox' || seen.has(categoryKey(name))) continue;
    seen.add(categoryKey(name));
    list.push(name);
  }
  return [...list, 'Inbox'];
}

export interface PromptOptions {
  /** Let the model name a new category when none of the user's fits. */
  allowNew?: boolean;
}

export function buildPrompt(
  input: RuleInput,
  categories: readonly string[] = BUILT_IN_CATEGORIES,
  { allowNew = false }: PromptOptions = {},
): string {
  const now = input.now ?? new Date();
  const lines = [
    'Classify this personal task into exactly one category.',
    '',
    'The task may be written in any language — often Hebrew — and is usually short.',
    'Classify it by meaning. Answer with the category name exactly as written in the',
    'list below; built-in categories always get their English category name.',
    '',
    "The user's current categories:",
    ...offered(categories).map(describeCategory),
    '',
  ];

  if (allowNew) {
    lines.push(
      'Decide in two steps:',
      "1. Go through the user's current categories above and pick the one that fits the",
      '   task best. Prefer an existing category whenever it fits reasonably well, even',
      '   if it is broader than the task.',
      '2. Only if none of them fits, create a new category: a short, general English',
      '   name of one or two words in Title Case (for example "Pets", "Car", "Wedding")',
      '   that later tasks of the same kind could also go into. Never create a category',
      '   that means the same as an existing one, or a narrower version of one.',
      'Set "new" to true only when you created the category in step 2.',
      '',
    );
  }

  lines.push(
    'Examples:',
    ...EXAMPLES.map(([task, category]) => `${JSON.stringify(task)} -> ${category}`),
  );
  if (allowNew) {
    lines.push('"להאכיל את החתול" -> Pets (new: true), but only if no pet category exists yet');
  }
  lines.push('', `Task: ${JSON.stringify(input.title)}`);

  if (input.note) lines.push(`Note: ${JSON.stringify(input.note)}`);
  if (input.project) lines.push(`Project: ${JSON.stringify(input.project)}`);
  if (input.tags?.length) lines.push(`Tags: ${input.tags.join(', ')}`);

  lines.push(
    '',
    `Today is ${WEEKDAY_NAMES[now.getDay()]}, ${toISODate(now)}. The next two weeks:`,
    ...calendarLines(now),
    '',
    'Also find the due date if the task mentions one, in any language — for example',
    '"מחר" is tomorrow, "מחרתיים" the day after, "היום" today, "בעוד שבוע" a week from',
    'today, "ביום חמישי" the next Thursday (today counts if today is Thursday).',
    'Look weekdays up in the list above rather than calculating them.',
    'Give due as YYYY-MM-DD, or null if the task names no date at all.',
    '',
    'Also give title: the task text with only the date words removed.',
    'Keep the same language and the same words — do not translate, rephrase or shorten.',
    '',
    'Judge by what the task is actually about, not by single keywords.',
    '"Pay the electricity bill" is Finance even if it concerns the home.',
    'Commit to the most likely category even when the task is terse. A task to',
    'write to or call a named person is Personal unless it is clearly about work.',
    'Do not choose Inbox just because the task is short.',
    '',
    'Reply with only a JSON object, no prose and no code fence:',
    allowNew
      ? '{"category": "<a category from the list, or your new one>", "new": <true or false>, "due": "<YYYY-MM-DD or null>", "title": "<task without date words>", "confidence": <0 to 1>, "reason": "<at most 8 words>"}'
      : '{"category": "<one category from the list>", "due": "<YYYY-MM-DD or null>", "title": "<task without date words>", "confidence": <0 to 1>, "reason": "<at most 8 words>"}',
  );

  return lines.join('\n');
}

/** The fields the reply's JSON is asked for; anything may be missing or mistyped. */
interface ReplyFields {
  category?: unknown;
  confidence?: unknown;
  reason?: unknown;
  due?: unknown;
  title?: unknown;
}

/**
 * Read the reply's JSON object, mending what models typically break.
 *
 * A Hebrew acronym written with a plain quote (דו"ח, עו"ד, מע"מ) ends the
 * string early. A quote with a letter on both sides is never JSON syntax, so it
 * is escaped and the reply read again. Failing that, the category and date are
 * picked out of the text one by one; the free-text fields are left alone.
 */
function readReplyFields(json: string): ReplyFields | null {
  const mended = json.replace(/(?<=[\p{L}\p{N}])"(?=[\p{L}\p{N}])/gu, '\\"');
  for (const candidate of [json, mended]) {
    try {
      return JSON.parse(candidate) as ReplyFields;
    } catch {
      // Try the next, or pick fields out below.
    }
  }
  const category = /"category"\s*:\s*"([^"\n]*)"/.exec(json)?.[1];
  if (category === undefined) return null;
  return {
    category,
    due: /"due"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(json)?.[1] ?? null,
    confidence: /"confidence"\s*:\s*([\d.]+)/.exec(json)?.[1],
  };
}

/**
 * A reply with no JSON at all: accept it only when it is short and names
 * exactly one category. Longer names first, so "Home Office" is not also read
 * as "Home".
 */
function bareCategory(text: string, choices: readonly string[]): CategorySignal | null {
  if (text.split(/\s+/).length > 8) return null;
  let rest = text;
  const named: string[] = [];
  for (const category of [...choices].sort((a, b) => b.length - a.length)) {
    const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, 'iu');
    if (re.test(rest)) {
      named.push(category);
      rest = rest.replace(re, '$1 ');
    }
  }
  return named.length === 1
    ? { category: named[0], confidence: 0.6, reason: 'classified by Gemini' }
    : null;
}

/**
 * Pull a usable signal out of whatever the model said.
 *
 * Models wrap JSON in code fences, add a preamble, break a string with a stray
 * quote, or answer with a bare word. Those are recoverable, so parse leniently
 * and validate strictly — an unrecognised category is discarded rather than
 * trusted.
 */
export function parseGeminiReply(
  text: string,
  allowed: readonly string[] = BUILT_IN_CATEGORIES,
  { allowNew = false }: PromptOptions = {},
): CategorySignal | null {
  if (!text) return null;

  // Matched by the one category rule, but always returned in the user's own spelling.
  const choices = offered(allowed);
  const canonical = (name: unknown): Category | null =>
    typeof name === 'string' ? choices.find((c) => sameCategory(c, name)) ?? null : null;

  const stripped = text.replace(/```(?:json)?/gi, '').trim();

  // Braces mean the reply is JSON, however broken. Its category comes from the
  // "category" field or not at all — never from a word in its reason or title
  // ("expense report for work" is not Work).
  const start = stripped.indexOf('{');
  if (start < 0) return bareCategory(stripped, choices);

  const end = stripped.lastIndexOf('}');
  const parsed = readReplyFields(stripped.slice(start, end > start ? end + 1 : undefined));
  if (!parsed || typeof parsed !== 'object') return null;

  let category = canonical(parsed.category);
  let created = false;
  if (!category && allowNew) {
    const fresh = acceptNewCategory(parsed.category, choices);
    if (fresh) {
      category = fresh.name;
      created = fresh.created;
    }
  }
  if (!category) return null;

  const raw = Number(parsed.confidence);
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.8;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 80)
    : 'classified by Gemini';
  return {
    category,
    confidence,
    reason,
    ...(created ? { created: true } : {}),
    // Unvalidated here; sanitizeExtraction() decides what survives.
    extracted: {
      due: typeof parsed.due === 'string' ? parsed.due : null,
      title: typeof parsed.title === 'string' ? parsed.title : null,
    },
  };
}

/** Longest name the model may invent; the user's own can be longer. */
const MAX_NEW_CATEGORY_LENGTH = 24;

/**
 * Hebrew names a model may answer with for a built-in — the task is often
 * Hebrew — so "עבודה" files under Work instead of becoming a second Work.
 */
const HEBREW_BUILT_INS: Record<string, BuiltInCategory> = {
  'עבודה': 'Work', 'עבודות': 'Work',
  'אישי': 'Personal', 'אישית': 'Personal', 'אישיים': 'Personal',
  'סידורים': 'Errands', 'סידור': 'Errands', 'קניות': 'Errands',
  'בריאות': 'Health',
  'כספים': 'Finance', 'כסף': 'Finance', 'פיננסים': 'Finance', 'כלכלה': 'Finance',
  'לימודים': 'Learning', 'למידה': 'Learning', 'לימוד': 'Learning',
  'בית': 'Home', 'הבית': 'Home', 'משק בית': 'Home',
  'תיבת דואר': 'Inbox', 'דואר נכנס': 'Inbox',
};

/**
 * Spellings of one name a model may use for an existing category, looser than
 * the app's own rule: "Cars"/"car", "Glasses"/"glass", "Side-project"/"Side Project".
 */
function twinKeys(name: string): string[] {
  const letters = categoryKey(name).replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length <= 3) return [letters];
  return [letters, letters.replace(/s$/, ''), letters.replace(/es$/, ''), letters.replace(/ies$/, 'y')];
}

function isTwin(a: string, b: string): boolean {
  const keys = new Set(twinKeys(a));
  return twinKeys(b).some((k) => keys.has(k));
}

/**
 * Decide whether a category the model invented can be used.
 *
 * It must be a short, clean name (one to three words, a letter in it, nothing
 * Notion would refuse). If it is only a spelling variant of a category the user
 * already has — "Cars" next to "Car" — the existing one is used instead, so
 * near-duplicates never pile up.
 */
export function acceptNewCategory(
  raw: unknown,
  existing: readonly string[],
): { name: Category; created: boolean } | null {
  if (typeof raw !== 'string') return null;
  const name = normalizeCategoryName(raw.replace(/^["'\s]+|["'.\s]+$/g, ''));
  if (!name) return null;

  const builtIn = HEBREW_BUILT_INS[name];
  if (builtIn && existing.includes(builtIn)) return { name: builtIn, created: false };

  const twin = existing.find((c) => isTwin(c, name));
  if (twin) return { name: twin, created: false };

  if (name.length > MAX_NEW_CATEGORY_LENGTH) return null;
  if (name.split(' ').length > 3) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (/[\n{}[\]<>|]/.test(name)) return null;

  // An all-lowercase English answer is given Title Case, like the built-ins.
  const tidy = /^[a-z][a-z ]*$/.test(name)
    ? name.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : name;
  return { name: tidy, created: true };
}

/** Words for comparison: lowercase, punctuation stripped, Hebrew letters kept. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

/** A real calendar date in `YYYY-MM-DD`, not "2026-02-31". */
function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** The most words a date phrase takes: "עד יום חמישי הבא", "by next Friday at noon". */
const MAX_DATE_WORDS = 4;

/**
 * Words that turn a task around. They are never part of a date, so never cut
 * with one. Apostrophes are already gone here: "don't" is "dont".
 */
const NEGATION =
  /^(?:not|no|never|nor|without|dont|doesnt|didnt|wont|cant|cannot|isnt|arent|shouldnt|mustnt|[וש]?(?:לא|אל|אין|בלי|מבלי|אסור|אף))$/;

/**
 * Whether `title` is `original` with one short run of words cut out — the date
 * phrase — and nothing else changed. Words may not be reordered, reworded or
 * added; at most one more word is cut than kept, so a stub such as the date
 * alone is never all that is left; and a "not" is never among the words cut.
 */
export function isDateCut(original: string, title: string): boolean {
  const from = words(original);
  const kept = words(title);
  const cut = from.length - kept.length;
  if (!kept.length || cut < 0 || cut > MAX_DATE_WORDS || cut > kept.length + 1) return false;

  // The kept words must be a run from the start plus a run from the end.
  let head = 0;
  while (head < kept.length && kept[head] === from[head]) head += 1;
  let tail = 0;
  while (head + tail < kept.length && kept[kept.length - 1 - tail] === from[from.length - 1 - tail]) {
    tail += 1;
  }
  if (head + tail < kept.length) return false;

  return !from.slice(head, head + cut).some((w) => NEGATION.test(w));
}

/**
 * Decide which parts of what the model extracted can be trusted.
 *
 * - The date must be a real date, and plausible for a task: up to a week in the
 *   past (something already overdue), no more than three years ahead.
 * - The title may only *cut* the date words: see {@link isDateCut}. A model
 *   that translates, rephrases, reorders or over-shortens the task is ignored
 *   and the user's own words are kept.
 */
export function sanitizeExtraction(
  raw: { due: string | null; title: string | null } | undefined,
  originalTitle: string,
  now: Date,
): { due: string | null; title: string | null } {
  if (!raw) return { due: null, title: null };

  let due: string | null = null;
  if (raw.due && isRealDate(raw.due)) {
    const earliest = toISODate(addDays(now, -7));
    const latest = toISODate(addDays(now, 365 * 3));
    if (raw.due >= earliest && raw.due <= latest) due = raw.due;
  }

  let title: string | null = null;
  const candidate = raw.title?.trim() ?? '';
  if (candidate && candidate.length <= originalTitle.length && isDateCut(originalTitle, candidate)) {
    title = candidate;
  }

  return { due, title };
}

/** The text of the first candidate, or '' when the reply was blocked or empty. */
export function extractText(body: unknown): string {
  const parts = (body as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  })?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p?.text ?? '').join('').trim();
}

/** The parts of Google's error details the app reads. */
interface ErrorDetail {
  reason?: string;
  /** QuotaFailure: which quota ran out, e.g. `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. */
  violations?: Array<{ quotaId?: string; quotaValue?: string | number }>;
  /** RetryInfo, e.g. "17s". */
  retryDelay?: string;
}

/** "17.2s" as "18 seconds", "130s" as "3 minutes"; null when absent or unreadable. */
function waitText(delay: string | undefined): string | null {
  const seconds = Math.ceil(Number(/^(\d+(?:\.\d+)?)s$/.exec(delay ?? '')?.[1]));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * A rate-limit refusal, worded for which limit it was. A per-minute limit
 * passes; a used-up daily quota lasts until Google resets it; and a model with
 * no free quota at all never works, so only another model helps. Daily quotas
 * are per model, so another model helps there too.
 */
function describeRateLimit(message: string, details: ErrorDetail[]): string {
  const violations = details.flatMap((d) => d?.violations ?? []);
  if (violations.some((v) => String(v?.quotaValue) === '0') || /\blimit: ?0\b/.test(message)) {
    return 'This Gemini model has no free quota on your key. Pick another in AI settings.';
  }
  if (violations.some((v) => /PerDay/i.test(v?.quotaId ?? ''))) {
    return 'The daily Gemini limit for this model is used up. It resets within a day, or you can pick another model in AI settings.';
  }
  const wait = waitText(details.find((d) => typeof d?.retryDelay === 'string')?.retryDelay);
  return wait
    ? `Gemini rate limit reached. Try again in ${wait}.`
    : 'Gemini rate limit reached. It will work again shortly.';
}

/** Turn Google's error envelope into one sentence worth showing. */
export function describeGeminiError(body: unknown, status?: number): string {
  const error = (body as { error?: { message?: string; status?: string; details?: unknown[] } })
    ?.error;
  const details = (Array.isArray(error?.details) ? error.details : []) as ErrorDetail[];

  const reason = details.find((d) => typeof d?.reason === 'string')?.reason;

  if (reason === 'API_KEY_INVALID') {
    return 'Google rejected the API key. Check you pasted it in full.';
  }
  if (reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || /referr?er .*blocked/i.test(error?.message ?? '')) {
    // The browser sends only the site's address, never the page's path, so a
    // restriction naming the path refuses every request.
    return "The key's website restriction blocks this site. Allow this site's address followed by /* in Google Cloud credentials.";
  }
  if (reason === 'SERVICE_DISABLED' || error?.status === 'PERMISSION_DENIED') {
    return 'That key cannot use the Gemini API. Create one at aistudio.google.com/apikey.';
  }
  if (status === 429 || error?.status === 'RESOURCE_EXHAUSTED') {
    return describeRateLimit(error?.message ?? '', details);
  }
  if (status === 404) {
    return 'That Gemini model is not available to your key. Pick another in AI settings.';
  }
  return error?.message ?? 'Gemini request failed.';
}

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * How long one Gemini request may take, reply included. A connection that dies
 * silently would otherwise leave capture on "Saving…" for ever; past this, the
 * keyword rules file the task and the note says why.
 */
export const GEMINI_TIMEOUT_MS = 15_000;

const TOO_SLOW = 'Gemini took too long to answer.';

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

async function call(path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  // One time limit for the request and its reply, so a body that never
  // finishes is a timeout too.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Gemini timed out', 'TimeoutError')),
    GEMINI_TIMEOUT_MS,
  );

  try {
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'x-goog-api-key': apiKey,
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      if (isTimeout(error) || controller.signal.aborted) throw new GeminiError(TOO_SLOW);
      throw new GeminiError('Could not reach Gemini. Check your connection.');
    }

    const body = await response.json().catch(() => {
      if (controller.signal.aborted) throw new GeminiError(TOO_SLOW);
      return null;
    });
    if (!response.ok) throw new GeminiError(describeGeminiError(body, response.status));
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score a model for this job: cheap, fast, text-only.
 * Higher is better; anything at or below zero is unsuitable.
 */
export function scoreModel(name: string): number {
  const id = name.toLowerCase();

  // Wrong modality or job entirely.
  if (/embedding|aqa|imagen|image-generation|tts|audio|video|veo|learnlm/.test(id)) return -1;

  let score = 0;
  if (id.includes('flash')) score += 100; // cheapest and fastest family
  if (id.includes('lite')) score += 20; // cheaper still
  if (id.includes('pro')) score += 40; // works, but overkill here

  // Prefer a stable release over previews and dated snapshots.
  if (/preview|exp|experimental/.test(id)) score -= 30;
  if (/\d{4}-\d{2}-\d{2}|\d{3,}$/.test(id)) score -= 10;
  if (id.includes('thinking')) score -= 25; // spends tokens reasoning about a one-word answer

  // Favour the newest version number present in the id.
  const version = /gemini-(\d+(?:\.\d+)?)/.exec(id);
  if (version) score += Number(version[1]) * 10;

  return score || 1;
}

export interface GeminiModel {
  id: string;
  label: string;
}

/**
 * Ask Google which models this key can actually use.
 *
 * Model ids change faster than any hardcoded default survives, so the app reads
 * the list rather than assuming one — this doubles as the key's validity check.
 */
export async function listGeminiModels(apiKey: string): Promise<GeminiModel[]> {
  const body = await call('/models?pageSize=200', apiKey, { method: 'GET' });
  const models = (body as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  })?.models;

  if (!Array.isArray(models)) return [];

  return models
    .filter((m) => m?.name)
    .filter((m) =>
      // Older responses omit the field; keep those rather than hide everything.
      !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'),
    )
    .map((m) => ({ id: m.name!.replace(/^models\//, ''), label: m.displayName ?? m.name! }))
    .filter((m) => scoreModel(m.id) > 0)
    .sort((a, b) => scoreModel(b.id) - scoreModel(a.id) || a.id.localeCompare(b.id));
}

/** The best available model for short classification, or null if none fit. */
export function pickDefaultModel(models: GeminiModel[]): string | null {
  return models[0]?.id ?? null;
}

/**
 * The options for the model dropdown. A saved model Google no longer lists — a
 * retired one, say — stays first, marked unavailable, so the dropdown shows the
 * model really in use and picking any listed one is a real change.
 */
export function modelChoices(
  models: GeminiModel[],
  current: string,
): Array<GeminiModel & { unavailable?: boolean }> {
  if (!models.length) return [{ id: current, label: current }];
  if (models.some((m) => m.id === current)) return models;
  return [{ id: current, label: `${current} (unavailable)`, unavailable: true }, ...models];
}

/**
 * One classification call. Throws {@link GeminiError}; callers fall back to rules.
 *
 * Gemini sees every category the user has and picks the best fit. Only when
 * none fits does it name a new one (`created: true` on the result), unless
 * `allowNew` is false.
 */
export async function classifyWithGemini(
  settings: GeminiSettings,
  input: RuleInput,
  /** Every category the user has, so Gemini can file into their own ones too. */
  categories: readonly string[] = BUILT_IN_CATEGORIES,
  { allowNew = true }: PromptOptions = {},
): Promise<CategorySignal> {
  const prompt = buildPrompt(input, categories, { allowNew });
  const path = `/models/${encodeURIComponent(settings.model)}:generateContent`;

  // temperature 0 for a stable answer, and JSON mode so the model escapes a
  // quote inside a Hebrew acronym (דו"ח) instead of breaking the reply.
  // maxOutputTokens is deliberately NOT set: on a reasoning model a small
  // budget is spent thinking and the reply comes back empty.
  const full = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  let body: unknown;
  try {
    body = await call(path, settings.apiKey, { method: 'POST', body: JSON.stringify(full) });
  } catch (error) {
    // If the API rejected an option rather than the key — a field name gone
    // stale, or a model without JSON mode — retry with the smallest body the
    // API accepts, so an option cannot break the app.
    const message = error instanceof Error ? error.message : '';
    if (!/invalid|unknown|unsupported|not enabled|json|mime|field/i.test(message)) throw error;
    body = await call(path, settings.apiKey, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  }

  const signal = parseGeminiReply(extractText(body), categories, { allowNew });
  if (!signal) throw new GeminiError('Gemini replied with no usable category.');
  const extracted = sanitizeExtraction(signal.extracted, input.title, input.now ?? new Date());

  // A tag that names a category wins outright, as with the keyword rules —
  // `@work` is a deliberate statement. Gemini still found the date.
  const tagged = categoryNamedByTags(input.tags, offered(categories));
  if (tagged) {
    return { category: tagged, confidence: 1, reason: 'named by a tag', source: 'gemini', extracted };
  }
  return { ...signal, source: 'gemini', extracted };
}

/**
 * A Categorizer that asks Gemini and quietly falls back to `fallback` on any
 * failure. `onError` lets the UI mention it without blocking the capture.
 */
export function createGeminiCategorizer(
  settings: GeminiSettings,
  fallback: Categorizer,
  onError?: (message: string) => void,
  /** Read at call time, so a category created a moment ago is already offered. */
  getCategories: () => readonly string[] = () => BUILT_IN_CATEGORIES,
): Categorizer {
  return {
    name: `gemini:${settings.model}`,
    async categorize(input) {
      const categories = input.categories ?? getCategories();
      try {
        return await classifyWithGemini(settings, input, categories);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Gemini request failed.';
        onError?.(reason);
        // The rules get the same list, so `@research` still names Research.
        const signal = await fallback.categorize({ ...input, categories });
        return { ...signal, source: 'rules', fallbackReason: reason };
      }
    },
  };
}
