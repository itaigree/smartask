import {
  describeSpeechError, transcriptOf,
  type SpeechLang, type SpeechRecognitionLike,
} from './speech.ts';

/**
 * One tap-to-talk session, framework-free so its timing can be tested.
 *
 * `onFinal` fires exactly once, with the complete transcript, when speech has
 * ended — whether the recognizer noticed the silence itself, the user tapped
 * the mic again, or the silence backstop below fired. The capture box then
 * shows that text for the user to check before adding.
 *
 * After it closes, nothing from that recognizer is allowed through. That is
 * the fix for a real race: Android delivers its final result a beat after the
 * user stops talking, and that late result used to write the text back into a
 * box that had already been cleared — and the task saved was the unfinished
 * interim text.
 */

export interface VoiceCallbacks {
  /** Running transcript while speaking: interim words, updated as they firm up. */
  onText(spoken: string): void;
  /** Speech is over. Called once, and only if something was actually said. */
  onFinal(spoken: string): void;
  /** Something went wrong; already worded for the user. */
  onError(message: string): void;
  /** The microphone is closed. Called exactly once per session. */
  onEnd(): void;
}

export interface VoiceSessionOptions {
  /**
   * Quiet time after the last recognised word before we end it ourselves.
   * The recognizer normally ends on its own sooner; this is the backstop for
   * the times Android keeps listening after the user has stopped.
   */
  silenceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface VoiceSession {
  /** "I'm done": end now and add what was heard. */
  finish(): void;
  /** Throw this session away — nothing is added, nothing late gets through. */
  cancel(): void;
}

export const DEFAULT_SILENCE_MS = 2000;

export function startVoiceSession(
  recognition: SpeechRecognitionLike,
  lang: SpeechLang,
  callbacks: VoiceCallbacks,
  options: VoiceSessionOptions = {},
): VoiceSession {
  const {
    silenceMs = DEFAULT_SILENCE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  } = options;

  let closed = false;
  let lastText = '';
  let silence: unknown = null;

  const stopTimer = () => {
    if (silence !== null) clearTimer(silence);
    silence = null;
  };

  /** The single exit. Everything that ends a session goes through here. */
  function close(text: string | null) {
    if (closed) return;
    closed = true;
    stopTimer();
    try {
      recognition.abort(); // no more events from this recognizer
    } catch {
      // Already stopped.
    }
    if (text && text.trim()) callbacks.onFinal(text.trim());
    callbacks.onEnd();
  }

  /** Ask the recognizer to finish; it normally replies with a final result. */
  function requestFinish() {
    if (closed) return;
    stopTimer();
    try {
      recognition.stop();
    } catch {
      close(lastText);
    }
  }

  recognition.lang = lang;
  recognition.interimResults = true; // show words as they come
  recognition.continuous = false; // one task per tap
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    if (closed) return;
    const { text, isFinal } = transcriptOf(event);
    lastText = text;
    callbacks.onText(text);
    if (isFinal) {
      close(text);
      return;
    }
    // Words are still arriving: push the backstop out again.
    stopTimer();
    silence = setTimer(requestFinish, silenceMs);
  };

  recognition.onerror = (event) => {
    if (closed) return;
    const message = describeSpeechError(event.error, lang, Boolean(lastText.trim()));
    if (message) callbacks.onError(message);
    // A failure part-way never auto-adds a half-heard task. Whatever was heard
    // stays in the box for the user to fix and add by hand.
    close(null);
  };

  // The recognizer ended without a final result — common after stop().
  // Use the last thing it heard.
  recognition.onend = () => close(lastText);

  try {
    recognition.start();
  } catch {
    callbacks.onError(describeSpeechError('start-failed', lang));
    close(null);
  }

  return {
    finish: requestFinish,
    cancel: () => close(null),
  };
}

/**
 * Build a recognizer and start a session on it, for a button that keeps hold
 * of the session while it runs.
 *
 * Returns null when nothing is listening — building the recognizer or
 * starting it threw. onError and onEnd have then already been called, once
 * each. A caller must never keep a session that has closed: the mic button
 * did, and every later tap "finished" that dead session, so the mic did
 * nothing until the page was reloaded.
 */
export function openVoiceSession(
  createRecognition: () => SpeechRecognitionLike,
  lang: SpeechLang,
  callbacks: VoiceCallbacks,
  options: VoiceSessionOptions = {},
): VoiceSession | null {
  let recognition: SpeechRecognitionLike;
  try {
    recognition = createRecognition();
  } catch {
    callbacks.onError(describeSpeechError('start-failed', lang));
    callbacks.onEnd();
    return null;
  }

  let open = true;
  const session = startVoiceSession(
    recognition,
    lang,
    {
      ...callbacks,
      onEnd: () => {
        open = false;
        callbacks.onEnd();
      },
    },
    options,
  );
  return open ? session : null;
}
