// 건강 측정 ME-rPPG — Service Worker
const CACHE_NAME = 'healthmeas-v24-s06';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // ME-rPPG assets
  './me-rppg/onnxWorker.js',
  './me-rppg/welchWorker.js',
  './me-rppg/model.onnx',
  './me-rppg/welch_psd.onnx',
  './me-rppg/get_hr.onnx',
  './me-rppg/state.json',
  './me-rppg/blaze_face_short_range.tflite',
  './me-rppg/LICENSE',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ★ v23.3: app.js / index.html / sw.js 는 네트워크 우선 (최신 코드 보장)
// 나머지(모델·아이콘 등 대용량 정적자원)는 캐시 우선
function isCodeFile(url) {
  return url.endsWith('/app.js') || url.endsWith('/index.html') ||
         url.endsWith('/') || url.endsWith('/manifest.json');
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  // ★ v24.0: API/관리자 경로는 서비스워커가 가로채지 않음 (항상 네트워크 직접)
  if (url.indexOf('/api/') !== -1 || url.indexOf('/admin') !== -1) {
    return; // 브라우저 기본 fetch
  }

  if (isCodeFile(url)) {
    // 네트워크 우선 → 실패 시 캐시 폴백
    e.respondWith(
      fetch(e.request).then(res => {
        // 최신본을 캐시에 갱신
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(()=>{});
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // 정적 자원 — 캐시 우선
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
