// Veritus Mobility service worker: makes the app installable and keeps the app shell available offline.
// API calls always go to the network (money data is never served from cache).
const SHELL = "veritus-shell-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/m", "/icon-192.png"])).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate" && url.pathname.startsWith("/m")) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put("/m", copy)); return r; }).catch(() => caches.match("/m")));
  }
});
