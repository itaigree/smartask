'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotionConfig } from '../lib/config.ts';
import { maskToken } from '../lib/config.ts';
import { describeNotionError } from '../lib/notion.ts';
import type { TaskRepository } from '../lib/tasks.ts';
import type { Task } from '../lib/types.ts';
import { buildView, countTasks, type ViewId } from '../lib/views.ts';
import QuickAdd from './QuickAdd.tsx';
import TaskCard from './TaskCard.tsx';
import ViewTabs from './ViewTabs.tsx';

/**
 * Holds the task list client-side so an edit feels instant, and writes straight
 * to Notion, which stays the source of truth (PLAN.md decision 2 — the local
 * array is only ever a copy of what came back).
 */
export default function TaskBoard({
  repo,
  config,
  onDisconnect,
}: {
  repo: TaskRepository;
  config: NotionConfig;
  onDisconnect: () => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [view, setView] = useState<ViewId>('focus');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
        const task = await repo.captureTask(text);
        setTasks((current) => [task, ...(current ?? [])]);
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNow(new Date());
    await load(true);
    setRefreshing(false);
  }, [load]);

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

      <QuickAdd onCreate={create} busy={creating} />

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
