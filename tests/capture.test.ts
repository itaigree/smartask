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
