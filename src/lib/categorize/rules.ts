import {
  BUILT_IN_CATEGORIES, categoryKey, isBuiltInCategory, readCategoryName,
  type BuiltInCategory, type Category,
} from '../types.ts';
import type { CategorySignal, Categorizer } from './index.ts';

/**
 * Keyword rules, ordered by how specific the category is. Ties break towards
 * the category listed first, so narrow domains (Finance, Health) win over the
 * broad ones (Work, Personal).
 *
 * Multi-word phrases score 2, single words score 1 — "pick up" should beat a
 * stray "up". Keep these lowercase; matching is case-insensitive.
 */
const RULES: Array<[BuiltInCategory, string[]]> = [
  ['Finance', [
    'pay', 'paid', 'bill', 'bills', 'rent', 'invoice', 'tax', 'taxes', 'vat',
    'bank', 'salary', 'budget', 'insurance', 'refund', 'subscription',
    'transfer', 'mortgage', 'loan', 'overdraft', 'credit card', 'debit',
    'pension', 'savings', 'accountant', 'receipt', 'expense', 'expenses',
  ]],
  ['Health', [
    'doctor', 'dentist', 'dental', 'gym', 'workout', 'physio', 'medicine',
    'pharmacy', 'therapy', 'therapist', 'vaccine', 'vaccination', 'checkup',
    'check-up', 'prescription', 'clinic', 'hospital', 'blood test', 'optician',
    'glasses', 'nutrition', 'calories', 'yoga', 'stretch',
  ]],
  ['Learning', [
    'read', 'reading', 'course', 'study', 'studying', 'learn', 'tutorial',
    'exam', 'homework', 'lecture', 'thesis', 'textbook', 'revise', 'revision',
    'assignment', 'syllabus', 'practice', 'flashcards', 'certification',
  ]],
  ['Errands', [
    'buy', 'pick up', 'pickup', 'drop off', 'groceries', 'grocery', 'shop',
    'shopping', 'supermarket', 'post office', 'parcel', 'package', 'deliver',
    'delivery', 'laundry', 'dry cleaning', 'car wash', 'petrol', 'fuel',
    'refill', 'collect', 'errand', 'queue',
  ]],
  ['Home', [
    'clean', 'tidy', 'fix', 'repair', 'plumber', 'electrician', 'furniture',
    'garden', 'dishes', 'trash', 'bins', 'vacuum', 'hoover', 'paint',
    'assemble', 'ikea', 'lightbulb', 'boiler', 'landlord', 'heating',
    'declutter', 'mow',
  ]],
  ['Work', [
    'meeting', 'standup', 'stand-up', 'client', 'deck', 'slides', 'report',
    'deadline', 'sprint', 'ticket', 'jira', 'deploy', 'release', 'spec',
    'roadmap', 'okr', 'onboarding', 'interview', 'presentation', 'colleague',
    'manager', 'stakeholder', 'kickoff', 'retro', 'pull request', 'code review',
    'slack', 'email', 'inbox zero', 'timesheet', 'contract',
  ]],
  ['Personal', [
    'call', 'text', 'birthday', 'gift', 'present', 'friend', 'family', 'mum',
    'mom', 'dad', 'parents', 'dinner', 'lunch', 'party', 'visit', 'wedding',
    'trip', 'flight', 'hotel', 'holiday', 'vacation', 'anniversary', 'haircut',
    'date night', 'catch up', 'rsvp',
  ]],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pre-compiled so categorising a task is a handful of regex tests. */
const COMPILED = RULES.map(([category, words]) => ({
  category,
  matchers: words.map((word) => ({
    word,
    re: new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'),
    weight: word.includes(' ') ? 2 : 1,
  })),
}));

export interface RuleInput {
  title: string;
  note?: string | null;
  project?: string | null;
  tags?: string[];
  /** The user's local "now", for classifiers that resolve relative dates. Rules ignore it. */
  now?: Date;
  /**
   * Every category the user has, so `@research` can name their own Research.
   * The built-ins when absent.
   */
  categories?: readonly string[];
  /**
   * A few task titles already filed in each of the user's own categories,
   * keyed by `categoryKey` — what the category holds, beyond its name. For
   * classifiers that read by meaning; the keyword rules ignore it.
   */
  examples?: ReadonlyMap<string, readonly string[]>;
}

/** A tag cannot hold a space, so `side-project` and `side_project` both mean "Side Project". */
const tokenKey = (name: string) => categoryKey(name.replace(/[-_]+/g, ' '));

/**
 * The category a tag or project names, in the user's spelling, or null —
 * `@work`, `@research`, `#מחקר`. Inbox is never named this way: it is where a
 * task goes when nothing decides, not a place to send one.
 */
export function categoryNamedBy(
  token: string | null | undefined,
  categories: readonly string[] = BUILT_IN_CATEGORIES,
): Category | null {
  if (!token) return null;
  const key = tokenKey(token);
  if (key === 'inbox') return null;
  return [...categories, ...BUILT_IN_CATEGORIES].find((c) => tokenKey(c) === key) ?? null;
}

/** The first tag that names a category, which then wins outright. */
export function categoryNamedByTags(
  tags: readonly string[] | undefined,
  categories?: readonly string[],
): Category | null {
  for (const tag of tags ?? []) {
    const category = categoryNamedBy(tag, categories);
    if (category) return category;
  }
  return null;
}

/** Letters a Hebrew word takes in front: "הרכב", "לרכב", "מהרכב", "שברכב". */
const HEBREW_PREFIX = '[הבלמשוכ]{0,2}';

/**
 * How a category name may be spelled inside a task: the name itself, with a
 * plain English plural added or dropped ("Car" for "cars", "Pets" for "pet").
 */
function nameForms(name: string): string[] {
  const key = categoryKey(name);
  const forms = new Set([key]);
  if (/[a-z]$/.test(key)) {
    if (!key.endsWith('s')) forms.add(`${key}s`);
    else if (key.length > 3 && !key.endsWith('ss')) forms.add(key.slice(0, -1));
  }
  return [...forms];
}

/**
 * The category of the user's own that the task text names, or null: "Car" for
 * "take the car to the garage", "רכב" for "לקחת את הרכב למוסך".
 *
 * Only their own categories count. They made each one for a kind of task, so
 * its name in a task is deliberate evidence; the built-ins are everyday words
 * ("work out", "home page") and are matched by the keyword lists instead.
 * The longest name wins, so "Car Insurance" is not read as "Car".
 */
export function categoryNamedInText(
  text: string,
  categories: readonly string[] = [],
): Category | null {
  const own = categories
    .map(readCategoryName)
    .filter((name): name is string => name !== null && !isBuiltInCategory(name))
    .sort((a, b) => b.length - a.length);

  const haystack = text.normalize('NFC');
  for (const name of own) {
    // A one-letter name would match far too much to mean anything.
    if (categoryKey(name).replace(/[^\p{L}\p{N}]/gu, '').length < 2) continue;
    const forms = nameForms(name)
      .map((form) => form.split(/[\s\-_]+/).map(escapeRegExp).join('[\\s\\-_]+'))
      .join('|');
    const prefix = /^\p{Script=Hebrew}/u.test(name) ? HEBREW_PREFIX : '';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${prefix}(?:${forms})(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(haystack)) return name;
  }
  return null;
}

/**
 * Whether the keyword rules can read this text at all. Their word lists are
 * English, so a task with letters in another script (Hebrew, say) only ever
 * reaches a category through a tag or project.
 */
export function rulesCanRead(text: string): boolean {
  return !/(?!\p{Script=Latin})\p{L}/u.test(text);
}

/**
 * Score every category against the text and return the winner.
 *
 * The user's own categories are gone through first, then the keyword lists
 * for the built-in ones; a task nothing fits goes to Inbox, where the app
 * offers to pick or create a category for it.
 *
 * Two tiers of explicit naming, because `#` and `@` mean different things:
 *
 * - A **tag** that names a category — a built-in or one of the user's own —
 *   wins outright. `@work` is a label; using a category name as one is a
 *   deliberate statement about where the task belongs. Gemini honours it too.
 * - A **project** that names a category is only a fallback. `#home` on "pay the
 *   electricity bill" means the household project, not the Home category — the
 *   keywords in the text are the better evidence, so they win.
 */
export function categorizeByRules(input: RuleInput): CategorySignal {
  const taggedCategory = categoryNamedByTags(input.tags, input.categories);
  if (taggedCategory) {
    return { category: taggedCategory, confidence: 1, reason: 'named by a tag', source: 'rules' };
  }

  const haystack = [input.title, input.note ?? '', ...(input.tags ?? [])]
    .join(' ')
    .toLowerCase();

  // A category the user made, named in the task itself, is more specific than
  // any built-in the keywords could reach: "renew the car insurance" belongs
  // in their Car, not in Finance.
  const named = categoryNamedInText(haystack, input.categories);
  if (named) {
    return { category: named, confidence: 0.8, reason: 'mentions your category', source: 'rules' };
  }

  let best: { category: BuiltInCategory; score: number; hits: string[] } | null = null;

  for (const { category, matchers } of COMPILED) {
    let score = 0;
    const hits: string[] = [];
    for (const { word, re, weight } of matchers) {
      if (re.test(haystack)) {
        score += weight;
        hits.push(word);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { category, score, hits };
  }

  if (!best) {
    // Nothing in the text to go on: fall back to the project name, if it
    // happens to name a category, before giving up to Inbox.
    const projectCategory = categoryNamedBy(input.project, input.categories);
    if (projectCategory) {
      return {
        category: projectCategory, confidence: 0.6, reason: 'named by the project', source: 'rules',
      };
    }
    return { category: 'Inbox', confidence: 0, reason: 'no keyword matched', source: 'rules' };
  }

  return {
    category: best.category,
    // Two solid hits is already decisive; cap so rules never claim certainty.
    confidence: Math.min(0.9, 0.45 + best.score * 0.15),
    reason: `matched ${best.hits.slice(0, 3).join(', ')}`,
    source: 'rules',
  };
}

export const rulesCategorizer: Categorizer = {
  name: 'rules',
  async categorize(input) {
    return categorizeByRules(input);
  },
};
