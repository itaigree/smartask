import { readFileSync, existsSync } from 'node:fs';

/**
 * Minimal .env loader so the scripts work with no extra dependencies.
 * Real environment variables always win over file contents.
 */
export function loadEnv(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvText(readFileSync(file, 'utf8')))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

/**
 * The variables in a .env file, read the way people write them: an optional
 * `export ` in front, a `# comment` after an unquoted value, and a value in
 * matching quotes, inside which `#` is kept.
 *
 * A value with an unmatched quote is kept as written, quote included, so the
 * token check can point at it rather than a quote being silently dropped.
 * (Node's own util.parseEnv lets an unmatched quote swallow the lines after it.)
 */
export function parseEnvText(text) {
  const vars = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(rest);
    vars[key] = quoted ? quoted[2] : rest.replace(/(?:^|\s+)#.*$/, '').trim();
  }
  return vars;
}

/**
 * Why a token cannot be right, found before anything is sent — or null.
 *
 * An invisible mark or a curly quote copied along with the token is the usual
 * cause. Node refuses to put such a character in a request header, and the
 * resulting error used to be reported as a network problem.
 */
export function tokenProblem(token) {
  const text = String(token ?? '');
  for (let i = 0; i < text.length; i++) {
    const char = String.fromCodePoint(text.codePointAt(i));
    // A token is plain ASCII: letters, digits and "_" in practice.
    if (/^[\x21-\x7e]$/.test(char) && !`"'\``.includes(char)) continue;

    const code = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    let what;
    if (/\p{Cf}/u.test(char)) what = `an invisible character (${code})`; // RLM, zero-width space, BOM
    else if (/\s/.test(char)) what = 'a space';
    else if (/["'`‘’“”«»׳״]/.test(char)) what = `a quote mark (${char})`;
    else if (/\p{Cc}/u.test(char)) what = `an invisible character (${code})`;
    else what = `"${char}" (${code})`;

    return {
      summary: `NOTION_TOKEN contains ${what} at character ${i + 1}.`,
      advice: [
        'A token is only letters, digits and "_". Copy it again from',
        'https://www.notion.so/my-integrations, with no quotes or spaces around it.',
      ],
    };
  }
  return null;
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

/** Error codes Node gives a connection that never got an answer. */
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
]);

/**
 * A network failure and a rejected token are very different problems, and the
 * SDK surfaces both as a throw. Tell them apart so the advice is not misleading.
 *
 * Only a real sign of the network counts: Node's "fetch failed", a connection
 * error code, or the SDK's timeout. Any other error without a code — a token
 * Node would not send, say — is not blamed on the connection.
 */
export function isNetworkError(error) {
  if (error?.code === 'notionhq_client_request_timeout') return true;
  if (NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code)) return true;
  if (error?.code) return false;
  return /fetch failed|socket hang up/i.test(String(error?.message ?? error));
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

  if (!error?.code) {
    return { summary: 'Unexpected error.', advice: [message] };
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
      // A 403: the integration can see the page but lacks a capability.
      return {
        summary: 'Notion refused: the integration is not allowed to do this.',
        advice: [
          `Notion says: ${message}`,
          'Open https://www.notion.so/my-integrations → your integration → Capabilities,',
          'and turn on Read content, Update content and Insert content.',
        ],
      };
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
