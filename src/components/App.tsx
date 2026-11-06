'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  clearConfig, loadConfig, loadGeminiConfig, loadLocalChosen, resolveStorageMode,
  setLocalChosen,
  type GeminiConfig, type NotionConfig,
} from '../lib/config.ts';
import { getCategorizer } from '../lib/categorize/index.ts';
import { classifyWithGemini, createGeminiCategorizer } from '../lib/categorize/gemini.ts';
import {
  countLocalTasks, createLocalRepository, requestPersistentStorage,
} from '../lib/local-store.ts';
import { createTaskRepository } from '../lib/tasks.ts';
import AiSettings from './AiSettings.tsx';
import ConnectForm from './ConnectForm.tsx';
import LocalBackup from './LocalBackup.tsx';
import StorageChoice from './StorageChoice.tsx';
import TaskBoard from './TaskBoard.tsx';

/**
 * Top of the client-only app. Decides which store holds the tasks — Notion or
 * this device — and owns the single place credentials are read or dropped.
 *
 * Saved Notion credentials always win (see resolveStorageMode), so anyone who
 * connected Notion before phone-only mode existed sees no change at all.
 */
export default function App() {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [localChosen, setLocalChosenState] = useState(false);
  const [gemini, setGemini] = useState<GeminiConfig | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  /** Bumped after a restore so the board re-reads local storage. */
  const [revision, setRevision] = useState(0);

  // Local storage is not available while the page is being prerendered at build
  // time, so everything is read after mount. `ready` keeps the first-launch
  // screen from flashing in front of someone who is already set up.
  useEffect(() => {
    setConfig(loadConfig());
    setLocalChosenState(loadLocalChosen());
    setGemini(loadGeminiConfig());
    setReady(true);
  }, []);

  const mode = resolveStorageMode(config, localChosen);

  // Phone-only tasks are only as safe as the browser's storage; ask it not to
  // evict them. Android grants this readily for an installed app.
  useEffect(() => {
    if (mode === 'local') void requestPersistentStorage();
  }, [mode]);

  /**
   * Gemini classifies when a key is present, and the keyword rules stand behind
   * it: a failed request must never stop a task being saved.
   */
  const categorizer = useMemo(
    () => (gemini ? createGeminiCategorizer(gemini, getCategorizer()) : getCategorizer()),
    [gemini],
  );

  /** For re-sorting Inbox: must throw on failure, never fall back to the rules. */
  const classify = useMemo(
    () =>
      gemini
        ? (input: Parameters<typeof classifyWithGemini>[1]) => classifyWithGemini(gemini, input)
        : null,
    [gemini],
  );

  const repo = useMemo(() => {
    if (mode === 'notion' && config) return createTaskRepository(config, categorizer);
    if (mode === 'local') return createLocalRepository(categorizer);
    return null;
    // `revision` is a deliberate extra dependency: a restore bumps it so a fresh
    // repository is built and the board reloads what was restored.
  }, [mode, config, categorizer, revision]);

  function chooseLocal() {
    setLocalChosen(true);
    setLocalChosenState(true);
  }

  function connectedNotion(next: NotionConfig) {
    // Choosing Notion replaces phone-only mode as the active store. Local tasks
    // are not deleted — they stay on the device and reappear if phone-only is
    // chosen again.
    setLocalChosen(false);
    setLocalChosenState(false);
    setConnecting(false);
    setConfig(next);
  }

  /** Leave the current store and return to the first-launch choice. Deletes no tasks. */
  function leave() {
    if (mode === 'notion') {
      clearConfig();
      setConfig(null);
    } else {
      setLocalChosen(false);
      setLocalChosenState(false);
    }
  }

  if (!ready) {
    return (
      <div aria-hidden="true" style={{ paddingTop: 32 }}>
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  if (!mode || !repo) {
    return (
      <>
        <Masthead />
        {connecting ? (
          <ConnectForm onConnected={connectedNotion} onBack={() => setConnecting(false)} />
        ) : (
          <StorageChoice
            localTaskCount={countLocalTasks()}
            onLocal={chooseLocal}
            onNotion={() => setConnecting(true)}
          />
        )}
      </>
    );
  }

  if (showAi) {
    return (
      <>
        <Masthead />
        <AiSettings config={gemini} onChange={setGemini} onClose={() => setShowAi(false)} />
      </>
    );
  }

  return (
    <>
      <TaskBoard
        repo={repo}
        storage={mode === 'notion' && config ? { kind: 'notion', token: config.token } : { kind: 'local' }}
        aiEnabled={Boolean(gemini)}
        classify={classify}
        onLeave={leave}
        onOpenAi={() => setShowAi(true)}
      />
      {mode === 'notion' ? (
        <p className="footer">Every task lives in your own Notion database.</p>
      ) : (
        <LocalBackup onRestored={() => setRevision((r) => r + 1)} />
      )}
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
