'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { maskToken, notionDatabaseUrl } from '../lib/config.ts';
import { ValidationError } from '../lib/capture.ts';
import { LocalStoreError, TASKS_KEY } from '../lib/local-store.ts';
import { describeNotionError, UnconfirmedSaveError } from '../lib/notion.ts';
import { rulesCanRead, type CategorySignal, type RuleInput } from '../lib/categorize/index.ts';
import { inboxTasks, sortInbox, type SortProgress } from '../lib/recategorize.ts';
import { categoryList, learnCategories } from '../lib/categories.ts';
import CategoryPicker from './CategoryPicker.tsx';
import { createThrottle } from '../lib/throttle.ts';
import type { TaskRepository } from '../lib/tasks.ts';
import type { Task, TaskPatch } from '../lib/types.ts';
import {
  forgetOldWrites, ledgerTask, mergeRead, replaceTask, restoreTask,
  type Ledger, type RecentWrite,
} from '../lib/board-sync.ts';
import { buildView, countTasks, daysUntilDue, type ViewId } from '../lib/views.ts';
import { dueLabel } from './Chips.tsx';
import QuickAdd from './QuickAdd.tsx';
import TaskCard from './TaskCard.tsx';
import ViewTabs from './ViewTabs.tsx';

/** Coming back to the app re-reads Notion, but no more often than this. */
const RETURN_REFRESH_MIN_MS = 10_000;

/**
 * How long after the last tap a just-ticked task stays in place, struck
 * through, before it moves. Every tap on the list restarts it.
 */
const SETTLE_MS = 2_000;

/**
 * When settled cards finally move, the list shifts. A ✓ or ✕ tap landing this
 * soon after was aimed at the old layout, so it is ignored rather than allowed
 * to hit whatever card slid under the finger.
 */
const SHIFT_GUARD_MS = 400;

