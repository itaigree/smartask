import { getCategorizer, type Categorizer } from './categorize/index.ts';
import { parseTask } from './parse.ts';
import type { NewTask } from './types.ts';

/**
 * The capture pipeline: raw text in, a fully-formed task draft out.
 * No Notion import, so it stays testable without the network (PLAN.md decision 4).
 */

export const MAX_TASK_LENGTH = 2000;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Throws {@link ValidationError} on anything the UI should refuse to send. */
export function validateText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError('Task text cannot be empty.');
  if (trimmed.length > MAX_TASK_LENGTH) {
    throw new ValidationError(`Task text is too long (max ${MAX_TASK_LENGTH} chars).`);
  }
  return trimmed;
}

/**
 * Parse the structure out of the text, then ask a categorizer where it belongs.
 * The categorizer is injected, so keyword rules and Gemini are interchangeable
 * and neither is baked into this pipeline.
 */
export async function draftFromText(
  text: string,
  now: Date = new Date(),
  categorizer: Categorizer = getCategorizer(),
): Promise<NewTask> {
  const parsed = parseTask(validateText(text), now);

  const { category } = await categorizer.categorize({
    title: parsed.title,
    note: parsed.note,
    project: parsed.project,
    tags: parsed.tags,
  });

  return {
    title: parsed.title,
    category,
    priority: parsed.priority,
    status: 'Todo',
    due: parsed.due,
    project: parsed.project,
    tags: parsed.tags,
    note: parsed.note,
  };
}
