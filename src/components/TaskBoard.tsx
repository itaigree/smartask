'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { maskToken, notionDatabaseUrl } from '../lib/config.ts';
import { ValidationError } from '../lib/capture.ts';
import { LocalStoreError, TASKS_KEY } from '../lib/local-store.ts';
import { describeNotionError } from '../lib/notion.ts';
import type { CategorySignal, RuleInput } from '../lib/categorize/index.ts';
import { inboxTasks, sortInbox, type SortProgress } from '../lib/recategorize.ts';
import { categoryList, unseenCategories } from '../lib/categories.ts';
import CategoryPicker from './CategoryPicker.tsx';
import { createThrottle } from '../lib/throttle.ts';
import type { TaskRepository } from '../lib/tasks.ts';
import type { Task, TaskPatch } from '../lib/types.ts';
import {
  forgetOldWrites, mergeRead, replaceTask, restoreTask, type RecentWrite,
} from '../lib/board-sync.ts';
import { buildView, countTasks, daysUntilDue, type ViewId } from '../lib/views.ts';
import { dueLabel } from './Chips.tsx';
import QuickAdd from './QuickAdd.tsx';
import TaskCard from './TaskCard.tsx';
import ViewTabs from './ViewTabs.tsx';

/** Coming back to the app re-reads Notion, but no more often than this. */
const RETURN_REFRESH_MIN_MS = 10_000;

