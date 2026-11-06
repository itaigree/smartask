import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDraft, draftFromText, validateText, ValidationError, MAX_TASK_LENGTH } from '../src/lib/capture.ts';
import { setCategorizer } from '../src/lib/categorize/index.ts';
import { toISODate, addDays } from '../src/lib/parse.ts';

const NOW = new Date(2026, 10, 4, 9, 0, 0); // Wednesday
const iso = (days: number) => toISODate(addDays(NOW, days));

test('capture turns one line of text into a complete task draft', async () => {
  const draft = await draftFromText('pay the electricity bill friday !! #home @bills', NOW);
  assert.deepEqual(draft, {
    title: 'pay the electricity bill',
    category: 'Finance',
    priority: 'Urgent',
    status: 'Todo',
    due: iso(2),
    project: 'home',
    tags: ['bills'],
    note: null,
  });
});

test('unrecognisable text still produces a usable task', async () => {
  const draft = await draftFromText('zzz qqq', NOW);
  assert.equal(draft.title, 'zzz qqq');
  assert.equal(draft.category, 'Inbox');
  assert.equal(draft.priority, 'Normal');
  assert.equal(draft.due, null);
});

test('empty and oversized text are rejected before any network call', () => {
  assert.throws(() => validateText('   '), ValidationError);
  assert.throws(() => validateText('x'.repeat(MAX_TASK_LENGTH + 1)), ValidationError);
  assert.equal(validateText('  ok  '), 'ok');
});

test('swapping the categorizer changes the category and nothing else', async () => {
  setCategorizer({
    name: 'stub',
    async categorize() {
      return { category: 'Learning', confidence: 0.99, reason: 'stub' };
    },
  });
  try {
    const draft = await draftFromText('pay rent tomorrow', NOW);
    assert.equal(draft.category, 'Learning', 'the seam is the only thing deciding category');
    assert.equal(draft.title, 'pay rent');
    assert.equal(draft.due, iso(1));
  } finally {
    setCategorizer(null);
  }
});

test('capture reports who classified the task, so the UI can say so', async () => {
  const { draft, signal } = await captureDraft('pay rent tomorrow', NOW, {
    name: 'stub',
    async categorize() {
      return { category: 'Finance', confidence: 0.9, reason: 'rent', source: 'gemini' };
    },
  });
  assert.equal(draft.category, 'Finance');
  assert.equal(signal.source, 'gemini');
  assert.equal(signal.reason, 'rent');
});

test('the keyword rules mark their own answers', async () => {
  const { signal } = await captureDraft('zzz qqq', NOW);
  assert.equal(signal.source, 'rules');
  assert.equal(signal.category, 'Inbox');
});

/* ------------------------------------------------------------------ *
 * Dates found by an AI classifier
 * ------------------------------------------------------------------ */

const withExtraction = (due: string | null, title: string | null) => ({
  name: 'stub-ai',
  async categorize() {
    return {
      category: 'Finance' as const, confidence: 0.9, reason: 'stub', source: 'gemini' as const,
      extracted: { due, title },
    };
  },
});

test('an AI-found date fills the gap, and its cleaned title replaces the raw one', async () => {
  const { draft } = await captureDraft(
    'לשלם חשבון חשמל מחר', NOW, withExtraction(iso(1), 'לשלם חשבון חשמל'),
  );
  assert.equal(draft.due, iso(1));
  assert.equal(draft.title, 'לשלם חשבון חשמל');
});

test('a date the local parser found always wins over the AI', async () => {
  // The parser reads "friday" deterministically; a model disagreeing is ignored.
  const { draft } = await captureDraft(
    'pay rent friday', NOW, withExtraction(iso(5), 'pay rent'),
  );
  assert.equal(draft.due, iso(2), 'Wednesday -> Friday, from the parser');
  assert.equal(draft.title, 'pay rent');
});

test('with no AI title, the date is still used and the original title kept', async () => {
  const { draft } = await captureDraft('לשלם חשבון חשמל מחר', NOW, withExtraction(iso(1), null));
  assert.equal(draft.due, iso(1));
  assert.equal(draft.title, 'לשלם חשבון חשמל מחר');
});

test('the classifier is told the user\'s "now", so relative dates resolve locally', async () => {
  let seen: Date | undefined;
  await captureDraft('x', NOW, {
    name: 'spy',
    async categorize(input) {
      seen = input.now;
      return { category: 'Inbox', confidence: 0, reason: 'spy' };
    },
  });
  assert.equal(seen?.getTime(), NOW.getTime());
});
