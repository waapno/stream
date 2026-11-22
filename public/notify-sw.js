// Shows chat notifications when the app is in the background; tap opens the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs[0];
    return c ? c.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
