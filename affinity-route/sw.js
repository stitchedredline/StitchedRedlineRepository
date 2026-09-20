/* Cache-first so the app opens instantly in a dead stairwell.
   Bump CACHE when you change any file, or phones keep the old copy. */
var CACHE = 'affinity-route-v1';
var FILES = [
  'index.html', 'out.html', 'setup.html', 'qr.html', 'history.html',
  'app.css', 'config.js', 'icon.svg', 'manifest.webmanifest',
  'js/store.js', 'js/route.js', 'js/app.js', 'js/setup.js', 'js/qr.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (f) {
      return c.add(f).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  /* Never cache the Apps Script endpoint — stale scan data is worse than none. */
  if (e.request.method !== 'GET' || url.hostname.indexOf('script.google') > -1) return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res.ok && url.origin === location.origin) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return caches.match('index.html'); });
    })
  );
});
