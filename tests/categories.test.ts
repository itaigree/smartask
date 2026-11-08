import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryList, learnCategories, isCustomCategory, categoryHue, loadCustomCategories,
} from '../src/lib/categories.ts';
import {
  categoryKey, normalizeCategoryName, readCategoryName, sameCategory, type Task,
} from '../src/lib/types.ts';
import { buildView } from '../src/lib/views.ts';
import { sanitizeStoredTask } from '../src/lib/local-store.ts';
import {
  buildPrompt, parseGeminiReply, classifyWithGemini,
} from '../src/lib/categorize/gemini.ts';

let seq = 0;
const task = (category: string, o: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title: `task ${seq}`, category, priority: 'Normal', status: 'Todo',
  due: null, project: null, tags: [], note: null,
  createdAt: '2026-11-06T06:00:00Z', completedAt: null, url: null, ...o,
});

test('category names are cleaned, and ones Notion cannot hold are refused', () => {
  assert.equal(normalizeCategoryName('  Research   Lab '), 'Research Lab');
  assert.equal(normalizeCategoryName('מחקר'), 'מחקר', 'Hebrew names are fine');
  assert.equal(normalizeCategoryName('work'), 'Work', 'a built-in in other casing is the built-in');
  assert.equal(normalizeCategoryName('a, b'), null, 'commas are not allowed in Notion selects');
  assert.equal(normalizeCategoryName('   '), null);
  assert.equal(normalizeCategoryName('x'.repeat(41)), null, 'too long');
  assert.equal(normalizeCategoryName(7), null);
});

test('the list is built-ins, then custom A-Z, with Inbox last', () => {
  const list = categoryList(['Research', 'Kids'], [task('מחקר'), task('Work')]);
  assert.deepEqual(list.slice(0, 7), ['Work', 'Personal', 'Errands', 'Health', 'Finance', 'Learning', 'Home']);
  assert.deepEqual(list.slice(7, -1), ['Kids', 'Research', 'מחקר']);
  assert.equal(list.at(-1), 'Inbox');
});

test('duplicates in any casing collapse to one entry', () => {
  const list = categoryList(['Research', 'research', 'WORK'], [task('RESEARCH')]);
  assert.equal(list.filter((c) => c.toLowerCase() === 'research').length, 1);
  assert.equal(list.filter((c) => c.toLowerCase() === 'work').length, 1);
});

test('categories made on another device are learned from the tasks', () => {
  assert.deepEqual(learnCategories(['Research'], [task('Research'), task('Kids'), task('Work')]), ['Research', 'Kids']);
  assert.equal(learnCategories([], []), null, 'nothing to learn, nothing to save');
  assert.equal(learnCategories(['Research'], [task('Research')]), null);
});

test('built-ins are never treated as custom', () => {
  assert.equal(isCustomCategory('Work'), false);
  assert.equal(isCustomCategory('inbox'), false);
  assert.equal(isCustomCategory('Research'), true);
});

test('a custom category always gets the same colour', () => {
  assert.equal(categoryHue('Research'), categoryHue('research'));
  assert.notEqual(categoryHue('Research'), categoryHue('Kids'));
  assert.ok(categoryHue('מחקר') >= 0 && categoryHue('מחקר') < 360);
});

test('outside a browser the saved list is empty, not a crash', () => {
  assert.deepEqual(loadCustomCategories(), []);
});

test('the All view gives a custom category its own group, before Inbox', () => {
  const view = buildView('categories', [task('Inbox'), task('Research'), task('Work'), task('Kids')]);
  assert.deepEqual(view.groups.map((g) => g.label), ['Work', 'Kids', 'Research', 'Inbox']);
});

