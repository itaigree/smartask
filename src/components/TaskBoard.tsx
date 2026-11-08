'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { maskToken, notionDatabaseUrl } from '../lib/config.ts';
import { ValidationError } from '../lib/capture.ts';
import { LocalStoreError } from '../lib/local-store.ts';
import { describeNotionError } from '../lib/notion.ts';
import type { CategorySignal, RuleInput } from '../lib/categorize/index.ts';
import { inboxTasks, sortInbox, type SortProgress } from '../lib/recategorize.ts';
import { categoryList, unseenCategories } from '../lib/categories.ts';
import CategoryPicker from './CategoryPicker.tsx';
import { createThrottle } from '../lib/throttle.ts';
import type { TaskRepository } from '../lib/tasks.ts';
import type { Task } from '../lib/types.ts';
import { buildView, countTasks, daysUntilDue, type ViewId } from '../lib/views.ts';
import { dueLabel } from './Chips.tsx';
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
  storage,
  aiEnabled,
  classify,
  onLeave,
  onOpenAi,
  customCategories,
  onCustomCategoriesChange,
}: {
  repo: TaskRepository;
  /** Where tasks live; changes wording, and whether there is anything to re-read. */
  storage: { kind: 'notion'; token: string; databaseId: string } | { kind: 'local' };
  aiEnabled: boolean;
  /** Direct Gemini call that throws on failure; null when AI is off. */
  classify: ((input: RuleInput) => Promise<CategorySignal>) | null;
  /** Leave this store for the first-launch choice. Never deletes tasks. */
  onLeave: () => void;
  onOpenAi: () => void;
  /** Categories the user created, beyond the built-ins. */
  customCategories: string[];
  onCustomCategoriesChange: (next: string[]) => void;
}) {
  const isLocal = storage.kind === 'local';

  /** Local errors already read well; Notion's need translating. */
  const describeError = (e: unknown) =>
    e instanceof LocalStoreError || e instanceof ValidationError
      ? e.message
      : describeNotionError(e);

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [view, setView] = useState<ViewId>('focus');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** What happened to the last capture — who filed it, and why if it fell back. */
  const [lastCapture, setLastCapture] = useState<{ task: Task; signal: CategorySignal } | null>(
    null,
  );
  const [sorting, setSorting] = useState<SortProgress | null>(null);
  /** The task whose category picker is open. */
  const [editing, setEditing] = useState<Task | null>(null);
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
        setError(describeError(e));
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
        setLastCapture({ task, signal });
        setError(null);
        return task;
      } catch (e) {
        setError(describeError(e));
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
        setError(describeError(e));
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
        setError(describeError(e));
      }
    },
    [repo, tasks],
  );

  const inbox = useMemo(() => (tasks ? inboxTasks(tasks) : []), [tasks]);

  const allCategories = useMemo(
    () => categoryList(customCategories, tasks ?? []),
    [customCategories, tasks],
  );

  /** Tasks per category, so a custom one nobody uses can be offered for removal. */
  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks ?? []) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    return counts;
  }, [tasks]);

  // Learn categories found on tasks — made on another device, or added straight
  // in Notion — so they appear in the picker and Gemini is offered them too.
  useEffect(() => {
    if (!tasks) return;
    const unseen = unseenCategories(customCategories, tasks);
    if (unseen.length) onCustomCategoriesChange([...customCategories, ...unseen]);
  }, [tasks, customCategories, onCustomCategoriesChange]);

  const changeCategory = useCallback(
    async (task: Task, category: string) => {
      setEditing(null);
      if (category === task.category) return;

      // A brand-new name joins the list straight away, so it is offered next time.
      if (!allCategories.some((c) => c.toLowerCase() === category.toLowerCase())) {
        onCustomCategoriesChange([...customCategories, category]);
      }

      const previous = tasks;
      setTasks((current) =>
        (current ?? []).map((t) => (t.id === task.id ? { ...t, category } : t)),
      );
      try {
        const saved = await repo.updateTask(task.id, { category });
        setTasks((current) => (current ?? []).map((t) => (t.id === task.id ? saved : t)));
        setError(null);
      } catch (e) {
        setTasks(previous);
        setError(describeError(e));
      }
    },
    [allCategories, customCategories, onCustomCategoriesChange, repo, tasks],
  );

  const removeCategory = useCallback(
    (name: string) => onCustomCategoriesChange(customCategories.filter((c) => c !== name)),
    [customCategories, onCustomCategoriesChange],
  );

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

    if (isLocal) return; // nothing outside this device can change local tasks

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
  }, [isLocal]);

  return (
    <>
      <header className="header">
        <div className="header-row">
          <h1 className="brand">
            Smart<span>Task</span>
          </h1>
          <div className="header-meta">
            {counts && <span className="open-count">{counts.open} open</span>}
            <button
              type="button"
              className={`icon-button${aiEnabled ? ' on' : ''}`}
              onClick={onOpenAi}
              title={aiEnabled ? 'Gemini is classifying tasks' : 'Turn on AI classification'}
              aria-label="AI classification settings"
            >
              {aiEnabled ? '✦ AI on' : '✦ AI'}
            </button>
            {storage.kind === 'notion' && (
              <a
                className="icon-button notion-link"
                href={notionDatabaseUrl(storage.databaseId)}
                target="_blank"
                rel="noreferrer"
                title="Open your tasks database in Notion"
              >
                Notion ↗
              </a>
            )}
            {!isLocal && (
              <button
                type="button"
                className="icon-button"
                onClick={refresh}
                disabled={refreshing}
                title="Re-read from Notion"
              >
                {refreshing ? '…' : '↻'}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                const message =
                  storage.kind === 'notion'
                    ? `Forget the Notion token ${maskToken(storage.token)} on this device?\n\n` +
                      'Your tasks stay in Notion. You will need to paste the token again.'
                    : 'Switch away from phone-only storage?\n\n' +
                      'Your tasks stay saved on this device and come back if you choose ' +
                      'phone-only again.';
                if (confirm(message)) onLeave();
              }}
              title={isLocal ? 'Change where tasks are stored' : 'Forget the token on this device'}
            >
              ⏻
            </button>
          </div>
        </div>
      </header>

      <QuickAdd onCreate={create} busy={creating} aiEnabled={aiEnabled} />

      {lastCapture && (
        <CaptureNote
          task={lastCapture.task}
          now={now}
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
                  localOnly={isLocal}
                  onEditCategory={setEditing}
                  onToggle={toggle}
                  onDelete={remove}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {editing && (
        <CategoryPicker
          task={editing}
          categories={allCategories}
          usage={usage}
          onPick={(category) => void changeCategory(editing, category)}
          onRemove={removeCategory}
          onClose={() => setEditing(null)}
        />
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
  task,
  now,
  signal,
  aiEnabled,
  onOpenAi,
  onDismiss,
}: {
  task: Task;
  now: Date | null;
  signal: CategorySignal;
  aiEnabled: boolean;
  onOpenAi: () => void;
  onDismiss: () => void;
}) {
  const title = task.title;
  let body: React.ReactNode;
  let tone = 'ok';
  const due = task.due ? (
    <>
      , due <strong>{dueLabel(task.due, now ? daysUntilDue(task, now) : null)}</strong>
    </>
  ) : null;

  if (signal.source === 'gemini' && signal.created) {
    body = (
      <>
        ✦ None of your categories fitted <strong dir="auto">{title}</strong>, so Gemini created{' '}
        <strong dir="auto">{signal.category}</strong>
        {due}
        {signal.reason ? ` — ${signal.reason}` : ''}. Tap the category on the task to change it.
      </>
    );
  } else if (signal.source === 'gemini') {
    body = (
      <>
        ✦ Gemini filed <strong dir="auto">{title}</strong> under{' '}
        <strong>{signal.category}</strong>
        {due}
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
