import { archiveTask, updateTask } from '../../../../lib/tasks.ts';
import { ValidationError } from '../../../../lib/capture.ts';
import { errorResponse, json } from '../../../../lib/http.ts';
import { isCategory, isPriority, isStatus, type TaskPatch } from '../../../../lib/types.ts';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/tasks/:id — change only the fields present in the body. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const { id } = await context.params;
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ValidationError('Request body must be JSON.');
    }

    const patch: TaskPatch = {};

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        throw new ValidationError('Title must be a non-empty string.');
      }
      patch.title = body.title.trim();
    }
    if (body.category !== undefined) {
      if (!isCategory(body.category)) throw new ValidationError('Unknown category.');
      patch.category = body.category;
    }
    if (body.priority !== undefined) {
      if (!isPriority(body.priority)) throw new ValidationError('Unknown priority.');
      patch.priority = body.priority;
    }
    if (body.status !== undefined) {
      if (!isStatus(body.status)) throw new ValidationError('Unknown status.');
      patch.status = body.status;
    }
    if (body.due !== undefined) {
      if (body.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.due))) {
        throw new ValidationError('Due must be YYYY-MM-DD or null.');
      }
      patch.due = body.due === null ? null : String(body.due);
    }
    if (body.project !== undefined) {
      patch.project = body.project === null ? null : String(body.project);
    }
    if (body.note !== undefined) {
      patch.note = body.note === null ? null : String(body.note);
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) throw new ValidationError('Tags must be an array.');
      patch.tags = body.tags.filter((t: unknown): t is string => typeof t === 'string');
    }

    const task = await updateTask(id, patch);
    return json({ task });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/tasks/:id — moves the Notion page to the trash, recoverable. */
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { id } = await context.params;
    await archiveTask(id);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
