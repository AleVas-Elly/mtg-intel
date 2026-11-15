// App notifications (spec D88). Kept out of the build so its address never changes. It caches
// nothing: the app loads as before; this file only shows pings and opens the page they point to.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let ping = {};
  try { ping = event.data ? event.data.json() : {}; } catch { ping = { body: event.data ? event.data.text() : "" }; }
  if (typeof ping.badge === "number" && self.navigator.setAppBadge) self.navigator.setAppBadge(ping.badge).catch(() => {});
  // iPhone requires every push to show a notification, so there is always a title.
  event.waitUntil(self.registration.showNotification(ping.title || "mtg-intel", {
    body: ping.body || "",
    tag: ping.tag || undefined,
    renotify: !!ping.tag,
    silent: !!ping.silent,
    icon: "/icon-192.png?v=65",
    badge: "/icon-64.png?v=65",
    data: { url: ping.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) { await tab.focus(); return tab.navigate(url).catch(() => tab.postMessage({ open: url })); }
    return self.clients.openWindow(url);
  })());
});
