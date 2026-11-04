'use client';

import { VIEWS, VIEW_LABELS, type ViewId, type Counts } from '../lib/views.ts';

/** Badge number per tab, or null when the tab needs no badge. */
function badgeFor(view: ViewId, counts: Counts): { value: number; alert: boolean } | null {
  switch (view) {
    case 'focus':
      return null;
    case 'today':
      return counts.today > 0 ? { value: counts.today, alert: counts.overdue > 0 } : null;
    case 'categories':
      return counts.open > 0 ? { value: counts.open, alert: false } : null;
    default:
      return null;
  }
}

export default function ViewTabs({
  active,
  counts,
  onChange,
}: {
  active: ViewId;
  counts: Counts;
  onChange: (view: ViewId) => void;
}) {
  return (
    <div className="tabs" role="tablist" aria-label="Task views">
      {VIEWS.map((view) => {
        const badge = badgeFor(view, counts);
        return (
          <button
            key={view}
            role="tab"
            type="button"
            aria-selected={view === active}
            className="tab"
            onClick={() => onChange(view)}
          >
            {VIEW_LABELS[view]}
            {badge && (
              <span className={`tab-badge${badge.alert ? ' alert' : ''}`}>{badge.value}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
