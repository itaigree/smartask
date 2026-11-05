/**
 * Where the Notion credentials live now that there is no server.
 *
 * PLAN.md decision 1 (revised): the token is kept in this browser's local
 * storage, on the user's own device. It is never committed and never built into
 * the bundle. Local storage is scoped to the origin, so on a shared origin like
 * `*.github.io` any other site under that domain can read it — the connect
 * screen says so, and a custom domain is the fix.
 */

export interface NotionConfig {
  token: string;
  databaseId: string;
}

const STORAGE_KEY = 'smartask.notion.v1';

/** Accepts a bare id or any Notion URL containing one; returns a dashed uuid. */
export function normalizeDatabaseId(raw: string): string | null {
  const hex = String(raw ?? '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!hex) return null;
  const s = hex[0].toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A token is not validated here — only Notion can do that — but obvious pastes of the wrong thing are caught. */
export function validateToken(raw: string): string | null {
  const token = String(raw ?? '').trim();
  if (!token) return null;
  if (/\s/.test(token)) return null;
  return token;
}

/**
 * Local storage throws in some privacy modes and can be disabled entirely, so
 * every access is guarded: a failure means "not configured", never a crash.
 */
export function loadConfig(): NotionConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NotionConfig>;
    if (!parsed?.token || !parsed?.databaseId) return null;
    return { token: parsed.token, databaseId: parsed.databaseId };
  } catch {
    return null;
  }
}

/** Returns false when storage is unavailable, so the UI can say so honestly. */
export function saveConfig(config: NotionConfig): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function clearConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do; the caller is already discarding the session.
  }
}

/** For display only — never render the whole token. */
export function maskToken(token: string): string {
  if (token.length <= 10) return '••••';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
