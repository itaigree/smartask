import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryList, unseenCategories, isCustomCategory, categoryHue, loadCustomCategories,
} from '../src/lib/categories.ts';
import { normalizeCategoryName, type Task } from '../src/lib/types.ts';
import { buildView } from '../src/lib/views.ts';
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
  assert.deepEqual(unseenCategories(['Research'], [task('Research'), task('Kids'), task('Work')]), ['Kids']);
  assert.deepEqual(unseenCategories([], []), []);
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
