import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openVoiceSession, startVoiceSession, type VoiceCallbacks, type VoiceSession,
} from '../src/lib/voice-session.ts';
import type { SpeechRecognitionLike } from '../src/lib/speech.ts';

/** A recognizer we drive by hand, standing in for the browser's. */
function fakeRecognizer() {
  const r = {
    lang: '', interimResults: false, continuous: true, maxAlternatives: 0,
    onresult: null, onerror: null, onend: null,
    started: 0, stopped: 0, aborted: 0,
    start() { r.started += 1; },
    stop() { r.stopped += 1; },
    abort() { r.aborted += 1; },
    say(text: string, isFinal = false) {
      r.onresult?.({ results: [{ isFinal, 0: { transcript: text } }] });
    },
    fail(error: string) { r.onerror?.({ error }); },
    end() { r.onend?.(); },
  } as SpeechRecognitionLike & {
    started: number; stopped: number; aborted: number;
    say(t: string, f?: boolean): void; fail(e: string): void; end(): void;
  };
  return r;
}

/** Timers we advance by hand. */
function fakeClock() {
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { id += 1; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      now += ms;
      for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); }
    },
  };
}

function recorder() {
  const log = { text: [] as string[], final: [] as string[], errors: [] as string[], ends: 0 };
  const callbacks: VoiceCallbacks = {
    onText: (t) => log.text.push(t),
    onFinal: (t) => log.final.push(t),
    onError: (e) => log.errors.push(e),
    onEnd: () => { log.ends += 1; },
  };
  return { log, callbacks };
}

test('stopping talking adds the complete transcript, once', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());

  r.say('לשלם חשבון');
  r.say('לשלם חשבון חשמל', true); // the recognizer heard the silence itself
  r.end();

  assert.deepEqual(log.text, ['לשלם חשבון', 'לשלם חשבון חשמל']);
  assert.deepEqual(log.final, ['לשלם חשבון חשמל'], 'the full text, not the interim');
  assert.equal(log.ends, 1);
  assert.equal(r.lang, 'he-IL');
  assert.equal(r.continuous, false);
});

test('a late result after the session closed is ignored — the cleared box stays clear', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());

  r.say('לשלם חשבון חשמל', true);
  r.say('לשלם חשבון חשמל'); // Android sending one more after the final
  r.say('לשלם חשבון חשמל', true);
  r.end();

  assert.equal(log.text.length, 1, 'nothing after close reaches the text box');
  assert.equal(log.final.length, 1, 'never added twice');
  assert.equal(log.ends, 1);
});

test('if the recognizer keeps listening after you stop, the silence backstop ends it', () => {
  const r = fakeRecognizer();
  const clock = fakeClock();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, { ...clock, silenceMs: 2000 });

  r.say('לכתוב');
  clock.advance(1500);
  r.say('לכתוב ליואל'); // still talking: the timer restarts
  clock.advance(1500);
  assert.equal(r.stopped, 0, 'not cut off mid-sentence');
  clock.advance(600); // 2.1s of quiet since the last word
  assert.equal(r.stopped, 1, 'asked to finish after the pause');

  r.end(); // ended without a final result, as stop() often does
  assert.deepEqual(log.final, ['לכתוב ליואל'], 'the last thing heard is added');
});

test('the backstop does not start before any speech, leaving the browser to time out', () => {
  const r = fakeRecognizer();
  const clock = fakeClock();
  const { callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, clock);
  clock.advance(10_000);
  assert.equal(r.stopped, 0);
});

test('tapping the mic again means "done": finish and add', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  const session = startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.say('בקשה אתית');
  session.finish();
  assert.equal(r.stopped, 1);
  r.say('בקשה אתית', true);
  assert.deepEqual(log.final, ['בקשה אתית']);
});

