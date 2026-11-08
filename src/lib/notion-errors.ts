/**
 * What a failed Notion call means to the person using the app. No SDK import,
 * so it stays directly testable; notion.ts re-exports it.
 */

/** A task's page is gone from Notion, while the database itself is still there. */
export class TaskGoneError extends Error {
  constructor() {
    super('That task no longer exists in Notion. Tap ↻ to refresh the list.');
    this.name = 'TaskGoneError';
  }
}

/**
 * Saving a new task failed in a way that may have come after Notion saved it:
 * the connection dropped or timed out mid-request. Adding it again blindly
 * could make a duplicate, so the person is asked to check first.
 */
export class UnconfirmedSaveError extends Error {
  constructor() {
    super(
      'The connection dropped while saving, so the task may be in Notion already. ' +
        'Tap ↻ to check before adding it again. Your text is still in the box.',
    );
    this.name = 'UnconfirmedSaveError';
  }
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

export function notionErrorCode(error: unknown): string | undefined {
  const code = (error as ErrorLike | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  const message = (error as ErrorLike | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/**
 * The browser refused to put the token in a header — it holds a character
 * outside Latin-1 — so no request left at all. Chrome says "non ISO-8859-1
 * code point", Firefox "ByteString".
 */
function isUnsendableHeader(error: unknown): boolean {
  return (error as ErrorLike | null)?.name === 'TypeError'
    && /ISO-8859-1|ByteString|header/i.test(messageOf(error));
}

/**
 * fetch() rejects with a TypeError when no answer came back: "Failed to fetch"
 * (Chrome), "NetworkError when attempting to fetch resource." (Firefox),
 * "Load failed" (Safari). Anything else is not a connection problem, and
 * saying it was sent people to check a connection that was fine.
 */
function isNetworkFailure(error: unknown): boolean {
  return (error as ErrorLike | null)?.name === 'TypeError'
    && !isUnsendableHeader(error)
    && /fetch|network|load failed/i.test(messageOf(error));
}

/**
 * Whether a failed create may still have reached Notion. A dropped connection
 * or a timeout can come after the save, so the answer was lost rather than the
 * request. If the device was already offline before sending, nothing left.
 */
export function mayHaveSaved(error: unknown, offlineBefore: boolean): boolean {
  const code = notionErrorCode(error);
  if (code === 'notionhq_client_request_timeout' || code === 'gateway_timeout') return true;
  return !offlineBefore && isNetworkFailure(error);
}

/**
 * Turn whatever the SDK threw into something worth showing a person.
 * A network failure and a rejected token are different problems.
 */
export function describeNotionError(error: unknown): string {
  const message = messageOf(error);

  if ((error as ErrorLike | null)?.name === 'BrowserTokenNotAllowedError') {
    return 'The Notion client refused to use a token in the browser. This is a bug in the app, not your setup.';
  }

  switch (notionErrorCode(error)) {
    case 'unauthorized':
      return 'Notion rejected the token. Check you pasted the Internal Integration Secret in full.';
    case 'restricted_resource':
      // Notion answers "not found", not this, for a database that was never
      // shared; this one means the integration lacks a capability.
      return 'Your Notion integration is not allowed to do that. At notion.so/my-integrations, ' +
        'open it and turn on Read, Update and Insert content under Capabilities.';
    case 'object_not_found':
      // A task's own page that is gone arrives as TaskGoneError instead.
      return 'Notion cannot find that database. Open it in Notion, then ••• → Connections, and add your integration.';
    case 'rate_limited':
      return 'Notion is rate limiting (about 3 requests a second). Wait a moment and try again.';
    case 'validation_error':
      return `Notion rejected the data: ${message}`;
    case 'notionhq_client_request_timeout':
      return 'Notion did not answer in time. Check your connection and try again.';
    default:
      break;
  }

  if (isUnsendableHeader(error)) {
    return 'The saved token contains a character that cannot be sent. Tap ⏻ and paste the token again.';
  }
  if (isNetworkFailure(error)) {
    return 'Could not reach Notion. Check your connection and try again.';
  }
  return message;
}
