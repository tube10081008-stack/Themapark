/* ============================================================
   봉플레이 서비스 워커 (Service Worker - BP-006)
   ------------------------------------------------------------
   오프라인 정적 파일 캐싱 & 네트워크 단절 시 안정적 화면 서빙
   ============================================================ */
const CACHE_NAME = 'bongplay-static-v2026-01';
const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  './pages/consent.html',
  './pages/consent-desk.html',
  './pages/gate.html',
  './pages/operations.html',
  './pages/safety-check.html',
  './pages/closing.html',
  './pages/management.html',
  './pages/archive.html',
  './pages/booking.html',
  './pages/emergency.html',
  './pages/simulator.html',
  './pages/metaverse.html',
  './pages/master.html',
  './assets/config.js',
  './assets/bongplay-sync.js',
  './assets/bongplay-id.js',
  './assets/bongplay-notify.js',
  './assets/bongplay-wakelock.js',
  './assets/print.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Service worker pre-cache partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 및 외부 동적 요청은 서비스워커 캐시 패스 (BongplaySync가 IndexedDB로 처리)
  if (url.origin.includes('supabase.co') || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/api/')) {
    return;
  }

  // 정적 리소스: Cache First -> Network Fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // 백그라운드 캐시 갱신
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 완전 오프라인일 때 기본 페이지 응답
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
