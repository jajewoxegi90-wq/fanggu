/* =====================================================================
   访古 · Service Worker
   ---------------------------------------------------------------------
   目的：装到手机桌面后，断网也能打开（地图瓦片除外）。
   策略：
     · 打开页面：先联网拿最新的，失败再用缓存
     · css/js/图标：先用缓存（快），同时后台更新
     · 地图瓦片等第三方请求：不拦，直接走网络
   改了 app.js / style.css 之后，把下面的版本号 +1，用户下次打开就会更新。
   ===================================================================== */

const VERSION = 'fanggu-v3';
const SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './manifest.json',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/leaflet.markercluster.js',
  './vendor/MarkerCluster.css',
  './font/weibei-title.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 瓦片等外部资源不插手

  // 页面导航：网络优先，离线回退到缓存的首页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
