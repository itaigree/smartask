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
import VoiceButton from './VoiceButton.tsx';

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
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [speechLang, setSpeechLang] = useState<SpeechLang>('en-US');
  useEffect(() => setSpeechLang(loadSpeechLang()), []);

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const created = await onCreate(trimmed);
    if (created) {
      setText('');
      setVoiceError(null);
    }
    inputRef.current?.focus();
  }

  return (
    <form className="quickadd" onSubmit={submit}>
      <div className="quickadd-field">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
          onStart={() => {
            spokenBase.current = text;
            setVoiceError(null);
          }}
          onText={(spoken) => setText(mergeTranscript(spokenBase.current, spoken))}
          onError={setVoiceError}
        />
        <button type="submit" disabled={!text.trim() || busy}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>

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
