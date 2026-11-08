import { clearGeminiConfig, loadGeminiConfig } from './config.ts';
import { loadCustomCategories, saveCustomCategories } from './categories.ts';

/**
 * ⏻ is how someone cleans up a shared device. Leaving a store forgets only
 * that store's own settings (and never deletes a task), but two things are
 * kept for the whole device, whichever store is in use: the Gemini key and the
 * custom category names. Left behind, they pass to whoever uses the app next —
 * their tasks are sent to Gemini on this key, and these names show in their
 * category list and in the Gemini prompt. So ⏻ offers to forget them too.
 */

export interface LeftBehind {
  geminiKey: boolean;
  customCategories: number;
}

/** What is still saved on this device after leaving a store. */
export function leftBehind(): LeftBehind {
  return {
    geminiKey: loadGeminiConfig() !== null,
    customCategories: loadCustomCategories().length,
  };
}

/**
 * The question to ask after leaving, or null when there is nothing else to
 * forget. `keptTasks` is set when leaving phone-only mode, whose tasks stay on
 * the device whatever the answer.
 */
export function forgetQuestion(left: LeftBehind, keptTasks = false): string | null {
  const things: string[] = [];
  if (left.geminiKey) things.push('the Gemini key');
  if (left.customCategories === 1) things.push('your custom category');
  if (left.customCategories > 1) things.push(`your ${left.customCategories} custom categories`);
  if (things.length === 0) return null;

  return (
    `Also forget ${things.join(' and ')} on this device?\n\n` +
    'Do this on a shared device. Cancel keeps them for next time.' +
    (keptTasks ? ' Your phone-only tasks stay either way.' : '')
  );
}

/**
 * The text of a task that was still saving when the app closed (QuickAdd puts
 * it back in the box next time). It belongs to whoever is leaving: neither the
 * next person nor the other store should be offered it.
 */
export function forgetPendingDraft(): void {
  try {
    window.localStorage.removeItem('smartask.pending.v1');
  } catch {
    // Storage blocked: there is nothing saved to forget.
  }
}

/** Forget the Gemini key and the custom category names. Never touches tasks. */
export function forgetDeviceSettings(): void {
  clearGeminiConfig();
  saveCustomCategories([]);
}
