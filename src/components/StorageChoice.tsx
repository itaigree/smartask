'use client';

import { useState } from 'react';
import { deviceStorageWorks } from '../lib/local-store.ts';

/**
 * First launch: where should tasks live? Shown only when nothing is set up —
 * anyone already connected to Notion goes straight to their board and never
 * sees this.
 */
export default function StorageChoice({
  localTaskCount,
  onLocal,
  onNotion,
}: {
  /** Tasks already saved on this device, e.g. from an earlier local session. */
  localTaskCount: number;
  onLocal: () => void;
  onNotion: () => void;
}) {
  const [blocked, setBlocked] = useState(false);

  function chooseLocal() {
    // With site data blocked, phone-only mode could not keep a single task —
    // nor remember that it was chosen, so it would land back here on every
    // launch. Say so instead.
    if (!deviceStorageWorks()) {
      setBlocked(true);
      return;
    }
    onLocal();
  }

  return (
    <div className="setup">
      <h2>Where should your tasks live?</h2>
      <p>You can change this later. Gemini sorting and voice input work with either.</p>

      <div className="choices">
        <button type="button" className="choice" onClick={chooseLocal}>
          <span className="choice-icon" aria-hidden="true">📱</span>
          <span className="choice-body">
            <strong>On this phone only</strong>
            <span>Nothing to set up. Tasks are saved in this browser, on this device.</span>
            {localTaskCount > 0 && (
              <span className="choice-note">
                {localTaskCount} {localTaskCount === 1 ? 'task is' : 'tasks are'} already saved
                here.
              </span>
            )}
          </span>
        </button>

        <button type="button" className="choice" onClick={onNotion}>
          <span className="choice-icon" aria-hidden="true">🗂️</span>
          <span className="choice-body">
            <strong>Sync with Notion</strong>
            <span>
              Tasks go into a Notion database you own — see and edit them on any device. Needs a
              free Notion account.
            </span>
          </span>
        </button>
      </div>

      {blocked && (
        <p className="note bad" role="alert">
          This browser will not let the app save anything, so tasks cannot be kept on this
          phone. Allow cookies and site data for this site, or leave private browsing.
        </p>
      )}
    </div>
  );
}