test('Gemini is offered the user\'s own categories', () => {
  const prompt = buildPrompt({ title: 'x' }, ['Research']);
  assert.match(prompt, /- Research: the user's own category/);
  assert.match(prompt, /- Work: /, 'built-ins still there');
  const lines = prompt.split('\n').filter((l) => /^- [^:]+:/.test(l));
  assert.match(lines.at(-1) ?? '', /^- Inbox:/, 'Inbox stays last');
});

test('Gemini may answer with a custom category, in any casing', () => {
  const signal = parseGeminiReply('{"category":"research"}', ['Research']);
  assert.equal(signal?.category, 'Research', 'returned in the user\'s own spelling');
  assert.equal(parseGeminiReply('{"category":"Research"}')?.category, undefined,
    'but not one the user does not have');
  assert.equal(parseGeminiReply('Research', ['Research'])?.category, 'Research', 'bare word too');
});

test('a longer custom name is not mistaken for a built-in inside it', () => {
  assert.equal(parseGeminiReply('Home Office', ['Home Office'])?.category, 'Home Office');
});

test('the categories reach the live request', async () => {
  let prompt = '';
  const original = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"category":"Research"}' }] } }],
    }), { status: 200 });
  };
  try {
    const signal = await classifyWithGemini({ apiKey: 'k', model: 'm' }, { title: 'IRB form' }, ['Research']);
    assert.equal(signal.category, 'Research');
    assert.match(prompt, /- Research:/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---- One rule for category identity (R2-1, R2-3, R2-12, R3-9) ---- */

const RLM = '\u200F';
const ZWSP = '\u200B';

test('R3-9: invisible marks never make a second category', () => {
  assert.equal(normalizeCategoryName(`מחקר${RLM}`), 'מחקר', 'a mark copied from WhatsApp');
  assert.equal(normalizeCategoryName(`${RLM}Work`), 'Work', 'a marked built-in is the built-in');
  assert.equal(normalizeCategoryName(`Re${ZWSP}search\uFEFF`), 'Research', 'zero-width space and BOM anywhere');
  assert.equal(normalizeCategoryName('\u200D\u200Cפרויקט\u200D'), 'פרויקט', 'stray joiners at the ends');
  assert.equal(normalizeCategoryName(`${RLM} ${ZWSP}`), null, 'nothing visible is no name');
  assert.equal(normalizeCategoryName('Cafe\u0301'), 'Caf\u00E9', 'Unicode is normalised (NFC)');
  assert.ok(sameCategory(`מחקר${RLM}`, 'מחקר'));
  assert.equal(readCategoryName(`מחקר${RLM}`), 'מחקר', 'marks also go when a name is read back');
  assert.deepEqual(
    categoryList([`מחקר${RLM}`], [task('מחקר')]).filter((c) => c.startsWith('מחקר')), ['מחקר'],
  );
});

test('joiners inside a name are kept: they shape emoji and some scripts', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family';
  assert.equal(normalizeCategoryName(family), family);
});

test('R2-3: letter case never splits a category, and the tasks\' spelling wins', () => {
  assert.equal(categoryKey('Research'), categoryKey(' research '));
  // Saved on the device as "research" (phone-only), but the Notion tasks say "Research".
  const list = categoryList(['research'], [task('Research')]);
  assert.deepEqual(list.filter((c) => sameCategory(c, 'research')), ['Research']);
  assert.deepEqual(learnCategories(['research', 'Kids'], [task('Research')]), ['Research', 'Kids'],
    'the saved entry takes the tasks\' spelling, in place');
  assert.equal(learnCategories(['Research', 'Kids'], [task('Research')]), null, 'then it is settled');
  assert.deepEqual(learnCategories(['Research', 'research', `research${RLM}`], []), ['Research'],
    'a saved list with two spellings of one category keeps one');
  assert.equal(isCustomCategory(`Work${RLM}`), false);
});

test('R2-3: Gemini is offered the tasks\' spelling, so its answer is written in it', () => {
  const offeredNow = categoryList(learnCategories(['research'], [task('Research')]) ?? []);
  assert.equal(parseGeminiReply('{"category":"research"}', offeredNow)?.category, 'Research');
  assert.equal(parseGeminiReply(`{"category":"Research${RLM}"}`, offeredNow)?.category, 'Research');
});

test('R2-1: a long name made in Notion is kept, listed and offered', () => {
  const long = 'Thesis chapter 3 revisions for my supervisor';
  assert.ok(long.length > 40);
  assert.equal(readCategoryName(long), long, 'read as it is stored');
  assert.equal(normalizeCategoryName(long), null, 'but still too long to type in the app');
  assert.ok(categoryList([], [task(long)]).includes(long), 'the picker can move a task back to it');
  assert.deepEqual(learnCategories([], [task(long)]), [long]);
  assert.equal(parseGeminiReply(`{"category":"${long}"}`, [long])?.category, long);
});

test('R2-12: spacing inside a stored name is kept, so it is written back unchanged', () => {
  assert.equal(readCategoryName('Side  Project'), 'Side  Project');
  assert.ok(sameCategory('Side  Project', 'side project'), 'but it is the same category');
  assert.deepEqual(
    categoryList(['Side Project'], [task('Side  Project')]).filter((c) => c.startsWith('Side')),
    ['Side  Project'],
  );
  assert.equal(parseGeminiReply('{"category":"Side Project"}', ['Side  Project'])?.category, 'Side  Project');
});

test('a hue does not change with letter case or invisible marks', () => {
  assert.equal(categoryHue(`מחקר${RLM}`), categoryHue('מחקר'));
});

test('R2-1: a task kept on the phone reads its category by the same rule as Notion', () => {
  // The category list is shared by both stores, so a long name learned from
  // Notion can be picked for a phone-only task; a reload must not make it Inbox.
  const long = 'Thesis chapter 3 revisions for my supervisor';
  const read = (category: unknown) =>
    sanitizeStoredTask({ id: 'a', title: 'x', category })?.category;
  assert.equal(read(long), long);
  assert.equal(read(`מחקר${RLM}`), 'מחקר', 'invisible marks go here too');
  assert.equal(read('research '), 'research');
  assert.equal(read('WORK'), 'Work');
  assert.equal(read(` ${ZWSP} `), 'Inbox', 'nothing visible is no category');
});
