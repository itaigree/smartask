import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeNotionError, mayHaveSaved, TaskGoneError, UnconfirmedSaveError,
} from '../src/lib/notion-errors.ts';

/** The shape the Notion SDK throws for an API error. */
const apiError = (code: string, message = 'Notion said no.') =>
  Object.assign(new Error(message), { name: 'APIResponseError', code });

/** What fetch() rejects with when no answer came back, per browser. */
const offline = [
  new TypeError('Failed to fetch'),
  new TypeError('NetworkError when attempting to fetch resource.'),
  new TypeError('Load failed'),
];

const CONNECTION = /Could not reach Notion/;
const SHARING = /cannot find that database/;

test('a dropped connection is described as one', () => {
  for (const e of offline) assert.match(describeNotionError(e), CONNECTION, e.message);
});

test('R3-3: a read-only integration is pointed at its Capabilities, not at sharing', () => {
  const text = describeNotionError(apiError('restricted_resource', 'Insufficient permissions for this endpoint.'));
  assert.doesNotMatch(text, SHARING);
  assert.match(text, /Capabilities/);
  assert.match(text, /notion\.so\/my-integrations/);
});

test('R1-36: a deleted task is not reported as a missing database', () => {
  const text = describeNotionError(new TaskGoneError());
  assert.doesNotMatch(text, SHARING);
  assert.match(text, /task no longer exists in Notion/);
  // Notion's own "not found" for the database still says how to share it.
  assert.match(describeNotionError(apiError('object_not_found')), SHARING);
});

test('R1-35: an error that is not about the connection keeps its own words', () => {
  const noSource = new Error('That Notion database has no data source to read.');
  assert.equal(describeNotionError(noSource), noSource.message);
  assert.equal(
    describeNotionError(new Error('Notion accepted the task but returned an unreadable page.')),
    'Notion accepted the task but returned an unreadable page.',
  );
  assert.doesNotMatch(describeNotionError(new TypeError("Cannot read properties of undefined (reading 'id')")), CONNECTION,
    'a bug is not a network problem');
});

test('R1-49: a token the browser refuses to send is not called a network problem', () => {
  const chrome = new TypeError(
    "Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': " +
      'String contains non ISO-8859-1 code point.',
  );
  const firefox = new TypeError(
    'Window.fetch: Cannot convert value in record<ByteString, ByteString> branch of (sequence<sequence<ByteString>> ' +
      'or record<ByteString, ByteString>) to ByteString because the character at index 20 has value 8207 which is greater than 255.',
  );
  for (const e of [chrome, firefox]) {
    const text = describeNotionError(e);
    assert.doesNotMatch(text, CONNECTION);
    assert.match(text, /token contains a character that cannot be sent/);
    assert.equal(mayHaveSaved(e, false), false, 'nothing was sent, so nothing was saved');
  }
});

test('the SDK timing out is described, not shown raw', () => {
  const timeout = Object.assign(new Error('Request to Notion API has timed out'), {
    name: 'RequestTimeoutError', code: 'notionhq_client_request_timeout',
  });
  assert.match(describeNotionError(timeout), /did not answer in time/);
});

test('R2-6: only a lost answer, not a refusal, may have saved the task', () => {
  for (const e of offline) {
    assert.equal(mayHaveSaved(e, false), true, `${e.message}: the request may have reached Notion`);
    assert.equal(mayHaveSaved(e, true), false, `${e.message}: offline before sending, nothing left`);
  }
  assert.equal(mayHaveSaved(Object.assign(new Error('timed out'), { code: 'notionhq_client_request_timeout' }), false), true);
  assert.equal(mayHaveSaved(apiError('gateway_timeout'), false), true);
  for (const code of ['unauthorized', 'restricted_resource', 'object_not_found', 'validation_error', 'rate_limited']) {
    assert.equal(mayHaveSaved(apiError(code), false), false, `${code}: Notion answered, and did not save`);
  }
});

test('R2-6: the message for a lost answer says it may be saved, and does not invite a blind Add', () => {
  const text = describeNotionError(new UnconfirmedSaveError());
  assert.match(text, /may be in Notion already/);
  assert.match(text, /check before adding it again/);
  assert.doesNotMatch(text, /tap Add to try again/i);
});
