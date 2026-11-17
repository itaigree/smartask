/*
 * SmartTask's service worker. It exists for one thing: reminders.
 *
 * Android only lets a web app show a notification through a service worker,
 * and a tap on a notification is delivered here. There is deliberately no
 * `fetch` handler: this worker caches nothing and never answers a request, so
 * it can never serve a stale copy of the app.
 *
 * It cannot fire reminders on its own — the browser stops an idle worker
 * within seconds — so the page does the timing (see src/lib/notify.ts).
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A tap on a reminder brings the app to the front, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Only this app's own windows. Every window of the origin is listed, and
      // on a shared one (<user>.github.io) that includes other sites: the tap
      // brought one of those to the front instead of SmartTask.
      const scope = self.registration.scope;
      for (const client of windows) {
        if (client.url.startsWith(scope) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
