'use client';

import { useEffect, useMemo, useState } from 'react';
import { askToNotify, notifyState, type NotifyState } from '../lib/notify.ts';
import {
  calendarFile, fromLocalInput, googleCalendarUrl, reminderLabel, reminderPresets,
  reminderTime, toLocalInput,
} from '../lib/reminders.ts';
import type { Task } from '../lib/types.ts';
import Sheet from './Sheet.tsx';

/** What the app can promise about a reminder, given what this browser allows. */
const DELIVERY: Record<NotifyState, string> = {
  granted:
    'This device notifies you while the app is open or in the background. If the app is fully ' +
    'closed, the reminder is waiting at the top when you open it.',
  default:
    'You will be asked to allow notifications. Without them, the reminder shows at the top of ' +
    'the app when its time comes.',
  denied:
    'Notifications are blocked for this site, so the reminder only shows at the top of the app. ' +
    'To be notified, allow notifications for it in the browser’s site settings.',
  unsupported:
    'This browser cannot show notifications here, so the reminder shows at the top of the app ' +
    'when its time comes. On an iPhone, add the app to the Home Screen to be notified.',
};

/**
 * The sheet for one task's reminder: a few one-tap times, any other time, and
 * — once a reminder is set — removing it or handing it to the phone's calendar.
 */
export default function ReminderPicker({
  task,
  now,
  onPick,
  onClose,
}: {
  task: Task;
  now: Date;
  /** The chosen moment as an ISO instant, or null to remove the reminder. */
  onPick: (reminder: string | null) => void;
  onClose: () => void;
}) {
  const current = reminderTime(task);
  const presets = useMemo(() => reminderPresets(now, task.due), [now, task.due]);

  // The custom field starts on the current reminder, or an hour from now.
  const [custom, setCustom] = useState(() =>
    toLocalInput(current !== null && current > now.getTime() ? new Date(current) : presets[0].at),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyState>('default');
  useEffect(() => setNotify(notifyState()), []);

  /**
   * Set the reminder. The permission question is asked here, on the tap that
   * sets the first reminder — the moment it makes sense — and whatever the
   * answer, the reminder is saved: it still shows inside the app.
   */
  async function pick(at: Date) {
    await askToNotify();
    onPick(at.toISOString());
  }

  function pickCustom(event: React.FormEvent) {
    event.preventDefault();
    const at = fromLocalInput(custom);
    if (!at) {
      setProblem('Choose a date and a time.');
      return;
    }
    if (at.getTime() <= Date.now()) {
      setProblem('That time has already passed.');
      return;
    }
    void pick(at);
  }

  // A link the browser saves as a .ics file; opening it adds the event, with
  // its alarm, to the phone's own calendar.
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (current === null) return;
    const file = calendarFile(task, new Date(current), new Date());
    const url = URL.createObjectURL(new Blob([file], { type: 'text/calendar;charset=utf-8' }));
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [current, task.id, task.title, task.note]);

  return (
    <Sheet
      label="Set a reminder"
      heading="Remind me…"
      taskTitle={task.title}
      returnFocusTo={`[data-task-id="${CSS.escape(task.id)}"] .reminder-control`}
      onClose={onClose}
    >
      {current !== null && task.reminder && (
        <div className="reminder-current">
          <p>
            <span aria-hidden="true">🔔</span> Set for{' '}
            <strong>{reminderLabel(task.reminder, now)}</strong>
            {current <= now.getTime() ? ' — waiting for you' : ''}
          </p>
          <button type="button" className="icon-button" onClick={() => onPick(null)}>
            Remove
          </button>
        </div>
      )}

      <div className="reminder-options">
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="option"
            onClick={() => void pick(preset.at)}
          >
            <span>{preset.label}</span>
            <span className="option-time">{reminderLabel(preset.at.toISOString(), now)}</span>
          </button>
        ))}
      </div>

      <form className="new-category" onSubmit={pickCustom}>
        <input
          type="datetime-local"
          value={custom}
          min={toLocalInput(now)}
          onChange={(e) => {
            setCustom(e.target.value);
            setProblem(null);
          }}
          aria-label="Another date and time"
        />
        <button type="submit" className="primary-button" disabled={!custom}>
          Set
        </button>
      </form>
      {problem && (
        <p className="note bad" role="alert">
          {problem}
        </p>
      )}

      <p className="sheet-note">{DELIVERY[notify]}</p>

      {current === null && (
        <p className="sheet-note">
          For an alert even when the app is closed, set the reminder, then tap it on the task to
          add it to your calendar.
        </p>
      )}

      {current !== null && current > now.getTime() && (
        <p className="sheet-note">
          For an alert even when the app is closed, add it to your calendar:{' '}
          <a
            href={googleCalendarUrl(task.title, new Date(current), task.note)}
            target="_blank"
            rel="noreferrer"
          >
            Google Calendar ↗
          </a>
          {fileUrl && (
            <>
              {' '}
              or a{' '}
              <a href={fileUrl} download="smarttask-reminder.ics">
                calendar file
              </a>
            </>
          )}
          .
        </p>
      )}
    </Sheet>
  );
}
