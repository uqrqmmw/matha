/* 數A特訓 PWA service worker
   策略：network-first（連得上就拿最新版，改版即時生效）、斷網退回快取（離線也能開）。
   只碰同源 GET；Supabase/OpenAI 代理等跨域請求一律直通不快取。 */
// CacheStorage 以「origin」共用，不以 service-worker scope 隔離。
// 只清本 app 自己的 prefix，避免部署在同一 GitHub Pages origin 的其他 PWA 快取被誤刪。
const CACHE_PREFIX = 'matha-v';
const CACHE = CACHE_PREFIX + '36';
// 全部同源（KaTeX/Supabase 皆已自架，無 CDN）→ 真離線可用。
const SHELL = ['./', 'index.html', 'style.css', 'bank.js', 'practice-bank.js?v=0717a', 'app.js?v=0717a', 'vendor/supabase.js', 'vendor/katex/katex.min.css', 'vendor/katex/katex.min.js', 'vendor/katex/auto-render.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const KATEX_FONTS = [
  'KaTeX_AMS-Regular', 'KaTeX_Caligraphic-Bold', 'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold', 'KaTeX_Fraktur-Regular', 'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic', 'KaTeX_Main-Italic', 'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic', 'KaTeX_Math-Italic', 'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic', 'KaTeX_SansSerif-Regular', 'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular', 'KaTeX_Size2-Regular', 'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular', 'KaTeX_Typewriter-Regular',
].map((name) => `vendor/katex/fonts/${name}.woff2`);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (cache) => {
    await cache.addAll(SHELL);
    // 字型採逐檔容錯，既不讓單檔問題破壞安裝，也確保第一次開公式前就能完整離線。
    await Promise.all(KATEX_FONTS.map(async (url) => {
      try { const response = await fetch(url, { cache: 'no-cache' }); if (response.ok) await cache.put(url, response); } catch (_) {}
    }));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NET_TIMEOUT = 3500; // 弱網/lie-fi 保底：連得上但無吞吐時，逾時就先回快取，別白屏等瀏覽器的數十秒長逾時
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // 跨域直通
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: 'no-cache' }) // network-first：繞過瀏覽器 HTTP 快取，改版即拿最新
      .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => undefined); // 網路失敗＝undefined，交給下面回快取（不 reject，避免 race 中斷）
    if (!cached) { // 沒快取只能等網路（首次載入）；導覽失敗退回 index.html 外殼
      const r = await net;
      return r || (e.request.mode === 'navigate' ? (await caches.match('index.html')) : Response.error());
    }
    // 有快取：network-first 但加逾時——網路快就用最新、慢/斷就秒回快取（net 仍在背景更新快取）
    const r = await Promise.race([net, new Promise((res) => setTimeout(() => res(undefined), NET_TIMEOUT))]);
    return r || cached;
  })());
});
