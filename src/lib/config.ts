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
const GEMINI_KEY = 'smartask.gemini.v1';
const STORAGE_MODE_KEY = 'smartask.storage.v1';

/** Accepts a bare id or any Notion URL containing one; returns a dashed uuid. */
export function normalizeDatabaseId(raw: string): string | null {
  return findNotionId(String(raw ?? ''));
}

/**
 * The 32-hex id in a bare id or a Notion link, dashed.
 *
 * Links look like `/Title-Words-<id>?v=<view id>`. The id is the last one in
 * the path that does not touch another hex character, with or without dashes.
 * (Stripping every dash first glued a title ending in a-f or 0-9 — "Home",
 * "DB", "2026" — onto the id and produced a wrong one.) The query string is
 * only searched when the path has no id, because `?v=` holds a view id.
 */
export function findNotionId(text: string): string | null {
  const ID = /(?<![0-9a-f])([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/gi;
  const trimmed = text.trim();
  const path = trimmed.split(/[?#]/)[0];
  for (const where of [path, trimmed]) {
    const matches = [...where.matchAll(ID)];
    const last = matches[matches.length - 1];
    if (last) return last.slice(1, 6).join('-').toLowerCase();
  }
  return null;
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

/**
 * A link to the user's tasks database in Notion. notion.so resolves any page or
 * database by its id, and on a phone with Notion installed it opens the app.
 */
export function notionDatabaseUrl(databaseId: string): string {
  return `https://www.notion.so/${databaseId.replace(/-/g, '')}`;
}

/** For display only — never render the whole token. */
export function maskToken(token: string): string {
  if (token.length <= 10) return '••••';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * Gemini (optional)
 * ------------------------------------------------------------------ */

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

/**
 * Kept under its own storage key so turning the AI off, or a corrupt value,
 * can never cost someone their Notion connection.
 */
export function loadGeminiConfig(): GeminiConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(GEMINI_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GeminiConfig>;
    if (!parsed?.apiKey || !parsed?.model) return null;
    return { apiKey: parsed.apiKey, model: parsed.model };
  } catch {
    return null;
  }
}

export function saveGeminiConfig(config: GeminiConfig): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(GEMINI_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function clearGeminiConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(GEMINI_KEY);
  } catch {
    // Nothing useful to do.
  }
}

/** Google AI Studio keys have no fixed prefix, so only obvious mis-pastes are caught. */
export function validateApiKey(raw: string): string | null {
  const key = String(raw ?? '').trim();
  if (!key || /\s/.test(key) || key.length < 20) return null;
  return key;
}

/* ------------------------------------------------------------------ *
 * Storage mode
 * ------------------------------------------------------------------ */

/**
 * Which store the app uses:
 *
 * - Notion credentials saved     -> Notion. Checked first, so anyone already
 *   connected keeps exactly the app they had; this flag never overrides them.
 * - this flag says 'local'       -> tasks kept on this device only.
 * - neither                      -> first launch: ask.
 */
export type StorageMode = 'notion' | 'local';

export function resolveStorageMode(
  notion: NotionConfig | null,
  localChosen: boolean,
): StorageMode | null {
  if (notion) return 'notion';
  if (localChosen) return 'local';
  return null;
}

export function loadLocalChosen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_MODE_KEY) === 'local';
  } catch {
    return false;
  }
}

export function setLocalChosen(chosen: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (chosen) window.localStorage.setItem(STORAGE_MODE_KEY, 'local');
    else window.localStorage.removeItem(STORAGE_MODE_KEY);
  } catch {
    // Without storage the app simply asks again next launch.
  }
}
