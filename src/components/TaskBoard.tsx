'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotionConfig } from '../lib/config.ts';
import { maskToken } from '../lib/config.ts';
import { describeNotionError } from '../lib/notion.ts';
import type { CategorySignal, RuleInput } from '../lib/categorize/index.ts';
import { inboxTasks, sortInbox, type SortProgress } from '../lib/recategorize.ts';
import { createThrottle } from '../lib/throttle.ts';
import type { TaskRepository } from '../lib/tasks.ts';
import type { Task } from '../lib/types.ts';
import { buildView, countTasks, type ViewId } from '../lib/views.ts';
import QuickAdd from './QuickAdd.tsx';
import TaskCard from './TaskCard.tsx';
import ViewTabs from './ViewTabs.tsx';

/** Coming back to the app re-reads Notion, but no more often than this. */
const RETURN_REFRESH_MIN_MS = 10_000;

/**
 * Holds the task list client-side so an edit feels instant, and writes straight
 * to Notion, which stays the source of truth (PLAN.md decision 2 — the local
 * array is only ever a copy of what came back).
 */
export default function TaskBoard({
  repo,
  config,
  aiEnabled,
  classify,
  onDisconnect,
  onOpenAi,
}: {
  repo: TaskRepository;
  config: NotionConfig;
  aiEnabled: boolean;
  /** Direct Gemini call that throws on failure; null when AI is off. */
  classify: ((input: RuleInput) => Promise<CategorySignal>) | null;
  onDisconnect: () => void;
  onOpenAi: () => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [view, setView] = useState<ViewId>('focus');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** What happened to the last capture — who filed it, and why if it fell back. */
  const [lastCapture, setLastCapture] = useState<{ title: string; signal: CategorySignal } | null>(
    null,
  );
  const [sorting, setSorting] = useState<SortProgress | null>(null);
  const [sortNote, setSortNote] = useState<string | null>(null);

  /**
   * Views depend on the local date, which is only knowable in the browser, so
   * `now` is set after mount and refreshed each minute.
   */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      try {
        const loaded = await repo.listTasks({ fresh });
        setTasks(loaded);
        setError(null);
      } catch (e) {
        setError(describeNotionError(e));
        setTasks((current) => current ?? []);
      }
    },
    [repo],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => (now && tasks ? countTasks(tasks, now) : null), [tasks, now]);
  const result = useMemo(
    () => (now && tasks ? buildView(view, tasks, now) : null),
    [view, tasks, now],
  );

  const create = useCallback(
    async (text: string): Promise<Task | null> => {
      setCreating(true);
      try {
        const { task, signal } = await repo.captureTask(text);
        setTasks((current) => [task, ...(current ?? [])]);
        setLastCapture({ title: task.title, signal });
        setError(null);
        return task;
      } catch (e) {
        setError(describeNotionError(e));
        return null;
      } finally {
        setCreating(false);
      }
    },
    [repo],
  );

  const toggle = useCallback(
    async (task: Task) => {
      const next = task.status === 'Done' ? 'Todo' : 'Done';
      const previous = tasks;
      // Optimistic: the tick should respond instantly, Notion catches up.
      setTasks((current) =>
        (current ?? []).map((t) => (t.id === task.id ? { ...t, status: next } : t)),
      );
      try {
        const saved = await repo.updateTask(task.id, { status: next });
        setTasks((current) => (current ?? []).map((t) => (t.id === task.id ? saved : t)));
        setError(null);
      } catch (e) {
        setTasks(previous);
        setError(describeNotionError(e));
      }
    },
    [repo, tasks],
  );

  const remove = useCallback(
    async (task: Task) => {
      const previous = tasks;
      setTasks((current) => (current ?? []).filter((t) => t.id !== task.id));
      try {
        await repo.archiveTask(task.id);
        setError(null);
      } catch (e) {
        setTasks(previous);
        setError(describeNotionError(e));
      }
    },
    [repo, tasks],
  );

  const inbox = useMemo(() => (tasks ? inboxTasks(tasks) : []), [tasks]);

  const sortWithAi = useCallback(async () => {
    if (!classify || !tasks || sorting) return;
    setSortNote(null);
    setSorting({ done: 0, total: inboxTasks(tasks).length, changed: 0 });

    const outcome = await sortInbox(
      tasks,
      classify,
      (task, category) => repo.updateTask(task.id, { category }),
      {
        onProgress: setSorting,
        onUpdated: (saved) =>
          setTasks((current) => (current ?? []).map((t) => (t.id === saved.id ? saved : t))),
      },
    );

    setSorting(null);
    const moved = `Moved ${outcome.changed} of ${outcome.total} out of Inbox.`;
    setSortNote(
      outcome.stoppedReason
        ? `${moved} Stopped early: ${outcome.stoppedReason} Run it again in a minute to continue.`
        : outcome.changed < outcome.total
          ? `${moved} Gemini could not place the rest — they are genuinely ambiguous.`
          : moved,
    );
  }, [classify, tasks, sorting, repo]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNow(new Date());
    await load(true);
    setRefreshing(false);
  }, [load]);

  /**
   * Re-read Notion whenever the user comes back to the app — the moment that
   * matters on a phone: edit a task in Notion, switch back, and it is already
   * current. Not a timer: nothing is fetched while the app sits unused, and
   * bursts of focus events collapse to one request.
   *
   * Skipped while a capture or sort is mid-flight, so a refresh cannot replace
   * the list underneath an in-progress write.
   */
  const busyRef = useRef(false);
  busyRef.current = creating || refreshing || sorting !== null;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const allow = createThrottle(RETURN_REFRESH_MIN_MS);
    allow(); // the initial load counts as the first read

    const onReturn = () => {
      if (document.visibilityState !== 'visible' || busyRef.current) return;
      if (!allow()) return;
      void refreshRef.current();
    };

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);

  return (
    <>
      <header className="header">
        <div className="header-row">
          <h1 className="brand">
            Smart<span>Task</span>
          </h1>
          <div className="header-meta">
            {counts && <span>{counts.open} open</span>}
            <button
              type="button"
              className={`icon-button${aiEnabled ? ' on' : ''}`}
              onClick={onOpenAi}
              title={aiEnabled ? 'Gemini is classifying tasks' : 'Turn on AI classification'}
              aria-label="AI classification settings"
            >
              {aiEnabled ? '✦ AI on' : '✦ AI'}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={refresh}
              disabled={refreshing}
              title="Re-read from Notion"
            >
              {refreshing ? '…' : '↻'}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                if (
                  confirm(
                    `Forget the Notion token ${maskToken(config.token)} on this device?\n\n` +
                      'Your tasks stay in Notion. You will need to paste the token again.',
                  )
                ) {
                  onDisconnect();
                }
              }}
              title="Forget the token on this device"
            >
              ⏻
            </button>
          </div>
        </div>
      </header>

      <QuickAdd onCreate={create} busy={creating} aiEnabled={aiEnabled} />

      {lastCapture && (
        <CaptureNote
          title={lastCapture.title}
          signal={lastCapture.signal}
          aiEnabled={aiEnabled}
          onOpenAi={onOpenAi}
          onDismiss={() => setLastCapture(null)}
        />
      )}

      {inbox.length > 0 && (aiEnabled || sortNote) && (
        <div className="inbox-bar">
          {sorting ? (
            <span>
              ✦ Sorting… {sorting.done} of {sorting.total}
            </span>
          ) : sortNote ? (
            <span>{sortNote}</span>
          ) : (
            <span>
              {inbox.length} {inbox.length === 1 ? 'task' : 'tasks'} in Inbox
            </span>
          )}
          {aiEnabled && !sorting && (
            <button type="button" className="icon-button on" onClick={() => void sortWithAi()}>
              ✦ Sort with Gemini
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" onClick={() => void refresh()}>
            retry
          </button>
        </div>
      )}

      {counts && <ViewTabs active={view} counts={counts} onChange={setView} />}

      {!result || !now ? (
        <div aria-hidden="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : result.groups.length === 0 ? (
        <p className="empty">{result.emptyMessage}</p>
      ) : (
        result.groups.map((group) => (
          <section className="group" key={group.key}>
            <div className={`group-head${group.key === 'overdue' ? ' overdue' : ''}`}>
              <h2 className="group-title">{group.label}</h2>
              <span className="group-count">{group.tasks.length}</span>
            </div>
            <div className="cards">
              {group.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  now={now}
                  hideCategory={view === 'categories'}
                  onToggle={toggle}
                  onDelete={remove}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}

/**
 * One line under the capture box saying who filed the last task and where.
 * Without this, "Inbox from Gemini" and "Inbox because Gemini failed" look
 * identical — which is exactly the confusion it exists to prevent.
 */
function CaptureNote({
  title,
  signal,
  aiEnabled,
  onOpenAi,
  onDismiss,
}: {
  title: string;
  signal: CategorySignal;
  aiEnabled: boolean;
  onOpenAi: () => void;
  onDismiss: () => void;
}) {
  let body: React.ReactNode;
  let tone = 'ok';

  if (signal.source === 'gemini') {
    body = (
      <>
        ✦ Gemini filed <strong>{title}</strong> under <strong>{signal.category}</strong>
        {signal.reason ? ` — ${signal.reason}` : ''}
      </>
    );
  } else if (signal.fallbackReason) {
    tone = 'bad';
    body = (
      <>
        Gemini failed, so keyword rules filed this under <strong>{signal.category}</strong>.{' '}
        {signal.fallbackReason}
      </>
    );
  } else if (signal.category === 'Inbox' && !aiEnabled) {
    tone = 'hint';
    body = (
      <>
        Filed in Inbox — the keyword rules only understand English.{' '}
        <button type="button" className="link-button" onClick={onOpenAi}>
          Turn on ✦ AI
        </button>{' '}
        to sort tasks in any language.
      </>
    );
  } else {
    body = (
      <>
        Filed under <strong>{signal.category}</strong> by keyword rules ({signal.reason}).
      </>
    );
  }

  return (
    <div className={`capture-note ${tone}`} role="status">
      <span>{body}</span>
      <button type="button" className="ghost-button" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
