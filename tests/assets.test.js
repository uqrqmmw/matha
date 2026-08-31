'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ROOT } = require('./helpers/load-app');

function localPath(ref) {
  return ref.replace(/^\.\//, '').replace(/[?#].*$/, '');
}

test('HTML、manifest 與 service-worker shell 引用的本機資產都存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  refs.push(...manifest.icons.map((icon) => icon.src));
  const shellMatch = sw.match(/const SHELL = (\[[\s\S]*?\]);/);
  assert.ok(shellMatch, '找不到 service worker SHELL');
  refs.push(...vm.runInNewContext(shellMatch[1]));
  const missing = [...new Set(refs)]
    .filter((ref) => ref !== './' && !/^(?:https?:|data:|#)/.test(ref))
    .filter((ref) => !fs.existsSync(path.join(ROOT, localPath(ref))));
  assert.deepEqual(missing, []);
});

test('舒適作答的原像素題號定位完整涵蓋 17 回 339 題', () => {
  const source = fs.readFileSync(path.join(ROOT, 'paper-question-crops.js'), 'utf8');
  const match = source.match(/Object\.freeze\((\{[\s\S]*\})\);/);
  assert.ok(match, '找不到逐題裁切 payload');
  const payload = JSON.parse(match[1]);
  const papers = Object.values(payload.papers || {});
  assert.equal(papers.length, 17);
  assert.equal(papers.reduce((sum, paper) => sum + Object.keys(paper.questions || {}).length, 0), 339);
  for (const paper of papers) for (const segments of Object.values(paper.questions || {})) {
    assert.equal(Array.isArray(segments) && segments.length > 0, true);
    for (const segment of segments) {
      assert.equal(Number.isInteger(segment.page), true);
      assert.equal(segment.top >= 0 && segment.bottom > segment.top && segment.bottom <= 1, true);
    }
  }
});

test('雙擊本機 index 會轉正式站，安全檢查不再永久等待 Service Worker', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(html, /location\.protocol === 'file:'[\s\S]*?location\.replace\('https:\/\/uqrqmmw\.github\.io\/matha\//);
  assert.match(app, /paperAwaitWithTimeout\(navigator\.serviceWorker\.ready,\s*4500/);
  assert.match(app, /paperAwaitWithTimeout\(systemReadinessPaperAssets\(paperSource\),\s*20000/);
});

test('KaTeX 的 woff2 離線字型完整，PWA theme color 一致', () => {
  const cssPath = path.join(ROOT, 'vendor', 'katex', 'katex.min.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const fontRefs = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/["']/g, ''));
  // KaTeX 發行版同時列 woff2/woff/ttf fallback；本 app 的目標瀏覽器都支援 woff2，離線包刻意只帶 woff2。
  const woff2Refs = fontRefs.filter((ref) => ref.endsWith('.woff2'));
  assert.equal(woff2Refs.length > 0, true);
  const missingFonts = woff2Refs.filter((ref) => !fs.existsSync(path.resolve(path.dirname(cssPath), localPath(ref))));
  assert.deepEqual(missingFonts, []);

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  const meta = html.match(/<meta name="theme-color" content="([^"]+)">/);
  assert.ok(meta);
  assert.equal(manifest.theme_color, meta[1]);
});

test('GitHub Pages 以 meta CSP 與 no-referrer 補足可控的瀏覽器安全邊界', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /connect-src 'self' https:\/\/rrihysbxhsbxjteqmtdu\.supabase\.co wss:\/\/rrihysbxhsbxjteqmtdu\.supabase\.co/);
  assert.doesNotMatch(html, /script-src[^;]*https?:\/\/(?!rrihysbxhsbxjteqmtdu\.supabase\.co)/);
});

test('官方詳解 bucket 為私有且 schema 不授權一般登入者直接讀取', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(schema, /'matha-solutions',\s*'matha-solutions',\s*false,/);
  const createPolicies = [...schema.matchAll(/create policy[\s\S]*?;/gi)].map((match) => match[0]);
  assert.equal(createPolicies.some((policy) => /matha-solutions/i.test(policy)), false,
    'matha-solutions 不得建立 authenticated select policy；只能由 Edge 簽短效網址');
  assert.match(html, /img-src 'self' data: blob: https:\/\/rrihysbxhsbxjteqmtdu\.supabase\.co/,
    'CSP 必須允許顯示 Supabase 短效簽名詳解圖');
  for (const publicSource of [html, app, sw]) {
    assert.doesNotMatch(publicSource, /paper-mock-1\/q(?:03|04|11|12-a|12-b|13|14|16)\.png/,
      '公開前端與離線快取不得含官方詳解物件路徑');
  }
});

