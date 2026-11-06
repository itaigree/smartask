'use client';

import { categoryHue } from '../lib/categories.ts';
import { isBuiltInCategory, type Category, type Priority } from '../lib/types.ts';

/** Small presentational chips shared by the capture preview and the task cards. */

/**
 * Built-ins use their palette colour. A custom category gets a hue derived from
 * its name — stable everywhere — at a lightness set per theme in CSS.
 */
function categoryStyle(category: Category): React.CSSProperties {
  return isBuiltInCategory(category)
    ? ({ '--chip-color': `var(--cat-${category})` } as React.CSSProperties)
    : ({ '--chip-hue': categoryHue(category) } as React.CSSProperties);
}

export function CategoryChip({
  category,
  onClick,
}: {
  category: Category;
  /** When given, the chip is a button that opens the category picker. */
  onClick?: () => void;
}) {
  const className = `chip category${isBuiltInCategory(category) ? '' : ' custom'}`;
  if (!onClick) {
    return (
      <span className={className} style={categoryStyle(category)} dir="auto">
        {category}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} editable`}
      style={categoryStyle(category)}
      onClick={onClick}
      aria-label={`Category: ${category}. Tap to change.`}
      dir="auto"
    >
      {category}
      <span className="chip-caret" aria-hidden="true">▾</span>
    </button>
  );
}

export function PriorityChip({ priority }: { priority: Priority }) {
  if (priority === 'Normal') return null;
  return <span className={`chip priority ${priority}`}>{priority}</span>;
}

/** Days until due, rendered the way a person would say it. */
export function dueLabel(due: string, daysAway: number | null): string {
  if (daysAway === null) return due;
  if (daysAway === 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  if (daysAway === -1) return 'Yesterday';
  if (daysAway < 0) return `${-daysAway} days late`;
  if (daysAway <= 6) {
    return new Date(due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
  }
  return new Date(due + 'T00:00:00').toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

export function DueChip({ due, daysAway }: { due: string; daysAway: number | null }) {
  const tone = daysAway === null ? '' : daysAway < 0 ? 'late' : daysAway <= 1 ? 'soon' : '';
  return <span className={`chip due ${tone}`}>{dueLabel(due, daysAway)}</span>;
}

export function ProjectChip({ project }: { project: string }) {
  return <span className="chip project">{project}</span>;
}

export function TagChip({ tag }: { tag: string }) {
  return <span className="chip tag">{tag}</span>;
}
