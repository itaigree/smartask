'use client';

import { useMemo, useRef, useState } from 'react';
import { parseTask } from '../lib/parse.ts';
import { categorizeByRules } from '../lib/categorize/rules.ts';
import { daysUntilDue } from '../lib/views.ts';
import type { Task } from '../lib/types.ts';
import { CategoryChip, DueChip, PriorityChip, ProjectChip, TagChip } from './Chips.tsx';

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
    if (created) setText('');
    inputRef.current?.focus();
  }

  return (
    <form className="quickadd" onSubmit={submit}>
      <div className="quickadd-field">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Pay rent friday !! #home @bills"
          aria-label="New task"
          autoComplete="off"
          enterKeyHint="done"
        />
        <button type="submit" disabled={!text.trim() || busy}>
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>

      {preview ? (
        <div className="preview" aria-live="polite">
          <span className="preview-label">{aiEnabled ? 'Saving as' : 'Will save as'}</span>
          <CategoryChip category={preview.category} />
          {aiEnabled && (
            <span className="chip ai" title="Gemini confirms the category when you add it">
              ✦ Gemini decides
            </span>
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
        <p className="hint">
          <code>friday</code> / <code>in 3 days</code> sets a date · <code>!</code> or{' '}
          <code>!!</code> sets priority · <code>#project</code> · <code>@tag</code>
        </p>
      )}
    </form>
  );
}
