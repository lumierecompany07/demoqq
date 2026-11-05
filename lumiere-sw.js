/* template-sw.js - drop this file in the ROOT of each template repo (next to its index.html).
 * Register it from the template's index.html (see snippet in the instructions).
 * Effect: images, css, js, fonts, audio/video thumbs and the page itself are served from the
 * visitor's local cache after the first visit, so reopening a template is near-instant.
 * Bump VERSION after you publish a big template update to force everyone to refresh.
 */
const VERSION = "v1";
const SCOPE_KEY = new URL(self.registration.scope).pathname.replace(/\W+/g, "_"); // one cache per repo
const CACHE = "tpl" + SCOPE_KEY + VERSION;
const MAX_ENTRIES = 250;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days for assets

// third-party hosts that are safe to cache (versioned libs / fonts)
const CDN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "cdn.tailwindcss.com"];

self.addEventListener("install", (e) => { e.waitUntil(self.skipWaiting()); });

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.indexOf("tpl" + SCOPE_KEY) === 0 && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  if (req.cache === "no-store" || req.cache === "reload") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && CDN_HOSTS.indexOf(url.hostname) < 0 && req.destination !== "image") return;
  if (sameOrigin && url.pathname.indexOf(new URL(self.registration.scope).pathname) !== 0) return; // other repos on same github.io
  if (sameOrigin && url.pathname.endsWith("/template-sw.js")) return;

  const isPage = req.mode === "navigate" || req.destination === "document";
  event.respondWith(isPage ? staleWhileRevalidate(req) : cacheFirst(req));
});

function ok(res) { return res && (res.status === 200 || res.type === "opaque"); }

async function store(req, res) {
  try {
    const cache = await caches.open(CACHE);
    let copy = res.clone();
    if (res.type === "basic" || res.type === "cors") {
      const h = new Headers(res.headers);
      h.set("x-tpl-cached-at", String(Date.now()));
      copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers: h });
    }
    await cache.put(req, copy);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
  } catch (_) {}
}

function age(res) {
  const t = Number(res.headers && res.headers.get("x-tpl-cached-at"));
  return t ? Date.now() - t : 0;
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit && age(hit) < MAX_AGE) return hit;
  try {
    const res = await fetch(req);
    if (ok(res)) store(req, res.clone());
    return res;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

// page: show the cached copy instantly, refresh it in the background for the next visit
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => { if (ok(res)) store(req, res.clone()); return res; });
  if (hit) { update.catch(() => {}); return hit; }
  return update;
}
