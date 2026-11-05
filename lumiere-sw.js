/* Lumiere service worker - caching layer
 * Put this file NEXT TO index.html (same folder, site root). index.html already registers "./lumiere-sw.js".
 * To force every visitor to refresh caches after a big update, bump VERSION.
 */
const VERSION = "v1";
const SHELL_CACHE = "lum-shell-" + VERSION;      // index.html, manifest, icons
const STATIC_CACHE = "lum-static-" + VERSION;    // fonts, CDN libs (versioned URLs)
const GITHUB_CACHE = "lum-github-" + VERSION;    // raw.githubusercontent.com + github.io files (templates, images)
const MEDIA_CACHE = "lum-media-" + VERSION;      // images / audio / video thumbnails
const ALL_CACHES = [SHELL_CACHE, STATIC_CACHE, GITHUB_CACHE, MEDIA_CACHE];

// Max entries per cache (oldest removed first) - keeps storage under control with thousands of files
const LIMITS = {};
LIMITS[GITHUB_CACHE] = 600;
LIMITS[MEDIA_CACHE] = 400;
LIMITS[STATIC_CACHE] = 120;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;     // media/static: 30 days before forced refresh
const HTML_REVALIDATE_MS = 10 * 60 * 1000;       // html/json from GitHub: refresh in background after 10 min

const SHELL_URLS = ["./", "./index.html", "./manifest.webmanifest", "./lumiere-icon-192.png"];

const STATIC_HOSTS = [
  "fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com",
  "cdnjs.cloudflare.com", "www.gstatic.com"
];
const GITHUB_HOSTS = ["raw.githubusercontent.com", "lumierecompany07.github.io"];

// Never touch: auth, database, payments, analytics, messaging
const BYPASS_HOSTS = [
  "firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com",
  "firebaseinstallations.googleapis.com", "firebase.googleapis.com", "www.googleapis.com",
  "www.payhere.lk", "sandbox.payhere.lk", "wa.me", "t.me", "www.facebook.com",
  "www.youtube.com", "www.google-analytics.com", "www.googletagmanager.com"
];

const IMG_RE = /\.(?:png|jpe?g|webp|avif|gif|svg|ico)(?:$|\?)/i;
const MEDIA_RE = /\.(?:mp3|m4a|ogg|wav|mp4|webm)(?:$|\?)/i;
const FONT_RE = /\.(?:woff2?|ttf|otf)(?:$|\?)/i;
const CODE_RE = /\.(?:js|css|json|webmanifest)(?:$|\?)/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL_URLS.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf("lum-") === 0 && ALL_CACHES.indexOf(k) < 0).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const d = event.data;
  if (d === "SKIP_WAITING" || (d && d.type === "SKIP_WAITING")) self.skipWaiting();
  if (d && d.type === "CLEAR_CACHES") {
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.indexOf("lum-") === 0).map((k) => caches.delete(k)))));
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  // Respect explicit "always fresh" requests made by the app itself
  if (req.cache === "no-store" || req.cache === "reload") return;
  // Video / audio seeking uses Range requests - let the browser handle them
  if (req.headers.has("range")) return;
  if (BYPASS_HOSTS.indexOf(url.hostname) >= 0) return;
  // Firebase SDK files are versioned (/firebasejs/x.y.z/), everything else on gstatic is also static
  const sameOrigin = url.origin === self.location.origin;

  // 1) Page navigation -> network first (fast timeout), fall back to cached page / offline
  if (req.mode === "navigate" && sameOrigin) {
    event.respondWith(networkFirst(req, SHELL_CACHE, 3500, "./index.html"));
    return;
  }

  // 2) Same-origin files
  if (sameOrigin) {
    if (url.pathname.endsWith("/lumiere-sw.js")) return;
    if (IMG_RE.test(url.pathname) || FONT_RE.test(url.pathname) || MEDIA_RE.test(url.pathname)) {
      event.respondWith(cacheFirst(req, MEDIA_CACHE, MAX_AGE_MS));
    } else {
      event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    }
    return;
  }

  // 3) CDN libraries + fonts (URLs contain versions) -> cache first
  if (STATIC_HOSTS.indexOf(url.hostname) >= 0) {
    // fonts.googleapis.com css can change by user-agent, still safe to SWR
    if (url.hostname === "fonts.googleapis.com") event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    else event.respondWith(cacheFirst(req, STATIC_CACHE, MAX_AGE_MS));
    return;
  }

  // 4) GitHub-hosted template files
  if (GITHUB_HOSTS.indexOf(url.hostname) >= 0) {
    if (IMG_RE.test(url.pathname) || MEDIA_RE.test(url.pathname) || FONT_RE.test(url.pathname)) {
      // images / media rarely change under the same URL -> cache first, 30 days
      event.respondWith(cacheFirst(req, GITHUB_CACHE, MAX_AGE_MS));
    } else if (req.cache === "no-cache") {
      event.respondWith(networkFirst(req, GITHUB_CACHE, 5000));
    } else {
      // html / js / css / json -> instant from cache, refresh in background
      event.respondWith(staleWhileRevalidate(req, GITHUB_CACHE, HTML_REVALIDATE_MS));
    }
    return;
  }

  // 5) Any other cross-origin image -> cache first (opaque allowed)
  if (req.destination === "image") {
    event.respondWith(cacheFirst(req, MEDIA_CACHE, MAX_AGE_MS));
  }
});

/* ---------- helpers ---------- */

function cacheable(res) {
  return res && (res.status === 200 || res.type === "opaque");
}

// Store with a timestamp header so we can expire entries
async function put(cacheName, req, res) {
  try {
    const cache = await caches.open(cacheName);
    let toStore = res.clone();
    if (res.type === "basic" || res.type === "cors") {
      const headers = new Headers(res.headers);
      headers.set("x-lum-cached-at", String(Date.now()));
      const body = await res.clone().blob();
      toStore = new Response(body, { status: res.status, statusText: res.statusText, headers });
    }
    await cache.put(req, toStore);
    trim(cacheName);
  } catch (e) { /* quota or opaque issues - ignore */ }
}

function age(res) {
  const t = Number(res && res.headers && res.headers.get("x-lum-cached-at"));
  return t ? Date.now() - t : 0; // opaque/unknown -> treat as fresh
}

let trimming = {};
async function trim(cacheName) {
  const max = LIMITS[cacheName];
  if (!max || trimming[cacheName]) return;
  trimming[cacheName] = true;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // oldest first
  } catch (e) {}
  trimming[cacheName] = false;
}

async function cacheFirst(req, cacheName, maxAge) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit && age(hit) < maxAge) return hit;
  try {
    const res = await fetch(req);
    if (cacheable(res)) put(cacheName, req, res.clone());
    return res;
  } catch (e) {
    if (hit) return hit; // offline -> stale copy is better than nothing
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName, revalidateAfter) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = () => fetch(req).then((res) => { if (cacheable(res)) put(cacheName, req, res.clone()); return res; });
  if (hit) {
    // Always return the cached copy instantly; refresh in background when old enough
    if (!revalidateAfter || age(hit) > revalidateAfter) update().catch(() => {});
    return hit;
  }
  return update();
}

async function networkFirst(req, cacheName, timeoutMs, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });
    if (cacheable(res)) put(cacheName, req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req)) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (hit) return hit;
    throw e;
  }
}
