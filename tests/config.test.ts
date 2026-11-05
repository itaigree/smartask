import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDatabaseId, validateToken, maskToken, loadConfig, saveConfig,
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
