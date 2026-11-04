import type { MetadataRoute } from 'next';

/**
 * Makes the app installable from a phone: "Add to Home Screen" then gives it an
 * icon and opens it without browser chrome, so it behaves like a native app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SmartTask',
    short_name: 'SmartTask',
    description: 'Capture a task in plain language. It files itself in Notion.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f7f7f8',
    theme_color: '#3b5bdb',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
