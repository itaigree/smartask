'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { parseTask } from '../lib/parse.ts';
import { categorizeByRules } from '../lib/categorize/rules.ts';
import { daysUntilDue } from '../lib/views.ts';
import type { Task } from '../lib/types.ts';
import {
  loadSpeechLang, mergeTranscript, saveSpeechLang, SPEECH_LANGS, type SpeechLang,
} from '../lib/speech.ts';
import { CategoryChip, DueChip, PriorityChip, ProjectChip, TagChip } from './Chips.tsx';
import VoiceButton, { type VoiceControl } from './VoiceButton.tsx';

/**
 * The text of a task that is being saved, kept on the device until the save is
 * confirmed. If the app is closed mid-save — back gesture, the tab discarded —
 * the text comes back in the box next time instead of being lost.
 */
const PENDING_KEY = 'smartask.pending.v1';

/** The text to put back in the box, if the app closed while saving it. */
function loadPending(): string | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { text?: unknown };
    return typeof entry.text === 'string' && entry.text ? entry.text : null;
  } catch {
    return null;
  }
}

function savePending(text: string | null): void {
  try {
    if (text) {
      window.localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ text, at: Date.now() }),
      );
    } else {
      window.localStorage.removeItem(PENDING_KEY);
    }
  } catch {
    // Storage blocked: the save itself still works, only this safety net is lost.
  }
}

/**
 * The capture box. It parses as you type, so you can see what the app
 * understood before committing — the same pure parser the server uses.
 */
