'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { isCustomCategory } from '../lib/categories.ts';
import { MAX_CATEGORY_LENGTH, normalizeCategoryName, type Category, type Task } from '../lib/types.ts';
import { CategoryChip } from './Chips.tsx';
import { useCloseOnBack } from './useCloseOnBack.ts';

/**
 * A sheet that slides up from the bottom — the natural reach on a phone — to
 * move one task to another category, or to a brand-new one.
 *
 * It is a real modal `<dialog>`: while it is open, Tab and screen readers stay
 * inside it, and the board behind cannot be reached.
 */
export default function CategoryPicker({
  task,
  categories,
  usage,
  onPick,
  onRemove,
  onClose,
}: {
  task: Task;
  /** Every category, in display order. */
  categories: Category[];
  /** How many tasks use each category, to know which custom ones may be removed. */
  usage: Map<string, number>;
  onPick: (category: Category) => void;
  /** Forget an unused custom category. */
  onRemove: (category: Category) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);

  // Android's back gesture closes the sheet, not the app.
  useCloseOnBack(true, onClose);

  // Runs once, when the sheet opens — not again on later renders. The board
  // re-renders all the time (the minute tick, a finished save, each step of a
  // sort), and focusing the sheet then would pull focus out of the "New
  // category" field and close the phone's keyboard.
  const taskId = task.id;
  useLayoutEffect(() => {
    const sheet = sheetRef.current!;
    const opener = document.activeElement;
    sheet.showModal();
    sheet.focus();
    return () => {
      if (sheet.open) sheet.close();
      // Focus goes back to the chip that opened the sheet. If moving the task
      // re-drew its card in another group, that chip is gone: use the new one.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const chip =
          opener instanceof HTMLElement && opener.isConnected
            ? opener
            : document.querySelector<HTMLElement>(
                `[data-task-id="${CSS.escape(taskId)}"] .chip.editable`,
              );
        chip?.focus();
      });
    };
  }, []);

  /** A tap on the dimmed area: it belongs to the dialog, but lies outside its box. */
  function onBackdrop(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) onClose();
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    if (draft.includes(',')) {
      setProblem('Category names cannot contain a comma.');
      return;
    }
    const name = normalizeCategoryName(draft);
    if (!name) {
      setProblem(`Type a name of up to ${MAX_CATEGORY_LENGTH} characters.`);
      return;
    }
    // An existing name in other casing is just that category, not a new one.
    const existing = categories.find((c) => c.toLowerCase() === name.toLowerCase());
    onPick(existing ?? name);
  }

  return (
    <dialog
      className="sheet"
      aria-label="Change category"
      tabIndex={-1}
      ref={sheetRef}
      onClick={onBackdrop}
      // Escape, or the back gesture where the browser hands it to the dialog.
      // The board decides when the sheet goes, so the browser's own close waits.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="panel-head">
        <h2>Move to…</h2>
        <button type="button" className="icon-button" onClick={onClose}>
          cancel
        </button>
      </div>
      <p className="sheet-task" dir="auto">
        {task.title}
      </p>

      <div className="category-options">
        {categories.map((category) => {
          const current = category === task.category;
          const removable = isCustomCategory(category) && !usage.get(category) && !current;
          return (
            <span key={category} className="category-option">
              <button
                type="button"
                className={`option${current ? ' current' : ''}`}
                aria-pressed={current}
                onClick={() => (current ? onClose() : onPick(category))}
              >
                <CategoryChip category={category} />
                {current && <span className="option-check">✓</span>}
              </button>
              {removable && (
                <button
                  type="button"
                  className="option-remove"
                  onClick={() => onRemove(category)}
                  aria-label={`Remove the unused category ${category}`}
                  title="Not used by any task — remove it"
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
      </div>

      <form className="new-category" onSubmit={create}>
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          placeholder="New category…"
          aria-label="New category name"
          maxLength={MAX_CATEGORY_LENGTH + 10}
          dir="auto"
        />
        <button type="submit" className="primary-button" disabled={!draft.trim()}>
          Create
        </button>
      </form>
      {problem && (
        <p className="note bad" role="alert">
          {problem}
        </p>
      )}
    </dialog>
  );
}