test('cancel adds nothing and lets nothing late through', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  const session = startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.say('לשלם');
  session.cancel();
  r.say('לשלם חשבון חשמל', true);
  r.end();
  assert.deepEqual(log.final, []);
  assert.deepEqual(log.text, ['לשלם']);
  assert.equal(log.ends, 1);
  assert.equal(r.aborted >= 1, true, 'the microphone is released');
});

test('silence with no words adds nothing', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.end();
  assert.deepEqual(log.final, []);
  assert.equal(log.ends, 1);
});

test('an error part-way never auto-adds a half-heard task', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.say('לשלם חשב');
  r.fail('network');
  r.end();
  assert.deepEqual(log.final, [], 'the partial text stays in the box for the user');
  assert.match(log.errors[0], /internet/);
  assert.equal(log.ends, 1);
});

test('a recognizer that refuses to start reports it and closes', () => {
  const r = fakeRecognizer();
  r.start = () => { throw new Error('busy'); };
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  assert.equal(log.errors.length, 1);
  assert.equal(log.ends, 1);
});

/** The mic button's slot, as VoiceButton keeps it: one tap starts, the next finishes. */
function micButton(make: () => SpeechRecognitionLike) {
  const slot: { current: VoiceSession | null } = { current: null };
  const { log, callbacks } = recorder();
  return {
    slot,
    log,
    tap() {
      if (slot.current) {
        slot.current.finish();
        return;
      }
      let session: VoiceSession | null = null;
      session = openVoiceSession(make, 'he-IL', {
        ...callbacks,
        onEnd: () => {
          callbacks.onEnd();
          if (slot.current === session) slot.current = null;
        },
      }, fakeClock());
      slot.current = session;
    },
  };
}

test('R1-46: after a start that throws, the next tap tries again', () => {
  const made: ReturnType<typeof fakeRecognizer>[] = [];
  const mic = micButton(() => {
    const r = fakeRecognizer();
    if (made.length === 0) r.start = () => { throw new Error('busy'); };
    made.push(r);
    return r;
  });

  mic.tap();
  assert.equal(mic.slot.current, null, 'no closed session is kept');
  assert.equal(mic.log.errors.length, 1);
  assert.equal(mic.log.ends, 1, 'listening is switched off again');

  mic.tap();
  assert.equal(made.length, 2, 'a fresh recognizer');
  assert.equal(made[1].started, 1, 'and it is listening');
  assert.notEqual(mic.slot.current, null);

  made[1].say('לשלם', true);
  assert.deepEqual(mic.log.final, ['לשלם']);
  assert.equal(mic.slot.current, null, 'the ended session leaves the slot');
});

test('R1-46: a recognizer that cannot be built reports it and ends, so the box is not stuck listening', () => {
  let attempts = 0;
  const mic = micButton(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('not allowed here');
    return fakeRecognizer();
  });

  mic.tap();
  assert.equal(mic.slot.current, null);
  assert.equal(mic.log.errors.length, 1);
  assert.match(mic.log.errors[0], /keyboard/);
  assert.equal(mic.log.ends, 1, 'onEnd turns "listening" off');

  mic.tap();
  assert.equal(attempts, 2);
  assert.notEqual(mic.slot.current, null, 'the mic works on the next tap');
});

test('R1-47: cut off from outside (app hidden) with words heard, it says so', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.say('לשלם חשבון');
  r.fail('aborted'); // Android stops listening when you switch apps
  r.end();
  assert.deepEqual(log.final, [], 'never added by itself');
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /cut off/);
  assert.equal(log.ends, 1);
});

test('R1-47: an abort before any words stays quiet — nothing was lost', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.fail('aborted');
  assert.deepEqual(log.errors, []);
  assert.equal(log.ends, 1);
});

test('R1-47: the app\'s own cancel never shows the cut-off message', () => {
  const r = fakeRecognizer();
  const { log, callbacks } = recorder();
  const session = startVoiceSession(r, 'he-IL', callbacks, fakeClock());
  r.say('לשלם חשבון');
  session.cancel();
  r.fail('aborted'); // what abort() makes the browser send
  assert.deepEqual(log.errors, []);
});
