/* Cine Match v4.2 · notificaciones push dentro del service worker (lo importa el SW generado por Workbox). */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'Cine Match', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Cine Match', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // La misma recomendación nunca genera dos notificaciones
    tag: d.tag || undefined,
    data: { url: d.url || './#/recibidas' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './#/recibidas', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        return c.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : w)).catch(() => self.clients.openWindow(url));
      }
    }
    return self.clients.openWindow(url);
  }));
});
