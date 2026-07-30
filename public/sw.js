const CACHE_NAME = "java2dex-shell-v1";
const APP_SHELL = [
  "/",
  "/convert",
  "/history",
  "/help",
  "/css/style.css",
  "/js/nav.js",
  "/js/history.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never touch non-GET requests (file uploads, /convert POST, /convert-share, etc.)
  if (req.method !== "GET") return;

  // Never cache the API — always go to network for anything under /api or /health
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  if (req.mode === "navigate") {
    // Pages: network-first so edits show up immediately, cached shell as offline fallback
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Static assets: cache-first, refresh in background
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
