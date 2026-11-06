'use client';

import { useEffect, useRef, useState } from 'react';
import {
  describeSpeechError, getRecognitionCtor, transcriptOf, UNSUPPORTED_MESSAGE,
  type SpeechLang, type SpeechRecognitionLike,
} from '../lib/speech.ts';

/**
 * Tap to talk, tap again (or pause) to stop. Words stream into the capture box
 * as they are recognised; nothing is submitted until the user taps Add, because
 * speech gets things wrong and a wrong task saved is worse than one more tap.
 */
export default function VoiceButton({
  lang,
  disabled,
  onStart,
  onText,
  onError,
}: {
  lang: SpeechLang;
  disabled?: boolean;
  onStart: () => void;
  onText: (spoken: string) => void;
  onError: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Never leave the microphone open after the component goes away.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  function toggle() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const Recognition = getRecognitionCtor();
    if (!Recognition) {
      onError(UNSUPPORTED_MESSAGE);
      return;
    }

    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true; // show words as they come
    recognition.continuous = false; // one utterance; a pause ends it
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => onText(transcriptOf(event).text);
    recognition.onerror = (event) => {
      const message = describeSpeechError(event.error, lang);
      if (message) onError(message);
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    onStart();
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      onError(describeSpeechError('start-failed', lang));
    }
  }

  return (
    <button
      type="button"
      className={`mic-button${listening ? ' listening' : ''}`}
      onClick={toggle}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? 'Stop voice input' : 'Speak a task'}
      title={listening ? 'Tap to stop' : 'Speak a task'}
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
