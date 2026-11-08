import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeByRules, categoryNamedByTags, rulesCanRead,
} from '../src/lib/categorize/rules.ts';
import { getCategorizer, withCategories } from '../src/lib/categorize/index.ts';

const cat = (title: string, extra: Partial<Parameters<typeof categorizeByRules>[0]> = {}) =>
  categorizeByRules({ title, ...extra }).category;

test('domain keywords pick the obvious category', () => {
  assert.equal(cat('pay the electricity bill'), 'Finance');
  assert.equal(cat('book a dentist appointment'), 'Health');
  assert.equal(cat('buy groceries'), 'Errands');
  assert.equal(cat('prepare the client deck'), 'Work');
  assert.equal(cat('read the scvi paper'), 'Learning');
  assert.equal(cat('fix the leaking boiler'), 'Home');
  assert.equal(cat("call mum about dad's birthday"), 'Personal');
});

test('narrow categories beat broad ones on a tie', () => {
  // "call" is Personal, "bank" is Finance — Finance is the more specific signal.
  assert.equal(cat('call the bank about the overdraft'), 'Finance');
});

test('nothing recognisable falls through to Inbox', () => {
  const signal = categorizeByRules({ title: 'zzz qqq' });
  assert.equal(signal.category, 'Inbox');
  assert.equal(signal.confidence, 0);
});

test('a tag that names a category wins outright', () => {
  assert.equal(cat('zzz qqq', { tags: ['health'] }), 'Health');
  assert.equal(cat('buy groceries', { tags: ['Work'] }), 'Work', 'it beats the keywords');
  assert.equal(categorizeByRules({ title: 'x', tags: ['work'] }).confidence, 1);
});

test('a project that names a category is only a fallback', () => {
  // Nothing else to go on: the project decides.
  assert.equal(cat('zzz qqq', { project: 'work' }), 'Work');
  // But real evidence in the text beats it — "#home" here is the household
  // project, and paying a bill is still Finance.
  assert.equal(cat('pay the electricity bill', { project: 'home' }), 'Finance');
  assert.equal(categorizeByRules({ title: 'zzz', project: 'work' }).confidence, 0.6);
});

test('multi-word phrases outweigh single words', () => {
  assert.equal(cat('pick up the dry cleaning'), 'Errands');
});

test('confidence rises with the number of hits but never reaches 1', () => {
  const weak = categorizeByRules({ title: 'rent' });
  const strong = categorizeByRules({ title: 'pay the rent and the mortgage invoice' });
  assert.ok(strong.confidence > weak.confidence);
  assert.ok(strong.confidence < 1);
  assert.match(strong.reason, /matched/);
});

test('the note and tags are part of the haystack', () => {
  assert.equal(cat('follow up', { note: 'ask the dentist about the x-ray' }), 'Health');
  assert.equal(cat('follow up', { tags: ['invoice'] }), 'Finance');
});

/* ---- R2-9: tags and projects can name the user's own categories ---- */

const mine = ['Work', 'Personal', 'Errands', 'Health', 'Finance', 'Learning', 'Home', 'Research', 'Side Project', 'מחקר', 'Inbox'];

test('R2-9: a tag naming one of the user\'s own categories wins, in their spelling', () => {
  assert.equal(cat('IRB renewal form', { tags: ['research'], categories: mine }), 'Research');
  assert.equal(cat('לחדש טופס', { tags: ['מחקר'], categories: mine }), 'מחקר');
  assert.equal(cat('pay the bill', { tags: ['side-project'], categories: mine }), 'Side Project',
    'a tag cannot hold a space, so - or _ stands for one');
  assert.equal(cat('pay the bill', { tags: ['side_project'], categories: mine }), 'Side Project');
  assert.equal(cat('IRB renewal form', { tags: ['research'] }), 'Inbox',
    'without the list, only the built-ins can be named');
});

test('R2-9: a project can name the user\'s own category as the fallback', () => {
  assert.equal(cat('zzz qqq', { project: 'Research', categories: mine }), 'Research');
  assert.equal(cat('pay the bill', { project: 'research', categories: mine }), 'Finance',
    'the keywords still come first');
});

test('a tag cannot send a task to Inbox', () => {
  assert.equal(categorizeByRules({ title: 'pay rent', tags: ['inbox'], categories: mine }).category, 'Finance');
  assert.equal(categoryNamedByTags(['inbox', 'home'], mine), 'Home');
});

test('R2-9: only text in Latin script is something the keyword rules can read', () => {
  assert.equal(rulesCanRead('IRB renewal form'), true);
  assert.equal(rulesCanRead('Café crème 25/12 !!'), true, 'accented Latin letters, digits, marks');
  assert.equal(rulesCanRead('לחדש טופס IRB'), false);
  assert.equal(rulesCanRead('купить молоко'), false);
  assert.equal(rulesCanRead('123'), true, 'no letters, nothing unreadable');
});

test('withCategories tells a categorizer the user\'s current list on every call', async () => {
  let list = ['Research'];
  const categorizer = withCategories(getCategorizer(), () => list);
  assert.equal((await categorizer.categorize({ title: 'x', tags: ['research'] })).category, 'Research');
  list = ['Kids'];
  assert.equal((await categorizer.categorize({ title: 'x', tags: ['kids'] })).category, 'Kids',
    'read at call time, so a category made a moment ago counts');
  assert.equal(categorizer.name, 'rules');
});

test('getCategorizer returns the rules implementation by default', async () => {
  const c = getCategorizer();
  assert.equal(c.name, 'rules');
  assert.equal((await c.categorize({ title: 'pay rent' })).category, 'Finance');
});
