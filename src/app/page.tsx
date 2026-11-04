import { isConfigured, listTasks } from '../lib/tasks.ts';
import SetupNotice from '../components/SetupNotice.tsx';
import TaskBoard from '../components/TaskBoard.tsx';
import type { Task } from '../lib/types.ts';

/** Tasks are read per request; a stale board is worse than a slow one. */
export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!isConfigured()) {
    return (
      <>
        <Masthead />
        <SetupNotice />
      </>
    );
  }

  let tasks: Task[] = [];
  let error: string | null = null;

  try {
    tasks = await listTasks();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not reach Notion.';
  }

  if (error) {
    return (
      <>
        <Masthead />
        <SetupNotice reason={`Notion is configured, but the read failed: ${error}`} />
      </>
    );
  }

  return (
    <>
      <TaskBoard initialTasks={tasks} />
      <p className="footer">Every task lives in your Notion database.</p>
    </>
  );
}

function Masthead() {
  return (
    <header className="header">
      <div className="header-row">
        <h1 className="brand">
          Smart<span>Task</span>
        </h1>
      </div>
    </header>
  );
}
