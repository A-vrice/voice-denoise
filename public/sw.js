// VoiceDenoise Service Worker v2
// Cache strategies per spec:
//   WASM/Model binaries -> Cache-First
//   JS/CSS assets -> Stale-While-Revalidate
//   index.html -> Network-First

var CACHE_NAME = "voice-denoise-v2";
var MODEL_CACHE = "voice-denoise-models-v2";

var PRECACHE_ASSETS = ["/", "/manifest.json"];
var MODEL_URLS = [
  "/models/silero_vad.onnx",
  "/wasm/ort-wasm-simd-threaded.wasm",
  "/wasm/ort-wasm-simd-threaded.mjs",
  "/wasm/dfn3.wasm",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.addAll(PRECACHE_ASSETS);
      }),
      caches.open(MODEL_CACHE).then(function (cache) {
        // モデルは個別失敗を許容（dev 環境で未配置でも install は成功させる）
        return Promise.all(
          MODEL_URLS.map(function (url) {
            return cache.add(url).catch(function (err) {
              console.warn("[sw] precache failed:", url, err);
            });
          })
        );
      }),
    ])
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k !== CACHE_NAME && k !== MODEL_CACHE;
          })
          .map(function (k) {
            return caches.delete(k);
          })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  var path = url.pathname;

  if (MODEL_URLS.some(function (m) { return path === m; })) {
    event.respondWith(cacheFirst(event.request, MODEL_CACHE));
    return;
  }

  if (path === "/" || path === "/index.html") {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (path.match(/\.(js|css|wasm|json|png|svg|ico)$/)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok) {
        caches.open(cacheName || CACHE_NAME).then(function (cache) {
          cache.put(request, response.clone());
        });
      }
      return response;
    }).catch(function () {
      return new Response("Offline", { status: 503 });
    });
  });
}

function staleWhileRevalidate(request) {
  var cachePromise = caches.open(CACHE_NAME);
  return cachePromise.then(function (cache) {
    return cache.match(request).then(function (cached) {
      var fetchPromise = fetch(request).then(function (response) {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
      return cached || fetchPromise.catch(function () {
        return new Response("Offline", { status: 503 });
      });
    });
  });
}

function networkFirst(request) {
  return fetch(request).then(function (response) {
    if (response.ok) {
      caches.open(CACHE_NAME).then(function (cache) {
        cache.put(request, response.clone());
      });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      return cached || new Response("Offline", { status: 503 });
    });
  });
}
