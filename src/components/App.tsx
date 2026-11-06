'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  clearConfig, loadConfig, loadGeminiConfig,
  type GeminiConfig, type NotionConfig,
} from '../lib/config.ts';
import { getCategorizer } from '../lib/categorize/index.ts';
import { classifyWithGemini, createGeminiCategorizer } from '../lib/categorize/gemini.ts';
import { createTaskRepository } from '../lib/tasks.ts';
import AiSettings from './AiSettings.tsx';
import ConnectForm from './ConnectForm.tsx';
import TaskBoard from './TaskBoard.tsx';

/**
 * Top of the client-only app. Decides between the connect screen and the board,
 * and owns the single place credentials are read or dropped.
 */
export default function App() {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [gemini, setGemini] = useState<GeminiConfig | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [ready, setReady] = useState(false);

  // Local storage is not available while the page is being prerendered at build
  // time, so the config is read after mount. `ready` keeps the connect form from
  // flashing in front of someone who is already connected.
  useEffect(() => {
    setConfig(loadConfig());
    setGemini(loadGeminiConfig());
    setReady(true);
  }, []);

  /**
   * Gemini classifies when a key is present, and the keyword rules stand behind
   * it: a failed request must never stop a task being saved.
   */
  const categorizer = useMemo(
    () =>
      gemini
        ? createGeminiCategorizer(gemini, getCategorizer())
        : getCategorizer(),
    [gemini],
  );

  /** For re-sorting Inbox: must throw on failure, never fall back to the rules. */
  const classify = useMemo(
    () => (gemini ? (input: Parameters<typeof classifyWithGemini>[1]) => classifyWithGemini(gemini, input) : null),
    [gemini],
  );

  const repo = useMemo(
    () => (config ? createTaskRepository(config, categorizer) : null),
    [config, categorizer],
  );

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

  if (showAi) {
    return (
      <>
        <Masthead />
        <AiSettings
          config={gemini}
          onChange={setGemini}
          onClose={() => setShowAi(false)}
        />
      </>
    );
  }

  return (
    <>
      <TaskBoard
        repo={repo}
        config={config}
        aiEnabled={Boolean(gemini)}
        classify={classify}
        onDisconnect={disconnect}
        onOpenAi={() => setShowAi(true)}
      />
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
