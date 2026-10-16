// 離線快取：一律先拿網路上的最新版（每日更新），沒網路時才用快取
const V = "v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest", "data/products.json"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