/** See `graceMs` below: how far Notion's query may lag behind a confirmed write. */
const NOTION_READ_GRACE_MS = 5_000;

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
  /**
   * A save failed, and which. Stays until dismissed — a later save that works
   * says nothing about the one that did not — except that a failed add clears
   * once an add goes through.
   */
  const [writeError, setWriteError] = useState<{ text: string; add: boolean } | null>(null);
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
   * Tasks just ticked (or reopened), kept where they were for a moment instead
   * of jumping to their new place: otherwise the next card slides under the
   * finger and a double tap completes it too. The card shows its new state
   * (struck through); a second tap on it undoes the first. They all leave
   * together once the user has stopped tapping for a moment, so the list never
   * shifts under a finger that is about to tap.
   */
  const [settling, setSettling] = useState<ReadonlyMap<string, { copy: Task; view: ViewId }>>(
    new Map(),
  );
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  /** The latest list, for callbacks that run after a wait (a sort, a save). */
  const tasksRef = useRef<Task[] | null>(null);
  tasksRef.current = tasks;

  /** This device's recent writes, merged into every read (see board-sync.ts). */
  const recentWrites = useRef(new Map<string, RecentWrite>());
  /** Per-task save queues (see `Ledger`). */
  const ledgers = useRef(new Map<string, Ledger>());
  const writeCounter = useRef(0);
  /** Whether a read has ever succeeded; until then, the list on screen is not the list. */
  const everLoaded = useRef(false);
  /** Reads are numbered so an older one landing late never replaces a newer one. */
  const readCounter = useRef(0);
  const appliedRead = useRef(0);
  /**
   * How long a finished write outranks a read that started after it. Notion's
   * query can lag a moment behind a write it has confirmed; device storage
   * never does, so there a newer read always wins — it may hold a change made
   * in another open copy of the app.
   */
  const graceMs = isLocal ? 0 : NOTION_READ_GRACE_MS;

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

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      const mine = ++readCounter.current;
      const startedAt = Date.now();
      try {
        const loaded = await repo.listTasks({ fresh });
        if (mine < appliedRead.current) return; // a newer read already landed
        appliedRead.current = mine;
        forgetOldWrites(recentWrites.current, Date.now());
        // Merged, not replaced: a read that started before a tick, an add or a
        // delete must not land afterwards and undo it.
        setTasks(mergeRead(loaded, recentWrites.current, startedAt, graceMs));
        everLoaded.current = true;
        setLoadError(null);
      } catch (e) {
        if (mine < appliedRead.current) return;
        setLoadError(describeError(e));
        setTasks((current) => current ?? []);
      }
    },
    [repo, graceMs],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** A save went through. If the list never loaded, now is a good time to try again. */
  const savedOk = useCallback(() => {
    if (!everLoaded.current) void load(true);
  }, [load]);

  /** Show what a task's ledger says, and record it for merging into reads. */
  const publish = useCallback((id: string) => {
    const ledger = ledgers.current.get(id);
    if (!ledger) return;
    const shownTask = ledgerTask(ledger);
    recentWrites.current.set(
      id,
      ledger.pending.length
        ? { task: shownTask, at: Date.now(), pending: true }
        : { task: ledger.confirmed, at: ledger.confirmedAt, pending: false },
    );
    setTasks((current) =>
      shownTask
        ? restoreTask(replaceTask(current, id, shownTask), shownTask, ledger.index)
        : (current ?? []).filter((t) => t.id !== id),
    );
  }, []);

  /**
   * Change or delete one task. It shows at once; the save waits for any
   * earlier save to the same task, so answers come back in the order they were
   * sent and the last one is the task's real state. On failure, only this
   * change is undone — the task goes back to what the store last confirmed,
   * plus any changes still queued — and the user is told which change failed.
   * Never touches other tasks, and throws so a caller (the sort) can stop.
   */
  const writeOp = useCallback(
    (task: Task, patch: TaskPatch | null, failure: string, { quiet = false } = {}) => {
      const id = task.id;
      let ledger = ledgers.current.get(id);
      if (!ledger || ledger.pending.length === 0) {
        // Nothing in flight: start from the task as it is on screen now.
        ledger = {
          confirmed: task,
          confirmedAt: ledger?.confirmedAt ?? 0,
          pending: [],
          tail: ledger?.tail ?? Promise.resolve(),
          index: ledger?.index ?? 0,
        };
        ledgers.current.set(id, ledger);
      }
      const at = tasksRef.current?.findIndex((t) => t.id === id) ?? -1;
      if (at >= 0) ledger.index = at;
      const op = { seq: ++writeCounter.current, patch };
      ledger.pending.push(op);
      publish(id);

      const entry = ledger;
      const run = entry.tail.then(async () => {
        try {
          if (patch === null) {
            await repo.archiveTask(id);
            entry.confirmed = null;
          } else {
            entry.confirmed = await repo.updateTask(id, patch);
          }
          entry.confirmedAt = Date.now();
          entry.pending = entry.pending.filter((p) => p !== op);
          publish(id);
          savedOk();
          return entry.confirmed;
        } catch (e) {
          entry.pending = entry.pending.filter((p) => p !== op);
          publish(id);
          if (!quiet) setWriteError({ text: `${failure}: ${describeError(e)}`, add: false });
          throw e;
        }
      });
      entry.tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [repo, publish, savedOk],
  );

  const counts = useMemo(() => (now && tasks ? countTasks(tasks, now) : null), [tasks, now]);

  /** Settling tasks keep their old place in the view they were tapped in. */
  const shown = useMemo(() => {
    if (!tasks || settling.size === 0) return tasks;
    return tasks.map((t) => {
      const held = settling.get(t.id);
      return held && held.view === view ? held.copy : t;
    });
  }, [tasks, settling, view]);
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
        ledgers.current.set(task.id, {
          confirmed: task,
          confirmedAt: Date.now(),
          pending: [],
          tail: Promise.resolve(),
          index: 0,
        });
        publish(task.id);
        setLastCapture({ task, signal });
        setSortNote(null);
        setWriteError((current) => (current?.add ? null : current));
        savedOk();
        return task;
      } catch (e) {
        setWriteError({
          // The answer may be what was lost: then the task is saved, and Add would duplicate it.
          text: e instanceof UnconfirmedSaveError
            ? e.message
            : `Could not save the task: ${describeError(e)} Your text is still in the box — tap Add to try again.`,
          add: true,
        });
        return null;
      } finally {
        setCreating(false);
      }
    },
    [repo, publish, savedOk],
  );

  /** (Re)start the quiet period after which settling cards move to their new place. */
  const shiftedAt = useRef(0);
  const holdSettling = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      shiftedAt.current = Date.now();
      setSettling(new Map());
    }, SETTLE_MS);
  }, []);
  /** Was the list just rearranged under the user's finger? */
  const justShifted = () => Date.now() - shiftedAt.current < SHIFT_GUARD_MS;
  const settlingRef = useRef(settling);
  settlingRef.current = settling;

  const toggle = useCallback(
    async (task: Task) => {
      if (justShifted()) return;
      // The card may hold an older copy; act on the task as it is now.
      const live = tasksRef.current?.find((t) => t.id === task.id) ?? task;
      const next = live.status === 'Done' ? 'Todo' : 'Done';
      const undo = settlingRef.current.has(live.id);
      setSettling((current) => {
        const copy = new Map(current);
        // A second tap undoes the first: the card is back where it belongs.
        if (undo) copy.delete(live.id);
        else copy.set(live.id, { copy: live, view: viewRef.current });
        return copy;
      });
      holdSettling();
      const verb = next === 'Done' ? 'complete' : 'reopen';
      try {
        await writeOp(live, { status: next }, `Could not ${verb} “${live.title}”`);
      } catch {
        // writeOp put the task back and said why.
      }
    },
    [holdSettling, writeOp],
  );

  const remove = useCallback(
    async (task: Task) => {
      if (justShifted()) return;
      try {
        await writeOp(task, null, `Could not delete “${task.title}”`);
      } catch {
        // writeOp put the task back and said why.
      }
    },
    [writeOp],
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
  // in Notion — so they appear in the picker and Gemini is offered them too, in
  // the spelling the tasks use.
  useEffect(() => {
    if (!tasks) return;
    const learned = learnCategories(customCategories, tasks);
    if (learned) onCustomCategoriesChange(learned);
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
        await writeOp(live, { category }, `Could not move “${live.title}” to ${category}`);
      } catch {
        // writeOp put the task back and said why.
      }
    },
    [allCategories, customCategories, onCustomCategoriesChange, writeOp],
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
        async (task, category) => {
          const saved = await writeOp(task, { category }, 'Sort', { quiet: true });
          if (!saved) throw new Error('That task no longer exists.');
          return saved;
        },
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
          ? `${moved}${skipped} Stopped early: ${outcome.stoppedReason} Run it again to continue.`
          : placed < outcome.total
            ? `${moved}${skipped} Gemini could not place the rest — they are genuinely ambiguous.`
            : `${moved}${skipped}`,
      );
    } finally {
      if (sortAbort.current === controller) sortAbort.current = null;
      setSorting(null);
    }
  }, [classify, writeOp]);

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
          <span>{writeError.text}</span>
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
        // Any touch on the list while cards are settling restarts their wait,
        // so the list never shifts under a finger that is about to tap.
        <div onPointerDownCapture={() => settlingRef.current.size > 0 && holdSettling()}>
          {result.groups.map((group) => (
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
          ))}
        </div>
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
    // Gemini was meant to find the date too. Say so when none was read: a
    // Hebrew "מחר" left in the title is easy to miss.
    body = (
      <>
        Gemini failed, so keyword rules filed this under <strong>{signal.category}</strong>
        {due ?? ', and no date was read'}. {signal.fallbackReason}
      </>
    );
  } else if (signal.category === 'Inbox' && !aiEnabled && !rulesCanRead(title)) {
    // Only for text the English keyword lists cannot read at all; English that
    // simply matched nothing gets the plain note below.
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