export default function QuickAdd({
  onCreate,
  busy,
  aiEnabled = false,
}: {
  onCreate: (text: string) => Promise<Task | null>;
  busy: boolean;
  /** With Gemini on, the preview category is the local guess, not the verdict. */
  aiEnabled?: boolean;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Voice: what was typed before speaking started, so speech is appended to it.
  const spokenBase = useRef('');
  const voice = useRef<VoiceControl | null>(null);
  const [listening, setListening] = useState(false);
  /** Speech has just filled the box: prompt the user to check it before adding. */
  const [heard, setHeard] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [speechLang, setSpeechLang] = useState<SpeechLang>('en-US');
  useEffect(() => setSpeechLang(loadSpeechLang()), []);

  /** A task that was still saving when the app last closed, put back in the box. */
  const [restored, setRestored] = useState<string | null>(null);
  useEffect(() => {
    const pending = loadPending();
    if (!pending) return;
    setText((current) => current || pending);
    setRestored(pending);
  }, []);

  // The text may belong to another open copy of the app (the installed app and
  // a browser tab share storage) that was still saving it. When that copy
  // finishes, it clears the entry: take the text back out of this box too, so
  // it is not added twice.
  useEffect(() => {
    if (!restored) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PENDING_KEY || event.newValue !== null) return;
      setText((current) => (current.trim() === restored.trim() ? '' : current));
      setRestored(null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [restored]);

  function switchSpeechLang() {
    const next: SpeechLang = speechLang === 'he-IL' ? 'en-US' : 'he-IL';
    setSpeechLang(next);
    saveSpeechLang(next);
  }

  const preview = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const now = new Date();
    const parsed = parseTask(trimmed, now);
    const { category } = categorizeByRules({
      title: parsed.title,
      note: parsed.note,
      project: parsed.project,
      tags: parsed.tags,
    });
    const daysAway = parsed.due
      ? daysUntilDue({ due: parsed.due, status: 'Todo' } as Task, now)
      : null;
    return { parsed, category, daysAway };
  }, [text]);

  /**
   * The one way a task gets added, typed or spoken. On success the box is
   * emptied, ready for the next one; on failure the text stays so nothing
   * spoken or typed is lost.
   */
  async function add(raw: string): Promise<boolean> {
    const trimmed = raw.trim();
    if (!trimmed || busy) return false;
    savePending(trimmed);
    setRestored(null);
    const created = await onCreate(trimmed);
    if (created) {
      savePending(null);
      setText((current) => (current.trim() === trimmed ? '' : current));
      setHeard(false);
      setVoiceError(null);
    }
    return Boolean(created);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Not while listening: the box still holds interim words, and Android's
    // final result can arrive after a tap — saving a cut-off task and then
    // refilling the box. Add waits until speech has ended.
    if (listening) return;
    await add(text);
    inputRef.current?.focus();
  }

  /**
   * Speech ended. Put the complete transcript in the box and stop there: the
   * user checks it, fixes anything misheard, and taps Add themselves.
   */
  function showSpoken(spoken: string) {
    setText(mergeTranscript(spokenBase.current, spoken));
    setHeard(true);
  }

  return (
    <form className="quickadd" onSubmit={submit}>
      <div className="quickadd-field">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHeard(false);
            setRestored(null);
            if (!e.target.value.trim()) savePending(null); // cleared on purpose
          }}
          // While the mic listens, speech owns the box: typing then would be
          // overwritten by the next speech update. While saving, the box holds
          // the task being saved — so a failed save leaves it right there, and
          // nothing typed meanwhile can be wiped or mixed up with it.
          readOnly={listening || busy}
          placeholder={
            // One short example in the language the user speaks: two did not
            // fit a phone-width box.
            aiEnabled && speechLang === 'he-IL'
              ? 'לשלם חשבון חשמל מחר'
              : 'Pay rent friday !! #home @bills'
          }
          aria-label="New task"
          dir="auto"
          autoComplete="off"
          enterKeyHint="done"
        />
        <VoiceButton
          lang={speechLang}
          disabled={busy}
          control={voice}
          onStart={() => {
            spokenBase.current = text;
            setHeard(false);
            setVoiceError(null);
          }}
          onText={(spoken) => setText(mergeTranscript(spokenBase.current, spoken))}
          onFinal={showSpoken}
          onError={setVoiceError}
          onListeningChange={setListening}
        />
        <button type="submit" disabled={!text.trim() || busy || listening}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>

      {listening && (
        <p className="listening-hint" aria-live="polite">
          Listening… stop talking when you are done, or tap the mic.
        </p>
      )}

      {restored && text.trim() && (
        <p className="heard-hint" aria-live="polite">
          This task was still saving when the app closed. Check it is not already in your list,
          then tap Add.
        </p>
      )}

      {heard && !listening && text.trim() && (
        <p className="heard-hint" aria-live="polite">
          Check the text — fix anything misheard — then tap Add.
        </p>
      )}

      {voiceError && (
        <p className="voice-error" role="alert">
          {voiceError}
        </p>
      )}

      {preview ? (
        <div className="preview" aria-live="polite">
          <span className="preview-label">Will save as</span>
          {aiEnabled ? (
            // The live guess comes from English-only keyword rules; showing it
            // here would put "Inbox" on every Hebrew task even though Gemini,
            // not the rules, makes the call when the task is added.
            <span className="chip ai" title="Gemini picks the category when you add it">
              ✦ Gemini will sort it{preview.parsed.due ? '' : ' and find any date'}
            </span>
          ) : (
            <CategoryChip category={preview.category} />
          )}
          <PriorityChip priority={preview.parsed.priority} />
          {preview.parsed.due && (
            <DueChip due={preview.parsed.due} daysAway={preview.daysAway} />
          )}
          {preview.parsed.project && <ProjectChip project={preview.parsed.project} />}
          {preview.parsed.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      ) : (
        <div className="hint-row">
          <p className="hint">
            {aiEnabled ? (
              <>
                Type or speak naturally, in Hebrew or English — Gemini finds the category and
                any date. <code>!!</code> urgent · <code>#project</code> · <code>@tag</code>
              </>
            ) : (
              <>
                <code>friday</code> / <code>in 3 days</code> sets a date · <code>!</code> or{' '}
                <code>!!</code> sets priority · <code>#project</code> · <code>@tag</code>
              </>
            )}
          </p>
          <button
            type="button"
            className="lang-toggle"
            onClick={switchSpeechLang}
            title="Language for voice input"
            aria-label={`Voice language: ${SPEECH_LANGS[speechLang]}. Tap to switch.`}
          >
            🎤 {SPEECH_LANGS[speechLang]}
          </button>
        </div>
      )}
    </form>
  );
}
