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

test('作答選項具備鍵盤與螢幕閱讀器語意', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(app, /<button type="button" class="bk-opt" aria-label="選項/);
  assert.match(app, /class="btn pbtn" aria-label="選項/);
  assert.match(css, /\.bk-opt:focus-visible/);
});
