/**
 * The browser side of reminders: permission, and showing a notification.
 *
 * What this can and cannot do is fixed by the app having no server (PLAN.md
 * decision 6b). A closed web app is only woken by a push from a server, so
 * a notification is shown by the page itself, when a reminder comes due while
 * the app is open or still alive in the background. Anything that came due
 * while it was closed is shown the moment it opens.
 *
 * Every call here is guarded: notifications are an extra, and a browser that
 * lacks or refuses them must cost nothing but the notification.
 */

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

/** Must match next.config.mjs: a project site lives under /<repo>. */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Where this browser stands on notifications from the app. */
export function notifyState(): NotifyState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * The service worker Android needs for notifications (public/sw.js).
 * Registered only once reminders are in use; null where there is none.
 */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const scope = `${BASE_PATH}/`;
    return (
      (await navigator.serviceWorker.getRegistration(scope)) ??
      (await navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope }))
    );
  } catch {
    return null;
  }
}

/**
 * Ask to show notifications, if that has not been answered yet. Call it from
 * a tap — browsers ignore the request otherwise. Never throws.
 */
export async function askToNotify(): Promise<NotifyState> {
  const state = notifyState();
  if (state === 'unsupported' || state === 'denied') return state;
  try {
    const answer = state === 'default' ? await Notification.requestPermission() : state;
    if (answer === 'granted') void worker();
    return answer;
  } catch {
    return notifyState();
  }
}

/**
 * Show a reminder as a system notification. Resolves to whether it was shown;
 * false leaves the reminder to the app's own banner.
 */
export async function showReminder(task: { id: string; title: string }): Promise<boolean> {
  if (notifyState() !== 'granted') return false;
  const title = 'Reminder';
  const options: NotificationOptions = {
    body: task.title,
    // One notification per task: a reminder shown twice replaces itself.
    tag: `smartask-reminder-${task.id}`,
    icon: `${BASE_PATH}/icon-192.png`,
    data: { url: `${BASE_PATH}/` },
  };
  try {
    const registration = await worker();
    if (registration) {
      // The worker may still be installing on its very first use. Wait for it,
      // but not for ever: one that never installs must not hang the reminder.
      if (!registration.active) {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      await registration.showNotification(title, options);
      return true;
    }
    // Desktop browsers without a worker; Android refuses this form and throws.
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