test('真機驗收使用 14MiB PDF/JSON 專用私有 bucket，學生 JWT 完全沒有物件 policy', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '202608300001_create_matha_audit_private.sql'), 'utf8');
  for (const sql of [schema, migration]) {
    assert.match(sql, /'matha-audit-private',\s*'matha-audit-private',\s*false,\s*14680064,\s*array\['application\/pdf',\s*'application\/json'\]/);
  }
  const policies = [...schema.matchAll(/create policy[\s\S]*?;/gi)]
    .map((match) => match[0])
    .filter((policy) => /matha-audit-private/i.test(policy));
  assert.equal(policies.length, 0,
    '真機 PDF/JSON 只能由 Edge service role 寫入與讀回，authenticated/public 不得直接讀寫');
  assert.match(schema, /'matha-content',\s*'matha-content',\s*false,\s*1048576,\s*array\['application\/json'\]/,
    '題庫 bucket 維持獨立的 JSON-only learner-read policy');
});

test('原版模考掃描不進公開站資產或離線快取', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const names = [...app.matchAll(/file:\s*'(mock-[^']+\.png)'/g)].map((m) => m[1]);
  assert.equal(names.length, 16);
  assert.equal(new Set(names).size, 8);
  assert.equal(names.every((name) => !fs.existsSync(path.join(ROOT, name))), true);
  names.forEach((name) => assert.equal(sw.includes(name), false));
});

test('作答選項具備鍵盤與螢幕閱讀器語意', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(app, /<button type="button" class="bk-opt" aria-label="選擇原題中的第/);
  assert.match(app, /<span class="sr-only">選擇原題裁圖中的第/);
  assert.match(css, /\.bk-opt:focus-visible/);
});

test('npm test 的測試清單涵蓋 tests/ 下每個 *.test.js（清單寫死是為了 Windows/Node20 相容，漏列在這裡抓）', () => {
  // shell glob 在 Windows cmd 不展開、`node --test <目錄>` 與 <glob> 在 Node 20/22 行為不一，
  // 所以 package.json 逐檔列出；新增測試檔忘了列上去時，這條會紅。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((name) => name.endsWith('.test.js'));
  assert.equal(files.length > 0, true);
  for (const name of files) {
    assert.equal(pkg.scripts.test.includes(`tests/${name}`), true, `package.json test script 漏列 tests/${name}`);
  }
});

test('版本戳單一來源：APP_VER、index.html ?v=、sw.js APP_STAMP 完全一致', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const appVer = app.match(/const APP_VER = '([^']+)'/);
  assert.ok(appVer, '找不到 APP_VER');
  const swStamp = sw.match(/const APP_STAMP = '([^']+)'/);
  assert.ok(swStamp, '找不到 sw.js APP_STAMP');
  assert.equal(swStamp[1], appVer[1], 'sw.js APP_STAMP 必須等於 app.js APP_VER（否則快取名不會換、離線裝置拿到半新半舊）');
  assert.match(sw, /const CACHE = CACHE_PREFIX \+ APP_STAMP/, '快取名必須由 APP_STAMP 推導，不得手寫死');
  assert.match(html, /event\.data\.type !== 'MATHA_APP_VERSION'/, '頁面只能在 SW 回報不同版本時顯示更新提示');
  assert.match(html, /event\.data\.version[\s\S]*pageVersion[\s\S]*showUpdateBar/, '同版首次 claim 不得誤顯示更新提示');
  assert.match(sw, /GET_MATHA_APP_VERSION[\s\S]*MATHA_APP_VERSION[\s\S]*APP_STAMP/, 'SW 必須可回覆自己實際控制的版本');
  // index.html 引用的每個本機 js/css 都要檢查——不能只驗「已經有 ?v= 的那幾個」，
  // 否則新增一個沒帶戳的資產會無聲通過（GitHub Pages max-age=600 → 半新半舊 10 分鐘）
  const localAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(([, ref]) => ref)
    .filter((ref) => !/^(?:https?:|data:|#)/.test(ref))
    .filter((ref) => /\.(?:js|css)(?:\?|$)/.test(ref));
  assert.equal(localAssets.length >= 4, true, 'index.html 應引用本機 js/css 資產');
  for (const ref of localAssets) {
    const [file, query = ''] = ref.split('?');
    if (file.startsWith('vendor/')) continue; // vendor 檔只隨手動 vendoring 換版，不吃 APP_VER 戳
    const stamp = (query.match(/(?:^|&)v=([^&]+)/) || [])[1];
    assert.equal(stamp, appVer[1], `${file} 必須帶 ?v=${appVer[1]}（目前：${ref}）`);
  }
  // SW 快取 key 以無 query URL 為準，SHELL 不得帶 query；
  // 且 SHELL 必須涵蓋 index.html 的每個本機 js/css——漏收＝該檔離線拿不到（首次離線直接開壞）
  const shellMatch = sw.match(/const SHELL = (\[[\s\S]*?\]);/);
  const shell = new Set(vm.runInNewContext(shellMatch[1]).map((entry) => entry.replace(/^\.\//, '')));
  for (const entry of shell) {
    assert.equal(entry.includes('?'), false, `SHELL 條目不應帶 query：${entry}`);
  }
  for (const ref of localAssets) {
    const file = ref.split('?')[0];
    assert.equal(shell.has(file), true, `sw.js SHELL 漏收 ${file}：安裝時不會預快取，離線會拿不到`);
  }
});
