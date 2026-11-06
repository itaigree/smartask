import { BUILT_IN_CATEGORIES, type BuiltInCategory, type Category } from '../types.ts';
import { addDays, toISODate } from '../parse.ts';
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
  Inbox: 'LAST RESORT: only when there is genuinely no clue at all what the task is about',
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
 * The categories to offer: the built-ins plus any the user created, Inbox
 * kept last so it reads as the fallback it is.
 */
function offered(categories: readonly string[]): string[] {
  const list = [...new Set([...BUILT_IN_CATEGORIES, ...categories])].filter((c) => c !== 'Inbox');
  return [...list, 'Inbox'];
}

export function buildPrompt(
  input: RuleInput,
  categories: readonly string[] = BUILT_IN_CATEGORIES,
): string {
  const now = input.now ?? new Date();
  const lines = [
    'Classify this personal task into exactly one category.',
    '',
    'The task may be written in any language — often Hebrew — and is usually short.',
    'Classify it by meaning. Always answer with the English category name.',
    '',
    'Categories:',
    ...offered(categories).map(describeCategory),
    '',
    'Examples:',
    ...EXAMPLES.map(([task, category]) => `${JSON.stringify(task)} -> ${category}`),
    '',
    `Task: ${JSON.stringify(input.title)}`,
  ];

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
    '{"category": "<one category from the list>", "due": "<YYYY-MM-DD or null>", "title": "<task without date words>", "confidence": <0 to 1>, "reason": "<at most 8 words>"}',
  );

  return lines.join('\n');
}

/**
 * Pull a usable signal out of whatever the model said.
 *
 * Models wrap JSON in code fences, add a preamble, or answer with a bare word.
 * All of those are recoverable, so parse leniently and validate strictly — an
 * unrecognised category is discarded rather than trusted.
 */
export function parseGeminiReply(
  text: string,
  allowed: readonly string[] = BUILT_IN_CATEGORIES,
): CategorySignal | null {
  if (!text) return null;

  // Match case-insensitively, but always return the user's own spelling.
  const choices = offered(allowed);
  const canonical = (name: unknown): Category | null =>
    typeof name === 'string'
      ? choices.find((c) => c.toLowerCase() === name.trim().toLowerCase()) ?? null
      : null;

  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const match = /\{[\s\S]*\}/.exec(stripped);

  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        category?: unknown;
        confidence?: unknown;
        reason?: unknown;
        due?: unknown;
        title?: unknown;
      };
      const category = canonical(parsed.category);
      if (category) {
        const raw = Number(parsed.confidence);
        const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.8;
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 80)
          : 'classified by Gemini';
        return {
          category,
          confidence,
          reason,
          // Unvalidated here; sanitizeExtraction() decides what survives.
          extracted: {
            due: typeof parsed.due === 'string' ? parsed.due : null,
            title: typeof parsed.title === 'string' ? parsed.title : null,
          },
        };
      }
    } catch {
      // Fall through to the bare-word search below.
    }
  }

  // No usable JSON: accept a reply that is just a category name. Longer names
  // first, so "Home Office" is not read as "Home".
  for (const category of [...choices].sort((a, b) => b.length - a.length)) {
    const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'iu').test(stripped)) {
      return { category, confidence: 0.6, reason: 'classified by Gemini' };
    }
  }

  return null;
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

/**
 * Decide which parts of what the model extracted can be trusted.
 *
 * - The date must be a real date, and plausible for a task: up to a week in the
 *   past (something already overdue), no more than three years ahead.
 * - The title may only *remove* words. Every word in it must already be in the
 *   original, so a model that translates or rephrases the task is ignored and
 *   the user's own words are kept.
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
  if (candidate && candidate.length <= originalTitle.length) {
    const allowed = new Set(words(originalTitle));
    const used = words(candidate);
    if (used.length > 0 && used.every((w) => allowed.has(w))) title = candidate;
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

/** Turn Google's error envelope into one sentence worth showing. */
export function describeGeminiError(body: unknown, status?: number): string {
  const error = (body as { error?: { message?: string; status?: string; details?: unknown[] } })
    ?.error;

  const reason = (error?.details as Array<{ reason?: string }> | undefined)?.find(
    (d) => typeof d?.reason === 'string',
  )?.reason;

  if (reason === 'API_KEY_INVALID') {
    return 'Google rejected the API key. Check you pasted it in full.';
  }
  if (reason === 'SERVICE_DISABLED' || error?.status === 'PERMISSION_DENIED') {
    return 'That key cannot use the Gemini API. Create one at aistudio.google.com/apikey.';
  }
  if (status === 429 || error?.status === 'RESOURCE_EXHAUSTED') {
    return 'Gemini rate limit reached. It will work again shortly.';
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

async function call(path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        'x-goog-api-key': apiKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new GeminiError('Could not reach Gemini. Check your connection.');
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new GeminiError(describeGeminiError(body, response.status));
  return body;
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

/** One classification call. Throws {@link GeminiError}; callers fall back to rules. */
export async function classifyWithGemini(
  settings: GeminiSettings,
  input: RuleInput,
  /** Every category the user has, so Gemini can file into their own ones too. */
  categories: readonly string[] = BUILT_IN_CATEGORIES,
): Promise<CategorySignal> {
  const prompt = buildPrompt(input, categories);
  const path = `/models/${encodeURIComponent(settings.model)}:generateContent`;

  // temperature 0 for a stable answer. maxOutputTokens is deliberately NOT set:
  // on a reasoning model a small budget is spent thinking and the reply comes
  // back empty.
  const full = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  };

  let body: unknown;
  try {
    body = await call(path, settings.apiKey, { method: 'POST', body: JSON.stringify(full) });
  } catch (error) {
    // If the API rejected a field rather than the key, retry with the smallest
    // body the API accepts, so an option name going stale cannot break the app.
    const message = error instanceof Error ? error.message : '';
    if (!/invalid|unknown|unsupported|field/i.test(message)) throw error;
    body = await call(path, settings.apiKey, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  }

  const signal = parseGeminiReply(extractText(body), categories);
  if (!signal) throw new GeminiError('Gemini replied with no usable category.');
  return {
    ...signal,
    source: 'gemini',
    extracted: sanitizeExtraction(signal.extracted, input.title, input.now ?? new Date()),
  };
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
      try {
        return await classifyWithGemini(settings, input, getCategories());
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Gemini request failed.';
        onError?.(reason);
        const signal = await fallback.categorize(input);
        return { ...signal, source: 'rules', fallbackReason: reason };
      }
    },
  };
}
