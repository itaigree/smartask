'use client';

import { useEffect, useRef } from 'react';
import { browserBackLayers } from '../lib/back-layers.ts';

/**
 * While `open`, the back gesture calls `close` instead of leaving the app
 * (see back-layers.ts). Closing any other way tidies up after itself.
 */
export function useCloseOnBack(open: boolean, close: () => void) {
  // Read at the time of the back press, so a new `close` on every render
  // neither re-adds the history entry nor goes stale.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    return browserBackLayers().open(() => closeRef.current());
  }, [open]);
}
