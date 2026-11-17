'use client';

import { useState } from 'react';
import { isCustomCategory } from '../lib/categories.ts';
import { MAX_CATEGORY_LENGTH, normalizeCategoryName, type Category, type Task } from '../lib/types.ts';
import { CategoryChip } from './Chips.tsx';
import Sheet from './Sheet.tsx';

/**
 * The sheet for moving one task to another category, or to a brand-new one.
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
    <Sheet
      label="Change category"
      heading="Move to…"
      taskTitle={task.title}
      returnFocusTo={`[data-task-id="${CSS.escape(task.id)}"] .chip.category.editable`}
      onClose={onClose}
    >
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
    </Sheet>
  );
}
