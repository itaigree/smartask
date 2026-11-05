'use client';

import { useEffect, useMemo, useState } from 'react';
import { clearConfig, loadConfig, type NotionConfig } from '../lib/config.ts';
import { createTaskRepository } from '../lib/tasks.ts';
import ConnectForm from './ConnectForm.tsx';
import TaskBoard from './TaskBoard.tsx';

/**
 * Top of the client-only app. Decides between the connect screen and the board,
 * and owns the single place credentials are read or dropped.
 */
export default function App() {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [ready, setReady] = useState(false);

  // Local storage is not available while the page is being prerendered at build
  // time, so the config is read after mount. `ready` keeps the connect form from
  // flashing in front of someone who is already connected.
  useEffect(() => {
    setConfig(loadConfig());
    setReady(true);
  }, []);

  const repo = useMemo(() => (config ? createTaskRepository(config) : null), [config]);

  function disconnect() {
    clearConfig();
    setConfig(null);
  }

  if (!ready) {
    return (
      <div aria-hidden="true" style={{ paddingTop: 32 }}>
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  if (!config || !repo) {
    return (
      <>
        <Masthead />
        <ConnectForm onConnected={setConfig} />
      </>
    );
  }

  return (
    <>
      <TaskBoard repo={repo} config={config} onDisconnect={disconnect} />
      <p className="footer">Every task lives in your own Notion database.</p>
    </>
  );
}

export function Masthead() {
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
