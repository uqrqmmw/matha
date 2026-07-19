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
  assert.match(app, /<button type="button" class="bk-opt" aria-label="選項/);
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
