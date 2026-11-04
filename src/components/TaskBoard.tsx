'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task } from '../lib/types.ts';
import { buildView, countTasks, type ViewId } from '../lib/views.ts';
import QuickAdd from './QuickAdd.tsx';
import TaskCard from './TaskCard.tsx';
import ViewTabs from './ViewTabs.tsx';

/**
 * Holds the task list client-side so an edit feels instant, and re-reads from
 * Notion after every write (Notion stays the source of truth, PLAN.md
 * decision 2 — the local array is only ever a copy of what came back).
 */
export default function TaskBoard({ initialTasks }: { initialTasks: Task[] }) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [view, setView] = useState<ViewId>('focus');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Views depend on the local date, which the server does not know. Render them
   * only after mount so the user's timezone decides what "today" means, and so
   * server and client markup never disagree.
   */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(() => (now ? countTasks(tasks, now) : null), [tasks, now]);
  const result = useMemo(() => (now ? buildView(view, tasks, now) : null), [view, tasks, now]);

  const request = useCallback(async (input: string, init?: RequestInit) => {
    const response = await fetch(input, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
    return body;
  }, []);

  const create = useCallback(
    async (text: string): Promise<Task | null> => {
      setCreating(true);
      setError(null);
      try {
        const { task } = await request('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({ text, now: new Date().toISOString() }),
        });
        setTasks((current) => [task as Task, ...current]);
        return task as Task;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save that task.');
        return null;
      } finally {
        setCreating(false);
      }
    },
    [request],
  );

  const toggle = useCallback(
    async (task: Task) => {
      const next = task.status === 'Done' ? 'Todo' : 'Done';
      const previous = tasks;
      // Optimistic: the tick should respond instantly, Notion catches up.
      setTasks((current) =>
        current.map((t) => (t.id === task.id ? { ...t, status: next } : t)),
      );
      try {
        const { task: saved } = await request(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        setTasks((current) => current.map((t) => (t.id === task.id ? (saved as Task) : t)));
        setError(null);
      } catch (e) {
        setTasks(previous);
        setError(e instanceof Error ? e.message : 'Could not update that task.');
      }
    },
    [request, tasks],
  );

  const remove = useCallback(
    async (task: Task) => {
      const previous = tasks;
      setTasks((current) => current.filter((t) => t.id !== task.id));
      try {
        await request(`/api/tasks/${task.id}`, { method: 'DELETE' });
        setError(null);
      } catch (e) {
        setTasks(previous);
        setError(e instanceof Error ? e.message : 'Could not delete that task.');
      }
    },
    [request, tasks],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const { tasks: fresh } = await request('/api/tasks?fresh=1');
      setTasks(fresh as Task[]);
      setNow(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach Notion.');
    } finally {
      setRefreshing(false);
    }
  }, [request]);

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
          </div>
        </div>
      </header>

      <QuickAdd onCreate={create} busy={creating} />

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" onClick={() => setError(null)}>
            dismiss
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
