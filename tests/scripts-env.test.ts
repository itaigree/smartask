import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFailure, isNetworkError, parseEnvText, tokenProblem,
} from '../scripts/lib/env.mjs';

test('R2-15: .env lines are read the way people write them', () => {
  const vars = parseEnvText([
    '# a comment line',
    'NOTION_TOKEN=ntn_abc123 # my integration',
    'export NOTION_DATABASE_ID=0a8fbd6249a948a7a23a68ee2e74e191',
    'QUOTED="has # inside"',
    "SINGLE='single'  # trailing comment",
    '  SPACED = value with spaces  ',
    'EMPTY=',
    'GLUED=abc#def',
    'not a variable line',
  ].join('\n'));

  assert.equal(vars.NOTION_TOKEN, 'ntn_abc123', 'an inline comment is not part of the value');
  assert.equal(vars.NOTION_DATABASE_ID, '0a8fbd6249a948a7a23a68ee2e74e191', '`export` is allowed');
  assert.equal(vars.QUOTED, 'has # inside', 'inside quotes, # is kept');
  assert.equal(vars.SINGLE, 'single');
  assert.equal(vars.SPACED, 'value with spaces');
  assert.equal(vars.EMPTY, '');
  assert.equal(vars.GLUED, 'abc#def', 'only a # after a space starts a comment');
  assert.equal(Object.keys(vars).length, 7);
});

test('R2-15: a mismatched quote is kept, and does not swallow the next line', () => {
  const vars = parseEnvText('NOTION_TOKEN="ntn_abc\'\r\nNOTION_DATABASE_ID=abc\r\n');
  assert.equal(vars.NOTION_TOKEN, '"ntn_abc\'');
  assert.equal(vars.NOTION_DATABASE_ID, 'abc', 'Windows line endings too');
  assert.ok(tokenProblem(vars.NOTION_TOKEN), 'and the token check then points at the quote');
});

test('R2-13: a token with an invisible mark or curly quotes is caught before connecting', () => {
  assert.equal(tokenProblem('ntn_abc123XYZ'), null);
  assert.equal(tokenProblem('secret_abc123'), null);

  const rlm = tokenProblem('ntn_abc‏');
  assert.ok(rlm);
  assert.match(rlm.summary, /invisible character \(U\+200F\) at character 8/);

  assert.match(tokenProblem('“ntn_abc”')!.summary, /quote mark \(“\) at character 1/);
  assert.match(tokenProblem('ntn_abc 123')!.summary, /a space at character 8/);
  assert.match(tokenProblem('ntn_abé')!.summary, /"é" \(U\+00E9\)/);
});

test('R2-13: only a real network signal is called a network problem', () => {
  // What Node's fetch throws for a header it will not send: no code, no cause.
  const byteString = new TypeError(
    'Cannot convert argument to a ByteString because the character at index 14 has a value of 8207 which is greater than 255.',
  );
  assert.equal(isNetworkError(byteString), false);
  assert.doesNotMatch(describeFailure(byteString).summary, /reach/);
  assert.match(describeFailure(byteString).advice.join(' '), /ByteString/, 'Node\'s own words are shown');

  const offline = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.notion.com'), { code: 'ENOTFOUND' }),
  });
  assert.equal(isNetworkError(offline), true);
  assert.equal(describeFailure(offline).summary, 'Could not reach api.notion.com.');

  const timeout = Object.assign(new Error('Request to Notion API has timed out'), {
    code: 'notionhq_client_request_timeout',
  });
  assert.equal(isNetworkError(timeout), true);

  const rejected = Object.assign(new Error('API token is invalid.'), { code: 'unauthorized' });
  assert.equal(isNetworkError(rejected), false);
  assert.equal(describeFailure(rejected).summary, 'Notion rejected the token.');
});

test('R2-14: a 403 restricted_resource points to Capabilities, not to Connections', () => {
  const restricted = Object.assign(
    new Error('Insufficient permissions for this endpoint.'),
    { code: 'restricted_resource', status: 403 },
  );
  const { summary, advice } = describeFailure(restricted);
  assert.doesNotMatch(summary, /cannot find/);
  const text = advice.join(' ');
  assert.match(text, /Insufficient permissions for this endpoint/, 'Notion\'s own message is shown');
  assert.match(text, /Capabilities/);
  assert.doesNotMatch(text, /not found/);

  const missing = Object.assign(new Error('Could not find database'), { code: 'object_not_found' });
  assert.match(describeFailure(missing).summary, /cannot find/);
  assert.match(describeFailure(missing).advice.join(' '), /Connections/);
});
