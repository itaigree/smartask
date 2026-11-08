'use client';

import { useRef, useState } from 'react';
import { exportBackup, importBackup, LocalStoreError } from '../lib/local-store.ts';
import { toISODate } from '../lib/parse.ts';

/**
 * The safety net for phone-only mode. These tasks exist in one browser on one
 * device; clearing site data or losing the phone loses them. A backup file is
 * the only copy that survives that, so it sits right under the board.
 */
export default function LocalBackup({ onRestored }: { onRestored: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  function download() {
    const json = exportBackup();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartask-backup-${toISODate(new Date())}.json`; // the local day, not UTC
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNote({ ok: true, text: 'Backup downloaded. Keep it somewhere other than this phone.' });
  }

  async function restore(file: File) {
    try {
      const { added, skipped } = importBackup(await file.text());
      setNote({
        ok: true,
        text: `Restored ${added} ${added === 1 ? 'task' : 'tasks'}${
          skipped ? ` (${skipped} already here)` : ''
        }.`,
      });
      onRestored();
    } catch (error) {
      setNote({
        ok: false,
        text: error instanceof LocalStoreError ? error.message : 'Could not read that file.',
      });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="local-footer">
      <p className="footer">
        Saved on this device only ·{' '}
        <button type="button" className="link-button" onClick={download}>
          Back up
        </button>{' '}
        ·{' '}
        <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
          Restore
        </button>
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void restore(file);
        }}
      />
      {note && <p className={`note ${note.ok ? 'ok' : 'bad'}`}>{note.text}</p>}
    </div>
  );
}
