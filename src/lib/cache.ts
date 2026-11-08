/**
 * A tiny TTL cache for Notion reads.
 *
 * PLAN.md decision 2: Notion is the source of truth, so this is a read
 * optimisation only and every write clears it. It lives in module scope, which
 * means one cache per server instance — correct for a single-user app, and
 * harmless if a serverless platform gives us several cold instances.
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/**
 * Bumped by every write. A read that was already in flight when a write
 * happened returns its (now outdated) result to its caller, but must not
 * store it: the next read would serve the pre-write list for 20 seconds.
 */
let epoch = 0;

export const DEFAULT_TTL_MS = 20_000;

/** Return the cached value, or compute, store and return a fresh one. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const startedIn = epoch;
  const value = await compute();
  if (epoch === startedIn) store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Drop everything. Called after any write so the next read is authoritative. */
export function invalidate(): void {
  epoch += 1;
  store.clear();
}

export function cacheSize(): number {
  return store.size;
}
