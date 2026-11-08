import { readFileSync, existsSync } from 'node:fs';

/**
 * Minimal .env loader so the scripts work with no extra dependencies.
 * Real environment variables always win over file contents.
 */
export function loadEnv(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}

/** Accepts a bare id or any Notion URL containing one; returns a dashed uuid. */
export function normalizeId(raw) {
  // Same rules as findNotionId() in src/lib/config.ts: the last id in the path
  // that does not touch another hex character, so a title ending in a-f or 0-9
  // ("Home", "DB", "2026") is never glued onto it. Kept separate because the
  // scripts run in plain Node without the app's TypeScript.
  const ID = /(?<![0-9a-f])([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/gi;
  const trimmed = String(raw ?? '').trim();
  const path = trimmed.split(/[?#]/)[0];
  for (const where of [path, trimmed]) {
    const matches = [...where.matchAll(ID)];
    const last = matches[matches.length - 1];
    if (last) return last.slice(1, 6).join('-').toLowerCase();
  }
  return null;
}

export const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
export const bad = (msg) => console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
export const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
export const info = (msg) => console.log(`    ${msg}`);

/**
 * A network failure and a rejected token are very different problems, and the
 * SDK surfaces both as a throw. Tell them apart so the advice is not misleading.
 */
export function isNetworkError(error) {
  const message = String(error?.message ?? error);
  return (
    !error?.code ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message)
  );
}

/** A one-line description plus the advice that actually fits the failure. */
export function describeFailure(error) {
  const message = String(error?.message ?? error);

  if (isNetworkError(error)) {
    return {
      summary: 'Could not reach api.notion.com.',
      advice: [
        message,
        'This is a network problem, not an authentication one. Check your connection,',
        'and any VPN, proxy or firewall that might be blocking api.notion.com.',
      ],
    };
  }

  switch (error.code) {
    case 'unauthorized':
      return {
        summary: 'Notion rejected the token.',
        advice: [
          'Check NOTION_TOKEN is the Internal Integration Secret, copied in full.',
          'You can regenerate it in the integration settings.',
        ],
      };
    case 'restricted_resource':
    case 'object_not_found':
      return {
        summary: 'Notion cannot find that page or database.',
        advice: [
          'Either the id is wrong, or the integration was never given access to it.',
          'Open it in Notion, then ••• → Connections → add your integration.',
          'Notion reports a page an integration cannot see as "not found", not "forbidden".',
        ],
      };
    case 'rate_limited':
      return {
        summary: 'Notion is rate limiting (about 3 requests/second).',
        advice: ['Wait a moment and run this again.'],
      };
    default:
      return { summary: `Notion error (${error.code}).`, advice: [message] };
  }
}
