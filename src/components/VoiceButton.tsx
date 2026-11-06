'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { getRecognitionCtor, UNSUPPORTED_MESSAGE, type SpeechLang } from '../lib/speech.ts';
import { startVoiceSession, type VoiceSession } from '../lib/voice-session.ts';

export interface VoiceControl {
  /** Drop any session in progress without adding anything. */
  cancel(): void;
}

/**
 * Tap, speak, stop — the task is added when you stop talking. Tapping again
 * while listening means "done" and adds immediately. The timing rules live in
 * voice-session.ts; this component is only the button.
 */
export default function VoiceButton({
  lang,
  disabled,
  control,
  onStart,
  onText,
  onFinal,
  onError,
  onListeningChange,
}: {
  lang: SpeechLang;
  disabled?: boolean;
  /** Lets the capture box cancel a session, e.g. when Add is tapped mid-speech. */
  control?: RefObject<VoiceControl | null>;
  onStart: () => void;
  onText: (spoken: string) => void;
  onFinal: (spoken: string) => void;
  onError: (message: string) => void;
  onListeningChange?: (listening: boolean) => void;
}) {
  const [listening, setListening] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);

  // A session outlives the render that started it, so it reads the latest
  // callbacks through a ref rather than holding on to stale ones.
  const handlers = useRef({ onText, onFinal, onError, onListeningChange });
  handlers.current = { onText, onFinal, onError, onListeningChange };

  useEffect(() => {
    if (!control) return;
    control.current = { cancel: () => sessionRef.current?.cancel() };
    return () => {
      control.current = null;
    };
  }, [control]);

  // Never leave the microphone open after the component goes away.
  useEffect(() => () => sessionRef.current?.cancel(), []);

  function setOn(on: boolean) {
    setListening(on);
    handlers.current.onListeningChange?.(on);
  }

  function toggle() {
    if (sessionRef.current) {
      sessionRef.current.finish();
      return;
    }

    const Recognition = getRecognitionCtor();
    if (!Recognition) {
      handlers.current.onError(UNSUPPORTED_MESSAGE);
      return;
    }

    onStart();
    setOn(true);
    sessionRef.current = startVoiceSession(new Recognition(), lang, {
      onText: (t) => handlers.current.onText(t),
      onFinal: (t) => handlers.current.onFinal(t),
      onError: (m) => handlers.current.onError(m),
      onEnd: () => {
        sessionRef.current = null;
        setOn(false);
      },
    });
  }

  return (
    <button
      type="button"
      className={`mic-button${listening ? ' listening' : ''}`}
      onClick={toggle}
      disabled={disabled && !listening}
      aria-pressed={listening}
      aria-label={listening ? 'Done speaking' : 'Speak a task'}
      title={listening ? 'Tap when done' : 'Speak a task'}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
        />
      </svg>
    </button>
  );
}
