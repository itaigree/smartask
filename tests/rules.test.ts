import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeByRules } from '../src/lib/categorize/rules.ts';
import { getCategorizer } from '../src/lib/categorize/index.ts';

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

test('an explicit project or tag names the category outright', () => {
  assert.equal(cat('zzz qqq', { project: 'work' }), 'Work');
  assert.equal(cat('zzz qqq', { tags: ['health'] }), 'Health');
  // ...and overrides the keywords.
  assert.equal(cat('buy groceries', { project: 'Work' }), 'Work');
  assert.equal(categorizeByRules({ title: 'x', project: 'work' }).confidence, 1);
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

test('getCategorizer returns the rules implementation by default', async () => {
  const c = getCategorizer();
  assert.equal(c.name, 'rules');
  assert.equal((await c.categorize({ title: 'pay rent' })).category, 'Finance');
});
