/**
 * Allow an action at most once per `minIntervalMs`. Returns true when the
 * caller may go ahead, and records that it did.
 *
 * Used for re-reading Notion when the user switches back to the app: on a
 * phone, focus and visibility events arrive in bursts, and each one is not
 * worth a Notion request.
 */
export function createThrottle(
  minIntervalMs: number,
  clock: () => number = () => Date.now(),
): () => boolean {
  let last = -Infinity;
  return () => {
    const now = clock();
    if (now - last < minIntervalMs) return false;
    last = now;
    return true;
  };
}
