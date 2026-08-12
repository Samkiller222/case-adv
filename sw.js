/* Case Register service worker.
 *
 * Two jobs:
 * 1. Cache pdf.js (the CDN script + its worker) so PDF text extraction keeps
 *    working even if that CDN is blocked or flaky — the exact failure mode
 *    that used to take down the whole page (see app.js's lazy pdfjsLib
 *    setup). Cache-first: these are a pinned, versioned URL that won't
 *    change under us.
 * 2. Cache the app shell (index.html, app.js, manifest) so the page still
 *    loads offline. Network-first: always prefer a fresh copy when online,
 *    only falling back to the cached one when the network fails — so a
 *    code update is picked up on the very next online load instead of
 *    users getting stuck on a stale cached version.
 *
 * Bump CACHE_VERSION whenever app.js/index.html change in a way that must
 * reach already-installed users promptly — it forces the old cache to be
 * dropped on activate.
 */
const CACHE_VERSION = "v2";
const SHELL_CACHE = `case-register-shell-${CACHE_VERSION}`;
const CDN_CACHE = `case-register-cdn-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
];
const CDN_ASSETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      caches.open(CDN_CACHE).then((cache) =>
        Promise.all(
          CDN_ASSETS.map((url) =>
            fetch(url, { mode: "cors" })
              .then((resp) => resp.ok && cache.put(url, resp))
              .catch(() => {}) // offline at install time — fine, extraction just needs network on first use
          )
        )
      ),
    ])
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE && name !== CDN_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept anything but plain GETs — extraction/findings calls are
  // POSTs to Gemini or a home server and must always go straight to network.
  if (req.method !== "GET") return;

  if (CDN_ASSETS.includes(req.url)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((resp) => {
            const copy = resp.clone();
            caches.open(CDN_CACHE).then((cache) => cache.put(req, copy));
            return resp;
          })
      )
    );
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave any other cross-origin request alone

  event.respondWith(
    // no-store bypasses the browser's ordinary HTTP cache — otherwise a
    // sub-resource fetched here can be served straight out of that cache
    // (respecting its Cache-Control/max-age) without ever reaching the
    // network, which quietly defeats "network-first" and is exactly how a
    // deployed fix can still show stale behavior after a manual reload.
    fetch(req, { cache: "no-store" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        return resp;
      })
      .catch(() => caches.match(req))
  );
});
