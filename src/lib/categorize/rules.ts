import type { Category } from '../types.ts';
import type { CategorySignal, Categorizer } from './index.ts';

/**
 * Keyword rules, ordered by how specific the category is. Ties break towards
 * the category listed first, so narrow domains (Finance, Health) win over the
 * broad ones (Work, Personal).
 *
 * Multi-word phrases score 2, single words score 1 — "pick up" should beat a
 * stray "up". Keep these lowercase; matching is case-insensitive.
 */
const RULES: Array<[Category, string[]]> = [
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

/** Lowercase category names, so `#work` or `@health` can name a category outright. */
const BY_NAME = new Map<string, Category>(
  RULES.map(([category]) => [category.toLowerCase(), category]),
);

export interface RuleInput {
  title: string;
  note?: string | null;
  project?: string | null;
  tags?: string[];
}

/**
 * Score every category against the text and return the winner.
 *
 * Two tiers of explicit naming, because `#` and `@` mean different things:
 *
 * - A **tag** that names a category wins outright. `@work` is a label; using a
 *   category name as one is a deliberate statement about where the task belongs.
 * - A **project** that names a category is only a fallback. `#home` on "pay the
 *   electricity bill" means the household project, not the Home category — the
 *   keywords in the text are the better evidence, so they win.
 */
export function categorizeByRules(input: RuleInput): CategorySignal {
  const taggedCategory = input.tags
    ?.map((tag) => BY_NAME.get(tag.toLowerCase()))
    .find((category): category is Category => Boolean(category));

  if (taggedCategory) {
    return { category: taggedCategory, confidence: 1, reason: 'named by a tag', source: 'rules' };
  }

  const haystack = [input.title, input.note ?? '', ...(input.tags ?? [])]
    .join(' ')
    .toLowerCase();

  let best: { category: Category; score: number; hits: string[] } | null = null;

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
    const projectCategory = BY_NAME.get((input.project ?? '').toLowerCase());
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
