'use client';

import { useEffect, useState } from 'react';
import {
  clearGeminiConfig, maskToken, saveGeminiConfig, validateApiKey,
  type GeminiConfig,
} from '../lib/config.ts';
import {
  classifyWithGemini, listGeminiModels, modelChoices, pickDefaultModel, type GeminiModel,
} from '../lib/categorize/gemini.ts';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

/**
 * Turns Gemini classification on or off.
 *
 * Model ids move faster than any hardcoded default lasts, so the list comes
 * from Google using the user's own key. That request doubles as the check that
 * the key works, which is why there is no "save and hope" path here.
 */
export default function AiSettings({
  config,
  onChange,
  onClose,
}: {
  config: GeminiConfig | null;
  onChange: (next: GeminiConfig | null) => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const busy = status.kind === 'busy';
  /** For the key-restriction advice; this panel only ever renders in the browser. */
  const site = typeof window === 'undefined' ? null : window.location.origin;

  async function connect(event: React.FormEvent) {
    event.preventDefault();

    const key = validateApiKey(apiKey);
    if (!key) {
      setStatus({ kind: 'error', message: 'That does not look like a Google AI Studio API key.' });
      return;
    }

    setStatus({ kind: 'busy', label: 'Checking the key…' });
    try {
      const available = await listGeminiModels(key);
      const model = pickDefaultModel(available);
      if (!model) {
        setStatus({
          kind: 'error',
          message: 'The key works, but no usable text model is available to it.',
        });
        return;
      }

      if (!saveGeminiConfig({ apiKey: key, model })) {
        setStatus({ kind: 'error', message: 'This browser will not let the app save the key.' });
        return;
      }

      setModels(available);
      setApiKey('');
      onChange({ apiKey: key, model });
      setStatus({ kind: 'ok', message: `Connected. Using ${model}.` });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Failed.' });
    }
  }

  async function test() {
    if (!config) return;
    setStatus({ kind: 'busy', label: 'Asking Gemini…' });
    try {
      const sample = 'לשלם חשבון חשמל מחר';
      const signal = await classifyWithGemini(config, { title: sample, now: new Date() });
      const due = signal.extracted?.due ? `, due ${signal.extracted.due}` : ', no date found';
      setStatus({
        kind: 'ok',
        message: `Test task "${sample}" → ${signal.category}${due} — ${signal.reason}.`,
      });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Failed.' });
    }
  }

  async function loadModels() {
    if (!config || models.length) return;
    try {
      setModels(await listGeminiModels(config.apiKey));
    } catch {
      // The dropdown just stays as the single current value.
    }
  }

  // Read the list as soon as the panel opens, so a saved model Google no
  // longer offers — a retired one — shows as unavailable straight away. The
  // error message for that model sends people here to pick another.
  const savedKey = config?.apiKey;
  useEffect(() => {
    // Only when the key changes; loadModels itself skips a list already read.
    if (savedKey) void loadModels();
  }, [savedKey]);

  const choices = config ? modelChoices(models, config.model) : [];
  const unavailable = choices.some((m) => m.unavailable);

  function chooseModel(model: string) {
    if (!config) return;
    const next = { ...config, model };
    if (saveGeminiConfig(next)) {
      onChange(next);
      setStatus({ kind: 'ok', message: `Now using ${model}.` });
    }
  }

  function disconnect() {
    clearGeminiConfig();
    onChange(null);
    setModels([]);
    setStatus({ kind: 'idle' });
  }

  return (
    <div className="setup">
      <div className="panel-head">
        <h2>AI classification</h2>
        <button type="button" className="icon-button" onClick={onClose}>
          done
        </button>
      </div>

      <p>
        Without this, categories come from keyword rules — fast, free, and sometimes wrong. With a
        Google AI Studio key, Gemini reads the whole task and decides. Dates, priority,{' '}
        <code>#project</code> and <code>@tag</code> are still parsed on your device either way.
      </p>

      {config ? (
        <>
          <dl className="kv">
            <dt>Key</dt>
            <dd>{maskToken(config.apiKey)}</dd>
            <dt>Model</dt>
            <dd>
              <select
                value={config.model}
                onFocus={loadModels}
                onChange={(e) => chooseModel(e.target.value)}
                disabled={busy}
                aria-describedby={unavailable ? 'model-unavailable' : undefined}
              >
                {choices.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.unavailable}>
                    {m.unavailable ? m.label : m.id}
                  </option>
                ))}
              </select>
            </dd>
          </dl>
          {unavailable && (
            <p className="field-hint" id="model-unavailable">
              Google no longer offers {config.model} to your key. Pick another model.
            </p>
          )}

          <div className="button-row">
            <button type="button" className="primary-button" onClick={test} disabled={busy}>
              {busy ? status.label : 'Test it'}
            </button>
            <button type="button" className="icon-button" onClick={disconnect} disabled={busy}>
              Remove key
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={connect} className="connect-form">
          <label htmlFor="gemini-key">Google AI Studio API key</label>
          <input
            id="gemini-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="AIza…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <p className="field-hint">
            Free from{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>
            . No card needed for the free tier.
          </p>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? status.label : 'Connect Gemini'}
          </button>
        </form>
      )}

      {status.kind === 'ok' && <p className="note ok">{status.message}</p>}
      {status.kind === 'error' && (
        <p className="note bad" role="alert">
          {status.message}
        </p>
      )}

      <div className="disclosure">
        <h3>Where this key is kept</h3>
        <p>
          In this browser, exactly like the Notion token — never committed, never in the
          app&rsquo;s code, sent only to Google.
        </p>
        <p>
          A key in a web page can be read by anything running on this domain. Google lets you
          limit a key to one website: in{' '}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
          >
            Google Cloud credentials
          </a>
          , choose the <strong>Websites</strong> restriction and add{' '}
          {site ? <code>{site}/*</code> : <>this site&rsquo;s address followed by <code>/*</code></>}
          . Use the address, not this page&rsquo;s full path: the browser sends Google only the
          address, so a path never matches. Other websites then cannot use a copied key, but
          someone outside a browser still could, so keep it to yourself.
        </p>
      </div>
    </div>
  );
}
