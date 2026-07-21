/* 數A特訓 PWA service worker
   策略：network-first（連得上就拿最新版，改版即時生效）、斷網退回快取（離線也能開）。
   只碰同源 GET；Supabase/OpenAI 代理等跨域請求一律直通不快取。 */
// CacheStorage 以「origin」共用，不以 service-worker scope 隔離。
// 只清本 app 自己的 prefix，避免部署在同一 GitHub Pages origin 的其他 PWA 快取被誤刪。
const CACHE_PREFIX = 'matha-v';
// 唯一版本戳：與 app.js 的 APP_VER、index.html 的 ?v= 同一個值（tests/assets.test.js 強制一致）。
// 改版只要動這一個值＋APP_VER＋index.html ?v=，快取名自動跟著換，不會再發生「?v= 升了、CACHE 忘了升」的半新半舊。
const APP_STAMP = '0722e';
const CACHE = CACHE_PREFIX + APP_STAMP;
// 全部同源（KaTeX/Supabase 皆已自架，無 CDN）→ 真離線可用。
// 一律不含 ?v=：SW 快取以「無 query 的 URL」為 key（?v= 只為破瀏覽器 HTTP 快取），
// 同一檔案永遠只有一個條目，不會出現多版本並存時最舊條目先命中的問題。
const SHELL = ['./', 'index.html', 'style.css', 'bank.js', 'practice-bank.js', 'app.js', 'vendor/supabase.js', 'vendor/katex/katex.min.css', 'vendor/katex/katex.min.js', 'vendor/katex/auto-render.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
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
    // no-cache：預快取也要繞過瀏覽器 HTTP 快取（GitHub Pages max-age=600），首裝不能裝到 10 分鐘前的舊檔。
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'no-cache' })));
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
    url.search = '';
    const key = url.href; // 快取 key 一律去 query：讀寫同 key，永遠單一條目（見 SHELL 註解）
    const cache = await caches.open(CACHE); // 只查本版自己的快取：不掃 origin 上全部 cache，跨版/跨 app 的同名條目不得命中
    const cached = await cache.match(key);
    const net = fetch(e.request, { cache: 'no-cache' }) // network-first：繞過瀏覽器 HTTP 快取，改版即拿最新
      .then((res) => { if (res && res.ok) cache.put(key, res.clone()); return res; })
      .catch(() => undefined); // 網路失敗＝undefined，交給下面回快取（不 reject，避免 race 中斷）
    if (!cached) { // 沒快取只能等網路（首次載入）；導覽失敗退回 index.html 外殼
      const r = await net;
      if (r && r.ok) return r;
      if (e.request.mode === 'navigate') return (await cache.match('index.html')) || r || Response.error();
      return r || Response.error();
    }
    // 有快取：network-first 但加逾時——網路快就用最新、慢/斷就秒回快取（net 仍在背景更新快取）
    const r = await Promise.race([net, new Promise((res) => setTimeout(() => res(undefined), NET_TIMEOUT))]);
    return (r && r.ok) ? r : cached; // 部署到一半的 404/5xx 是暫時的，不能蓋掉手上的好快取
  })());
});
