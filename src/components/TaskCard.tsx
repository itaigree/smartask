'use client';

import { useState } from 'react';
import type { Task } from '../lib/types.ts';
import { daysUntilDue } from '../lib/views.ts';
import { CategoryChip, DueChip, PriorityChip, ProjectChip, TagChip } from './Chips.tsx';

export default function TaskCard({
  task,
  now,
  localOnly = false,
  onEditCategory,
  onToggle,
  onDelete,
}: {
  task: Task;
  now: Date;
  /** Opens the category picker for this task. */
  onEditCategory?: (task: Task) => void;
  /** Phone-only tasks have no trash to recover from, so the warning is stronger. */
  localOnly?: boolean;
  onToggle: (task: Task) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const done = task.status === 'Done';
  const daysAway = daysUntilDue(task, now);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card${done ? ' done' : ''}${busy ? ' busy' : ''}`}>
      <button
        type="button"
        className="check"
        aria-pressed={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        disabled={busy}
        onClick={() => run(() => onToggle(task))}
      >
        ✓
      </button>

      <div className="card-body">
        {/* dir="auto": a Hebrew title reads right-to-left, an English one left-to-right. */}
        <h3 className="card-title" dir="auto">
          {task.title}
        </h3>
        {task.note && (
          <p className="card-note" dir="auto">
            {task.note}
          </p>
        )}

        <div className="card-meta">
          <CategoryChip
            category={task.category}
            onClick={onEditCategory ? () => onEditCategory(task) : undefined}
          />
          {!done && <PriorityChip priority={task.priority} />}
          {task.due && <DueChip due={task.due} daysAway={done ? null : daysAway} />}
          {task.project && <ProjectChip project={task.project} />}
          {task.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      </div>

      <div className="card-actions">
        {task.url && (
          <a
            className="ghost-button"
            href={task.url}
            target="_blank"
            rel="noreferrer"
            title="Open in Notion"
            aria-label={`Open ${task.title} in Notion`}
          >
            ↗
          </a>
        )}
        <button
          type="button"
          className="ghost-button danger"
          title={localOnly ? 'Delete' : 'Move to Notion trash'}
          aria-label={`Delete ${task.title}`}
          disabled={busy}
          onClick={() => {
            const question = localOnly
              ? `Delete "${task.title}"? It is only on this device, so this cannot be undone.`
              : `Move "${task.title}" to the Notion trash?`;
            if (confirm(question)) {
              void run(() => onDelete(task));
            }
          }}
        >
          ✕
        </button>
      </div>
    </article>
  );
}
