'use client';

import { useState } from 'react';
import { normalizeDatabaseId, saveConfig, validateToken, type NotionConfig } from '../lib/config.ts';

/**
 * The first screen. Takes the Notion credentials and keeps them in this
 * browser. It says plainly where they are stored, because the honest answer is
 * "on your device, readable by anything else on this domain".
 */
export default function ConnectForm({ onConnected }: { onConnected: (c: NotionConfig) => void }) {
  const [token, setToken] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();

    const cleanToken = validateToken(token);
    if (!cleanToken) {
      setError('Paste the Internal Integration Secret — it should have no spaces in it.');
      return;
    }

    const cleanId = normalizeDatabaseId(databaseId);
    if (!cleanId) {
      setError('That does not look like a Notion database link or id.');
      return;
    }

    const config = { token: cleanToken, databaseId: cleanId };
    if (!saveConfig(config)) {
      setError(
        'This browser will not let the app save anything. Private browsing mode usually ' +
          'causes this — try a normal window.',
      );
      return;
    }

    setError(null);
    onConnected(config);
  }

  return (
    <div className="setup">
      <h2>Connect your Notion</h2>
      <p>
        SmartTask keeps every task in your own Notion database. Nothing is stored anywhere
        else, and there is no server in between.
      </p>

      <form onSubmit={submit} className="connect-form">
        <label htmlFor="token">Internal Integration Secret</label>
        <input
          id="token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ntn_…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field-hint">
          From{' '}
          <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">
            notion.so/my-integrations
          </a>
          . Open your tasks database in Notion, then <strong>••• → Connections</strong>, and add
          that integration — otherwise it cannot see the database.
        </p>

        <label htmlFor="database">Database link or id</label>
        <input
          id="database"
          type="text"
          value={databaseId}
          onChange={(e) => setDatabaseId(e.target.value)}
          placeholder="https://notion.so/… or 0a8fbd62…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field-hint">Paste the whole link; the id is pulled out of it.</p>

        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary-button">
          Connect
        </button>
      </form>

      <div className="disclosure">
        <h3>Where your token is kept</h3>
        <p>
          In this browser&rsquo;s local storage, on this device only. It is never sent anywhere
          except Notion, and it is not part of the app&rsquo;s code.
        </p>
        <p>
          Local storage belongs to the whole domain, not just this app. On a shared domain such
          as <code>github.io</code>, another site you host there could read it. Use a browser you
          trust, and disconnect below when you are done on a shared device.
        </p>
      </div>
    </div>
  );
}
