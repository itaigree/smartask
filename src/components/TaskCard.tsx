'use client';

import { useState } from 'react';
import type { Task } from '../lib/types.ts';
import { isRinging, reminderLabel } from '../lib/reminders.ts';
import { daysUntilDue } from '../lib/views.ts';
import {
  CategoryChip, DueChip, PriorityChip, ProjectChip, ReminderChip, TagChip,
} from './Chips.tsx';

export default function TaskCard({
  task,
  now,
  localOnly = false,
  onEditCategory,
  onEditReminder,
  onToggle,
  onDelete,
}: {
  task: Task;
  now: Date;
  /** Opens the category picker for this task. */
  onEditCategory?: (task: Task) => void;
  /** Opens the reminder sheet for this task. */
  onEditReminder?: (task: Task) => void;
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
    <article
      className={`card${done ? ' done' : ''}${busy ? ' busy' : ''}`}
      // How the category sheet finds this card again, to hand focus back to its chip.
      data-task-id={task.id}
    >
      <button
        type="button"
        className="check"
        aria-pressed={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        // Never disabled while saving: saves to one task are queued in order,
        // and a second tap is how a just-ticked task is reopened.
        onClick={() => void onToggle(task)}
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
          {/* A finished task has nothing left to remind about. */}
          {task.reminder && !done && (
            <ReminderChip
              label={reminderLabel(task.reminder, now)}
              ringing={isRinging(task, now)}
              onClick={onEditReminder ? () => onEditReminder(task) : undefined}
            />
          )}
          {task.project && <ProjectChip project={task.project} />}
          {task.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      </div>

      <div className="card-actions">
        {/* With a reminder set, its chip is the control; this is the way to set one. */}
        {onEditReminder && !done && !task.reminder && (
          <button
            type="button"
            className="ghost-button bell reminder-control"
            title="Set a reminder"
            aria-label={`Set a reminder for ${task.title}`}
            onClick={() => onEditReminder(task)}
          >
            🔔
          </button>
        )}
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
