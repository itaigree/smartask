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
  const hex = String(raw ?? '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!hex) return null;
  const s = hex[0];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
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
