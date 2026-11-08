'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearConfig, loadConfig, loadGeminiConfig, loadLocalChosen, notionDatabaseUrl, resolveStorageMode,
  setLocalChosen,
  type GeminiConfig, type NotionConfig,
} from '../lib/config.ts';
import { getCategorizer, type Categorizer, type CategorySignal } from '../lib/categorize/index.ts';
import {
  categoryList, loadCustomCategories, saveCustomCategories,
} from '../lib/categories.ts';
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
  const [customCategories, setCustomCategoriesState] = useState<string[]>([]);

  // Categories Gemini has just created are offered straight away, before the
  // saved task comes back and the saved list catches up — so two tasks added
  // in quick succession share one new category instead of inventing two.
  const createdRef = useRef<string[]>([]);

  const setCustomCategories = useCallback((next: string[]) => {
    setCustomCategoriesState(next);
    saveCustomCategories(next);
    // Once a created name is in the saved list, the list owns it: removing it
    // there must remove it for good, not leave it offered from here.
    const saved = new Set(next.map((c) => c.toLowerCase()));
    createdRef.current = createdRef.current.filter((c) => !saved.has(c.toLowerCase()));
  }, []);

  // Gemini reads the category list when it classifies, not when it was set up,
  // so a category created a moment ago is already on offer.
  const categoriesRef = useRef<string[]>([]);
  categoriesRef.current = categoryList(customCategories);

  const offeredCategories = useCallback(
    () => categoryList([...categoriesRef.current, ...createdRef.current]),
    [],
  );
  const rememberCreated = useCallback((signal: CategorySignal) => {
    if (signal.created && !createdRef.current.includes(signal.category)) {
      createdRef.current = [...createdRef.current, signal.category];
    }
    return signal;
  }, []);

  // Local storage is not available while the page is being prerendered at build
  // time, so everything is read after mount. `ready` keeps the first-launch
  // screen from flashing in front of someone who is already set up.
  useEffect(() => {
    setConfig(loadConfig());
    setLocalChosenState(loadLocalChosen());
    setGemini(loadGeminiConfig());
    setCustomCategoriesState(loadCustomCategories());
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
  const categorizer = useMemo((): Categorizer => {
    if (!gemini) return getCategorizer();
    const ai = createGeminiCategorizer(gemini, getCategorizer(), undefined, offeredCategories);
    return {
      name: ai.name,
      categorize: async (input) => rememberCreated(await ai.categorize(input)),
    };
  }, [gemini, offeredCategories, rememberCreated]);

  /** For re-sorting Inbox: must throw on failure, never fall back to the rules. */
  const classify = useMemo(
    () =>
      gemini
        ? async (input: Parameters<typeof classifyWithGemini>[1]) =>
            rememberCreated(await classifyWithGemini(gemini, input, offeredCategories()))
        : null,
    [gemini, offeredCategories, rememberCreated],
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
        storage={
          mode === 'notion' && config
            ? { kind: 'notion', token: config.token, databaseId: config.databaseId }
            : { kind: 'local' }
        }
        aiEnabled={Boolean(gemini)}
        classify={classify}
        onLeave={leave}
        onOpenAi={() => setShowAi(true)}
        customCategories={customCategories}
        onCustomCategoriesChange={setCustomCategories}
      />
      {mode === 'notion' ? (
        <p className="footer">
          Every task lives in your own{' '}
          <a href={config ? notionDatabaseUrl(config.databaseId) : '#'} target="_blank" rel="noreferrer">
            Notion database ↗
          </a>
        </p>
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
