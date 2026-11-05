// GradeIQ service worker — makes the app installable (PWA) and gives a fast,
// offline-tolerant shell. Deliberately conservative: NEVER cache API responses
// or camera/session data — those must always hit the network.
// Bump the version on deploys that change chunk styling/behavior — activate()
// deletes every older cache, so clients can't keep serving stale JS/CSS.
const CACHE = "gradeiq-v32";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Dynamic / private → network only, never cached.
  if (url.pathname.includes("/api/") || url.pathname.includes("/uploads/")) return;

  // Pages: network-first (fall back to any cached shell when offline).
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cached = await caches.match(req);
          return cached || (await caches.match("/")) || Response.error();
        }
      })()
    );
    return;
  }

  // Static assets: cache-first, then populate.
  if (["script", "style", "image", "font"].includes(req.destination)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const net = await fetch(req);
          if (net.ok) {
            const c = await caches.open(CACHE);
            c.put(req, net.clone());
          }
          return net;
        } catch {
          return cached || Response.error();
        }
      })()
    );
  }
});
