'use client';

import { useEffect, useRef, useState } from 'react';
import { isCustomCategory } from '../lib/categories.ts';
import { MAX_CATEGORY_LENGTH, normalizeCategoryName, type Category, type Task } from '../lib/types.ts';
import { CategoryChip } from './Chips.tsx';

/**
 * A sheet that slides up from the bottom — the natural reach on a phone — to
 * move one task to another category, or to a brand-new one.
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
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Change category"
        tabIndex={-1}
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
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
        {problem && <p className="note bad">{problem}</p>}
      </div>
    </div>
  );
}
