import { NotionNotConfiguredError } from './notion.ts';
import { ValidationError } from './capture.ts';

/** Turn an unknown throw into an HTTP status and a message worth showing. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return json({ error: error.message }, 400);
  }
  if (error instanceof NotionNotConfiguredError) {
    return json({ error: error.message, code: 'not_configured' }, 503);
  }

  const notionError = error as { code?: string; status?: number; message?: string };
  switch (notionError?.code) {
    case 'unauthorized':
      return json({ error: 'Notion rejected the token. Check NOTION_TOKEN.' }, 502);
    case 'object_not_found':
      return json(
        { error: 'Notion cannot find that page or database. Is the integration still connected?' },
        404,
      );
    case 'rate_limited':
      return json({ error: 'Notion is rate limiting. Try again in a moment.' }, 429);
    case 'validation_error':
      return json({ error: `Notion rejected the data: ${notionError.message ?? ''}`.trim() }, 400);
    default:
      break;
  }

  console.error('[smartask] unhandled error', error);
  return json({ error: 'Something went wrong talking to Notion.' }, 500);
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
