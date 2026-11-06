/**
 * Voice input through the browser's own speech recognition (Web Speech API).
 *
 * Chosen over recording audio and sending it to Gemini because it is free,
 * needs no key, works with AI off, and shows the words as you speak. The cost
 * is uneven support: solid in Chrome and Android, present in Safari, and known
 * to misbehave in iPhone apps added to the home screen. Every failure therefore
 * ends in a message pointing at the keyboard's own dictation key, which works
 * everywhere.
 */

export const SPEECH_LANGS = {
  'he-IL': 'עברית',
  'en-US': 'English',
} as const;
export type SpeechLang = keyof typeof SPEECH_LANGS;

const LANG_KEY = 'smartask.speechLang';

/** The minimal slice of the Web Speech API this app uses; not in TS's DOM lib. */
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechResultEventLike {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

export function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Hebrew if the device lists Hebrew among its languages, English otherwise. */
export function pickSpeechLang(languages: readonly string[]): SpeechLang {
  return languages.some((l) => l.toLowerCase().startsWith('he') || l.toLowerCase() === 'iw')
    ? 'he-IL'
    : 'en-US';
}

export function loadSpeechLang(): SpeechLang {
  if (typeof window === 'undefined') return 'en-US';
  try {
    const saved = window.localStorage.getItem(LANG_KEY);
    if (saved === 'he-IL' || saved === 'en-US') return saved;
  } catch {
    // Fall through to the device default.
  }
  return pickSpeechLang(navigator.languages ?? [navigator.language ?? 'en-US']);
}

export function saveSpeechLang(lang: SpeechLang): void {
  try {
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    // A preference that does not persist is not worth an error.
  }
}

/** Everything heard so far in this session, final and interim, as one string. */
export function transcriptOf(event: SpeechResultEventLike): { text: string; isFinal: boolean } {
  const parts: string[] = [];
  let isFinal = false;
  for (let i = 0; i < event.results.length; i += 1) {
    const result = event.results[i];
    parts.push(result[0]?.transcript ?? '');
    isFinal = result.isFinal;
  }
  return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), isFinal };
}

/** Speech is added after whatever was already typed, never over it. */
export function mergeTranscript(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base.trim()) return said;
  return /\s$/.test(base) ? `${base}${said}` : `${base} ${said}`;
}

const KEYBOARD_HINT = 'Use the 🎤 on your keyboard instead — it dictates Hebrew and English.';

export const UNSUPPORTED_MESSAGE = `This browser has no built-in voice input. ${KEYBOARD_HINT}`;

/** What to tell the user for each Web Speech error code. '' means stay quiet. */
export function describeSpeechError(code: string, lang: SpeechLang): string {
  switch (code) {
    case 'aborted':
      return ''; // the user stopped it
    case 'no-speech':
      return 'Did not catch anything. Tap the mic and speak again.';
    case 'audio-capture':
      return `No microphone available. ${KEYBOARD_HINT}`;
    case 'network':
      return 'Voice input needs an internet connection.';
    case 'not-allowed':
      return `Microphone access was blocked. Allow it in your browser settings, or: ${KEYBOARD_HINT}`;
    case 'service-not-allowed':
      return `Voice input is not available here — common in iPhone apps added to the home screen. ${KEYBOARD_HINT}`;
    case 'language-not-supported':
      return `This device cannot recognise ${SPEECH_LANGS[lang]}. Switch the voice language, or: ${KEYBOARD_HINT}`;
    default:
      return `Voice input stopped unexpectedly. ${KEYBOARD_HINT}`;
  }
}
