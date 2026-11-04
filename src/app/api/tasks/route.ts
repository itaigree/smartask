import { captureTask, createTask, listTasks } from '../../../lib/tasks.ts';
import { ValidationError } from '../../../lib/capture.ts';
import { errorResponse, json } from '../../../lib/http.ts';
import { isCategory, isPriority, isStatus } from '../../../lib/types.ts';

export const dynamic = 'force-dynamic';

/** GET /api/tasks — every task. `?fresh=1` bypasses the cache. */
export async function GET(request: Request): Promise<Response> {
  try {
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    const tasks = await listTasks({ fresh });
    return json({ tasks });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/tasks
 *
 * `{ "text": "pay rent friday !! #home" }` captures and categorizes free text.
 * `now` (client ISO datetime) makes "tomorrow" mean the user's tomorrow rather
 * than the server's. A full task object is also accepted for explicit creates.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request);

    if (typeof body.text === 'string') {
      const now = parseNow(body.now);
      const task = await captureTask(body.text, now);
      return json({ task }, 201);
    }

    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (!title) throw new ValidationError('Title cannot be empty.');

      const task = await createTask({
        title,
        category: isCategory(body.category) ? body.category : 'Inbox',
        priority: isPriority(body.priority) ? body.priority : 'Normal',
        status: isStatus(body.status) ? body.status : 'Todo',
        due: typeof body.due === 'string' && body.due ? body.due : null,
        project: typeof body.project === 'string' && body.project ? body.project : null,
        tags: Array.isArray(body.tags)
          ? body.tags.filter((t: unknown): t is string => typeof t === 'string')
          : [],
        note: typeof body.note === 'string' && body.note ? body.note : null,
      });
      return json({ task }, 201);
    }

    throw new ValidationError('Send either { text } or { title, ... }.');
  } catch (error) {
    return errorResponse(error);
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new ValidationError('Request body must be JSON.');
  }
}

/** Trust the client's clock for relative dates, but only if it is plausible. */
function parseNow(value: unknown): Date {
  if (typeof value !== 'string') return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  const driftDays = Math.abs(parsed.getTime() - Date.now()) / 86_400_000;
  return driftDays <= 2 ? parsed : new Date();
}
