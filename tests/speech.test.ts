import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickSpeechLang, mergeTranscript, transcriptOf, describeSpeechError, getRecognitionCtor,
} from '../src/lib/speech.ts';

const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });

test('Hebrew is the default voice language when the device lists Hebrew', () => {
  assert.equal(pickSpeechLang(['he-IL', 'en-US']), 'he-IL');
  assert.equal(pickSpeechLang(['en-GB', 'he']), 'he-IL', 'anywhere in the list');
  assert.equal(pickSpeechLang(['iw']), 'he-IL', 'the legacy code for Hebrew');
  assert.equal(pickSpeechLang(['en-US']), 'en-US');
  assert.equal(pickSpeechLang([]), 'en-US');
});

test('speech is appended after typed text, never over it', () => {
  assert.equal(mergeTranscript('', 'לשלם חשבון חשמל'), 'לשלם חשבון חשמל');
  assert.equal(mergeTranscript('#home', 'לשלם חשבון'), '#home לשלם חשבון');
  assert.equal(mergeTranscript('#home ', 'לשלם'), '#home לשלם', 'no double space');
  assert.equal(mergeTranscript('typed', '   '), 'typed', 'silence changes nothing');
});

test('interim and final results join into one running transcript', () => {
  const interim = transcriptOf({ results: [result('לשלם חשבון', false)] });
  assert.deepEqual(interim, { text: 'לשלם חשבון', isFinal: false });

  const final = transcriptOf({ results: [result('לשלם חשבון ', true), result(' חשמל מחר', true)] });
  assert.deepEqual(final, { text: 'לשלם חשבון חשמל מחר', isFinal: true });
});

test('every failure explains itself, and most point at the keyboard mic', () => {
  assert.equal(describeSpeechError('aborted', 'he-IL'), '', 'stopping on purpose is not an error');
  assert.match(describeSpeechError('service-not-allowed', 'he-IL'), /home screen/);
  assert.match(describeSpeechError('service-not-allowed', 'he-IL'), /keyboard/);
  assert.match(describeSpeechError('not-allowed', 'he-IL'), /blocked/);
  assert.match(describeSpeechError('language-not-supported', 'he-IL'), /עברית/);
  assert.match(describeSpeechError('something-new', 'en-US'), /keyboard/, 'unknown codes still help');
});

test('outside a browser there is no recognizer, rather than a crash', () => {
  assert.equal(getRecognitionCtor(), null);
});
