import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDatabaseId, validateToken, maskToken, loadConfig, saveConfig,
  cleanSecret, validateApiKey, loadGeminiConfig,
} from '../src/lib/config.ts';

test('a database id is pulled out of whatever the user pastes', () => {
  const expected = '0a8fbd62-49a9-48a7-a23a-68ee2e74e191';
  assert.equal(normalizeDatabaseId('0a8fbd6249a948a7a23a68ee2e74e191'), expected);
  assert.equal(normalizeDatabaseId(expected), expected);
  assert.equal(
    normalizeDatabaseId('https://www.notion.so/SmartTask-0a8fbd6249a948a7a23a68ee2e74e191?v=xyz'),
    expected,
  );
  assert.equal(normalizeDatabaseId('https://app.notion.com/p/0a8fbd6249a948a7a23a68ee2e74e191'), expected);
  assert.equal(normalizeDatabaseId('  0A8FBD6249A948A7A23A68EE2E74E191  '), expected,
    'case and surrounding text do not matter');
});

test('nonsense is rejected rather than half-accepted', () => {
  assert.equal(normalizeDatabaseId(''), null);
  assert.equal(normalizeDatabaseId('not an id'), null);
  assert.equal(normalizeDatabaseId('abc123'), null, 'too short to be a Notion id');
});

test('a token with whitespace is refused, because that means a bad paste', () => {
  assert.equal(validateToken('ntn_abc123'), 'ntn_abc123');
  assert.equal(validateToken('  ntn_abc123  '), 'ntn_abc123', 'surrounding space is trimmed');
  assert.equal(validateToken('ntn_abc 123'), null);
  assert.equal(validateToken('ntn_abc\n123'), null);
  assert.equal(validateToken(''), null);
});

test('a token is never shown in full', () => {
  const masked = maskToken('ntn_abcdefghijklmnop');
  assert.ok(!masked.includes('defghijklm'));
  assert.ok(masked.startsWith('ntn_ab'));
  assert.ok(masked.endsWith('mnop'));
  assert.equal(maskToken('short'), '••••');
});

test('with no browser present, config reads as absent rather than throwing', () => {
  // Node has no `window`, which is the same guard that protects the build-time
  // prerender. It must degrade, never crash.
  assert.equal(loadConfig(), null);
  assert.equal(saveConfig({ token: 't', databaseId: 'd' }), false,
    'saving reports failure instead of throwing, so the UI can say so');
});

test('the Notion link points at the connected database, in the form notion.so resolves', async () => {
  const { notionDatabaseUrl } = await import('../src/lib/config.ts');
  assert.equal(
    notionDatabaseUrl('0a8fbd62-49a9-48a7-a23a-68ee2e74e191'),
    'https://www.notion.so/0a8fbd6249a948a7a23a68ee2e74e191',
  );
});

test('R1-3/R2-5: a link whose title ends in a hex character still gives the right id', async () => {
  const { normalizeId } = await import('../scripts/lib/env.mjs');
  const expected = '0a8fbd62-49a9-48a7-a23a-68ee2e74e191';
  const links = [
    'https://www.notion.so/myworkspace/Tasks-DB-0a8fbd6249a948a7a23a68ee2e74e191?v=1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f',
    'https://www.notion.so/myws/My-Home-0a8fbd6249a948a7a23a68ee2e74e191',
    'https://www.notion.so/Life-0a8fbd6249a948a7a23a68ee2e74e191',
    'https://www.notion.so/Tasks-2026-0a8fbd6249a948a7a23a68ee2e74e191',
    'https://www.notion.so/%D7%9E%D7%A9%D7%99%D7%9E%D7%95%D7%AA-0a8fbd6249a948a7a23a68ee2e74e191',
    'https://www.notion.so/myworkspace/0a8fbd6249a948a7a23a68ee2e74e191?v=1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f',
    '0a8fbd62-49a9-48a7-a23a-68ee2e74e191',
  ];
  for (const link of links) {
    assert.equal(normalizeDatabaseId(link), expected, link);
    assert.equal(normalizeId(link), expected, `scripts: ${link}`);
  }
  // Notion's own API docs sample.
  assert.equal(
    normalizeDatabaseId('https://www.notion.so/Example-Page-1429989fe8ac4effbc8f57f56486db54'),
    '1429989f-e8ac-4eff-bc8f-57f56486db54',
  );
  assert.equal(normalizeId(''), null);
});

/* R1-49: invisible marks in a pasted token or key. */

const INVISIBLE = {
  'right-to-left mark': '‏',
  'left-to-right mark': '‎',
  'zero-width space': '​',
  'word joiner': '⁠',
  'byte-order mark': '﻿',
  'Arabic letter mark': '؜',
};
const TOKEN = 'ntn_4f8b2c1d9e7a6b5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';
const KEY = 'AIzaSyD-4f8b2c1d9e7a6b5c3d2e1f0a9b8c7d6';

test('R1-49: invisible marks are removed from a pasted token or key', () => {
  for (const [name, mark] of Object.entries(INVISIBLE)) {
    assert.equal(validateToken(`${mark}${TOKEN}${mark}`), TOKEN, `token, ${name} around it`);
    assert.equal(validateToken(`${TOKEN.slice(0, 10)}${mark}${TOKEN.slice(10)}`), TOKEN, `token, ${name} inside`);
    assert.equal(validateApiKey(` ${KEY}${mark} `), KEY, `key, ${name}`);
  }
});

test('R1-49: what is left can be sent in a header, which the raw paste could not', () => {
  const pasted = `${TOKEN}‏`;
  // Node's fetch refuses the same values a browser does.
  assert.throws(() => new Headers({ authorization: `Bearer ${pasted}` }));
  assert.doesNotThrow(() => new Headers({ authorization: `Bearer ${validateToken(pasted)}` }));
});

test('R1-49: a paste with visible characters a token never has is refused', () => {
  for (const bad of [
    `“${TOKEN}”`, // smart quotes
    `${TOKEN} x`, // a no-break space inside
    `${TOKEN}א`, // a Hebrew letter
    '‏‎', // nothing but marks
  ]) {
    assert.equal(cleanSecret(bad), null, JSON.stringify(bad));
    assert.equal(validateToken(bad), null, JSON.stringify(bad));
  }
  assert.equal(validateApiKey('AIza‏short'), null, 'still too short once cleaned');
});

test('R1-49: a token or key saved with an invisible mark before this fix works on load', () => {
  const saved = new Map<string, string>([
    ['smartask.notion.v1', JSON.stringify({ token: `${TOKEN}‏`, databaseId: 'db' })],
    ['smartask.gemini.v1', JSON.stringify({ apiKey: `‎${KEY}`, model: 'gemini-x' })],
  ]);
  const g = globalThis as { window?: unknown };
  g.window = { localStorage: { getItem: (k: string) => saved.get(k) ?? null } };
  try {
    assert.deepEqual(loadConfig(), { token: TOKEN, databaseId: 'db' });
    assert.deepEqual(loadGeminiConfig(), { apiKey: KEY, model: 'gemini-x' });
  } finally {
    delete g.window;
  }
});
