/* ============================================================
   봉플레이 서비스 워커 (Service Worker - BP-006)
   ------------------------------------------------------------
   오프라인 정적 파일 캐싱 & 네트워크 단절 시 안정적 화면 서빙
   ============================================================ */
const CACHE_NAME = 'bongplay-static-v2026-09-18r2';
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

// 실시간 데이터 출처: 절대 캐시하지 않음 (캐시하면 같은 URL 의 예전 기상·DB 응답이 계속 반환됨)
const LIVE_DATA_HOSTS = ['supabase.co', 'api.open-meteo.com', 'script.google.com', 'script.googleusercontent.com'];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) GET 이 아니거나 실시간 데이터·API 요청 → 서비스워커 개입 없음
  if (req.method !== 'GET' ||
      LIVE_DATA_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h)) ||
      url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/.netlify/')) {
    return;
  }

  // 2) 자체 파일(HTML·JS·CSS): Network First → 오프라인일 때만 캐시
  //    안전 인터록 로직이 바뀌어도 온라인 기기는 즉시 최신 코드를 받습니다.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return networkResponse;
      }).catch(() =>
        caches.match(req).then((cached) =>
          cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
        )
      )
    );
    return;
  }

  // 3) 외부 CDN 라이브러리(버전 고정 파일): Cache First → Network Fallback
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
