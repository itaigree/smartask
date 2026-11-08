import type { Category } from '../types.ts';
import { rulesCategorizer, type RuleInput } from './rules.ts';

export interface CategorySignal {
  category: Category;
  /** 0–1. Low confidence is what a future UI would use to ask for a confirmation. */
  confidence: number;
  reason: string;
  /**
   * Which classifier actually produced this answer. The UI shows it, because
   * "Inbox from Gemini" and "Inbox because Gemini failed" need different fixes.
   */
  source?: 'rules' | 'gemini';
  /** Set when an AI classifier was tried and the rules answered instead. */
  fallbackReason?: string;
  /**
   * True when no existing category fitted and the classifier named a new one.
   * The category is not in the user's list yet; saving the task adds it.
   */
  created?: boolean;
  /**
   * Structure an AI found that the local parser could not — a Hebrew date, say.
   * Already validated by the classifier; capture only uses it to fill gaps.
   */
  extracted?: {
    /** `YYYY-MM-DD`, or null when the task names no date. */
    due: string | null;
    /** The title with the date words removed; null when it failed validation. */
    title: string | null;
  };
}

/**
 * The seam between the app and whatever decides a category.
 *
 * PLAN.md decision 3: swapping keyword rules for a Claude-backed categorizer
 * means adding one file and changing `getCategorizer()` — nothing else in the
 * app imports `rules.ts` directly.
 */
export interface Categorizer {
  name: string;
  categorize(input: RuleInput): Promise<CategorySignal>;
}

export type { RuleInput };

let cached: Categorizer | null = null;

export function getCategorizer(): Categorizer {
  if (cached) return cached;
  // Phase 8 will select a Claude-backed categorizer here when ANTHROPIC_API_KEY
  // is present. Until then there is exactly one implementation.
  cached = rulesCategorizer;
  return cached;
}

/** Test seam: force a specific implementation. */
export function setCategorizer(next: Categorizer | null): void {
  cached = next;
}