/** How long a just-ticked task stays in place, struck through, before it leaves the list. */
const SETTLE_MS = 2_000;

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
  /** Reading the list failed. Stays until a read succeeds; "retry" re-reads. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A save failed. Says which; dismissed by hand or cleared by the next save. */
  const [writeError, setWriteError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** What happened to the last capture — who filed it, and why if it fell back. */
  const [lastCapture, setLastCapture] = useState<{ task: Task; signal: CategorySignal } | null>(
    null,
  );
  const [sorting, setSorting] = useState<SortProgress | null>(null);
  /**
   * The id of the task whose category picker is open. The id, not the task:
   * a sort or a refresh may change that task while the sheet is open, and the
   * sheet must show and save against the task as it is now.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sortNote, setSortNote] = useState<string | null>(null);
  /**
   * Tasks just ticked done, shown in place (struck through) for a moment
   * instead of vanishing: otherwise the next card slides under the finger and a
   * double tap completes it too. A second tap on the struck card reopens it.
   */
  const [settling, setSettling] = useState<ReadonlyMap<string, Task>>(new Map());
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** The latest list, for callbacks that run after a wait (a sort, a save). */
  const tasksRef = useRef<Task[] | null>(null);
  tasksRef.current = tasks;

  /** This device's recent writes, merged into every read (see board-sync.ts). */
  const recentWrites = useRef(new Map<string, RecentWrite>());
  /** The newest write per task, so an older answer arriving late is ignored. */
  const latestWrite = useRef(new Map<string, number>());
  const writeCounter = useRef(0);
  /** Whether a read has ever succeeded; until then, the list on screen is not the list. */
  const everLoaded = useRef(false);

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

  useEffect(() => {
    const timers = settleTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      const startedAt = Date.now();
      try {
        const loaded = await repo.listTasks({ fresh });
        forgetOldWrites(recentWrites.current, Date.now());
        // Merged, not replaced: a read that started before a tick, an add or a
        // delete must not land afterwards and undo it.
        setTasks(mergeRead(loaded, recentWrites.current, startedAt));
        everLoaded.current = true;
        setLoadError(null);
      } catch (e) {
        setLoadError(describeError(e));
        setTasks((current) => current ?? []);
      }
    },
    [repo],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A new repository means a different store or a restored backup: what this
  // device wrote before no longer describes it. Writes still in flight stay.
  useEffect(() => {
    for (const [id, write] of recentWrites.current) {
      if (!write.pending) recentWrites.current.delete(id);
    }
  }, [repo]);

  /** A save went through. If the list never loaded, now is a good time to try again. */
  const savedOk = useCallback(() => {
    setWriteError(null);
    if (!everLoaded.current) void load(true);
  }, [load]);

  /**
   * Change one task: show it at once, save it, and on failure put back only
   * that task — never the whole list as it was, which would wipe anything
   * else saved meanwhile. Throws on failure when `quiet` (the sort reports it).
   */
  const writeTask = useCallback(
    async (before: Task, patch: TaskPatch, { quiet = false } = {}): Promise<Task> => {
      const id = before.id;
      const optimistic: Task = { ...before, ...patch };
      const mine = ++writeCounter.current;
      latestWrite.current.set(id, mine);
      recentWrites.current.set(id, { task: optimistic, at: Date.now(), pending: true });
      setTasks((current) => replaceTask(current, id, optimistic));

      try {
        const saved = await repo.updateTask(id, patch);
        if (latestWrite.current.get(id) === mine) {
          recentWrites.current.set(id, { task: saved, at: Date.now(), pending: false });
          setTasks((current) => replaceTask(current, id, saved));
          savedOk();
        }
        return saved;
      } catch (e) {
        // A newer change to this task is in flight; it decides what shows.
        if (latestWrite.current.get(id) === mine) {
          recentWrites.current.delete(id);
          setTasks((current) => replaceTask(current, id, before));
          if (!quiet) setWriteError(`Could not save “${before.title}”: ${describeError(e)}`);
        }
        throw e;
      }
    },
    [repo, savedOk],
  );

  const counts = useMemo(() => (now && tasks ? countTasks(tasks, now) : null), [tasks, now]);

  /**
   * Just-ticked tasks keep their open place for a moment (see `settling`) —
   * in the open-task views only; the Done view shows them straight away.
   */
  const shown = useMemo(
    () =>
      tasks && settling.size && view !== 'done'
        ? tasks.map((t) => (t.status === 'Done' && settling.get(t.id)) || t)
        : tasks,
    [tasks, settling, view],
  );
  const result = useMemo(
    () => (now && shown ? buildView(view, shown, now) : null),
    [view, shown, now],
  );
  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  const create = useCallback(
    async (text: string): Promise<Task | null> => {
      setCreating(true);
      try {
        const { task, signal } = await repo.captureTask(text);
        recentWrites.current.set(task.id, { task, at: Date.now(), pending: false });
        setTasks((current) => [task, ...(current ?? []).filter((t) => t.id !== task.id)]);
        setLastCapture({ task, signal });
        setSortNote(null);
        savedOk();
        return task;
      } catch (e) {
        setWriteError(
          `Could not save the task: ${describeError(e)} Your text is still in the box — tap Add to try again.`,
        );
        return null;
      } finally {
        setCreating(false);
      }
    },
    [repo, savedOk],
  );

  const settle = useCallback((id: string, before: Task | null) => {
    const timers = settleTimers.current;
    clearTimeout(timers.get(id));
    timers.delete(id);
    setSettling((current) => {
      const next = new Map(current);
      if (before) next.set(id, before);
      else next.delete(id);
      return next;
    });
    if (before) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setSettling((current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }, SETTLE_MS),
      );
    }
  }, []);

  const toggle = useCallback(
    async (task: Task) => {
      // The card may hold an older copy; act on the task as it is now.
      const live = tasksRef.current?.find((t) => t.id === task.id) ?? task;
      const next = live.status === 'Done' ? 'Todo' : 'Done';
      settle(live.id, next === 'Done' ? live : null);
      try {
        await writeTask(live, { status: next });
      } catch {
        settle(live.id, null);
      }
    },
    [settle, writeTask],
  );

  const remove = useCallback(
    async (task: Task) => {
      const id = task.id;
      const index = tasksRef.current?.findIndex((t) => t.id === id) ?? -1;
      const mine = ++writeCounter.current;
      latestWrite.current.set(id, mine);
      recentWrites.current.set(id, { task: null, at: Date.now(), pending: true });
      setTasks((current) => (current ?? []).filter((t) => t.id !== id));
      try {
        await repo.archiveTask(id);
        if (latestWrite.current.get(id) !== mine) return;
        recentWrites.current.set(id, { task: null, at: Date.now(), pending: false });
        // A read may have landed meanwhile; make sure the task stays gone.
        setTasks((current) => (current ?? []).filter((t) => t.id !== id));
        savedOk();
      } catch (e) {
        if (latestWrite.current.get(id) !== mine) return;
        recentWrites.current.delete(id);
        setTasks((current) => restoreTask(current, task, index));
        setWriteError(`Could not delete “${task.title}”: ${describeError(e)}`);
      }
    },
    [repo, savedOk],
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

  const editing = editingId ? byId.get(editingId) ?? null : null;

  const changeCategory = useCallback(
    async (id: string, category: string) => {
      setEditingId(null);
      const live = tasksRef.current?.find((t) => t.id === id);
      if (!live || category === live.category) return;

      // A brand-new name joins the list straight away, so it is offered next time.
      if (!allCategories.some((c) => c.toLowerCase() === category.toLowerCase())) {
        onCustomCategoriesChange([...customCategories, category]);
      }

      try {
        await writeTask(live, { category });
      } catch {
        // writeTask put the task back and said why.
      }
    },
    [allCategories, customCategories, onCustomCategoriesChange, writeTask],
  );

  const removeCategory = useCallback(
    (name: string) => onCustomCategoriesChange(customCategories.filter((c) => c !== name)),
    [customCategories, onCustomCategoriesChange],
  );

  /**
   * A running sort is cancelled when the board closes (⏻, or leaving for the
   * first-launch screen) and when the AI settings or the store change: it must
   * not carry on with a key that was just removed, or a token that was just
   * forgotten.
   */
  const sortAbort = useRef<AbortController | null>(null);
  useEffect(() => () => sortAbort.current?.abort(), [classify, repo]);

  const sortWithAi = useCallback(async () => {
    if (!classify || !tasksRef.current || sortAbort.current) return;
    const controller = new AbortController();
    sortAbort.current = controller;
    setSortNote(null);
    setSorting({ done: 0, total: inboxTasks(tasksRef.current).length, changed: 0 });

    try {
      const outcome = await sortInbox(
        tasksRef.current,
        classify,
        (task, category) => writeTask(task, { category }, { quiet: true }),
        {
          onProgress: setSorting,
          current: (id) => tasksRef.current?.find((t) => t.id === id),
          signal: controller.signal,
        },
      );

      if (outcome.cancelled) {
        setSortNote('Sorting stopped because the AI settings changed.');
        return;
      }
      const moved = `Moved ${outcome.changed} of ${outcome.total} out of Inbox.`;
      const skipped = outcome.skipped
        ? ` Left ${outcome.skipped} you changed meanwhile as you set ${outcome.skipped === 1 ? 'it' : 'them'}.`
        : '';
      const placed = outcome.changed + (outcome.skipped ?? 0);
      setSortNote(
        outcome.stoppedReason
          ? `${moved}${skipped} Stopped early: ${outcome.stoppedReason} Run it again in a minute to continue.`
          : placed < outcome.total
            ? `${moved}${skipped} Gemini could not place the rest — they are genuinely ambiguous.`
            : `${moved}${skipped}`,
      );
    } finally {
      if (sortAbort.current === controller) sortAbort.current = null;
      setSorting(null);
    }
  }, [classify, writeTask]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNow(new Date());
    await load(true);
    setRefreshing(false);
  }, [load]);

  /**
   * Re-read whenever the user comes back to the app — the moment that matters
   * on a phone: edit a task in Notion, switch back, and it is already current.
   * Not a timer: nothing is fetched while the app sits unused, and bursts of
   * focus events collapse to one Notion request.
   *
   * Phone-only mode re-reads too, and also when another copy of the app (the
   * installed app and a browser tab share storage) changes the tasks, so a
   * copy left open never acts on a stale list. Reads merge with this device's
   * recent writes, so one landing mid-save cannot undo it.
   */
  const busyRef = useRef(false);
  busyRef.current = creating || refreshing || sorting !== null;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const allow = createThrottle(isLocal ? 0 : RETURN_REFRESH_MIN_MS);
    allow(); // the initial load counts as the first read

    const onReturn = () => {
      if (document.visibilityState !== 'visible' || busyRef.current) return;
      if (!allow()) return;
      void refreshRef.current();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === TASKS_KEY) void refreshRef.current();
    };

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    if (isLocal) window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('storage', onStorage);
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

      {(sorting || sortNote || (inbox.length > 0 && aiEnabled)) && (
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
          {aiEnabled && !sorting && inbox.length > 0 && (
            <button type="button" className="icon-button on" onClick={() => void sortWithAi()}>
              ✦ Sort with Gemini
            </button>
          )}
          {sortNote && !sorting && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => setSortNote(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {loadError && (
        <div className="banner" role="alert">
          <span>
            {everLoaded.current
              ? `Could not refresh the list: ${loadError}`
              : `Could not load your tasks: ${loadError} Tasks you add now are still saved.`}
          </span>
          <button type="button" className="icon-button" onClick={() => void refresh()}>
            retry
          </button>
        </div>
      )}

      {writeError && (
        <div className="banner" role="alert">
          <span>{writeError}</span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setWriteError(null)}
            aria-label="Dismiss"
          >
            ✕
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
                  // A settling card shows the real (done) task: struck through,
                  // and a tap reopens it.
                  task={settling.has(task.id) ? byId.get(task.id) ?? task : task}
                  now={now}
                  localOnly={isLocal}
                  onEditCategory={(t) => setEditingId(t.id)}
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
          onPick={(category) => void changeCategory(editing.id, category)}
          onRemove={removeCategory}
          onClose={() => setEditingId(null)}
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
