'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, loadApp } = require('./helpers/load-app');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('UI 使用專案內建 SVG 圖示，不依賴外部圖示庫', () => {
  const html = read('index.html');
  assert.match(html, /<symbol id="ui-brand"/);
  assert.match(html, /<symbol id="ui-target"/);
  assert.match(html, /<symbol id="ui-tutor"/);
  assert.doesNotMatch(html, /fontawesome|material-icons|unpkg\.com|cdnjs\.cloudflare\.com/i);
});

test('導覽名稱為純文字且搭配 SVG 圖示', () => {
  const source = read('app.js');
  const viewsBlock = source.match(/const VIEWS = \{([\s\S]*?)\n\};/);
  assert.ok(viewsBlock, '找不到 VIEWS 設定');
  assert.doesNotMatch(viewsBlock[1], /[\u{1F000}-\u{1FAFF}\uFE0F\u200D]/u);
  assert.match(viewsBlock[1], /icon:\s*'clipboard'/);
  assert.match(source, /uiIcon\(VIEWS\[v\]\.icon\)/);
});

test('介面文字清理會移除 emoji 並保留多行訊息', () => {
  const { context, run } = loadApp();
  context.__uiText = '🎯 主題刷題 ✅\n  下一行  內容';
  assert.equal(run('uiTextOnly(__uiText)'), '主題刷題\n下一行 內容');
});

test('低彩度設計 token 與 PWA 主題色一致', () => {
  const css = read('style.css');
  const html = read('index.html');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.match(css, /--bg:\s*#f3f1ec/);
  assert.match(css, /--accent:\s*#75675c/);
  assert.match(html, /name="theme-color" content="#75675c"/);
  assert.equal(manifest.theme_color, '#75675c');
});

test('AI 回饋欄位統一經數學字串修復後再渲染', () => {
  const source = read('app.js');
  const unsafeAiEscapes = [
    'escH(v.firstError)',
    'escH(v.praise)',
    'escH(v.nextTime)',
    'escH(w.adv.fe)',
    'escH(w.adv.nt)',
    'escH(s.what)',
    'escH(s.fix)',
  ];
  unsafeAiEscapes.forEach((pattern) => assert.equal(source.includes(pattern), false, pattern));
  assert.match(source, /rtAi\(v\.firstError\)/);
  assert.match(source, /rtAi\(w\.adv\.nt\)/);
  assert.match(source, /rtAi\(s\.what/);
});

test('OpenAI 金鑰只存在 Edge Function secret，不進瀏覽器程式', () => {
  const source = read('app.js');
  const proxy = read('supabase/functions/openai-proxy/index.ts');
  assert.doesNotMatch(source, /api\.openai\.com|Authorization:\s*[`'"]Bearer\s+\$\{?apiKey/i);
  assert.doesNotMatch(source, /id="aikey"|aiKeySave\(/);
  assert.match(source, /const AI_FUNCTION_URL = 'https:\/\/rrihysbxhsbxjteqmtdu\.supabase\.co\/functions\/v1\/' \+ AI_FUNCTION/);
  assert.match(proxy, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(proxy, /APP_SUPABASE_URL.*rrihysbxhsbxjteqmtdu/);
  assert.match(proxy, /https:\/\/uqrqmmw\.github\.io/);
  assert.match(proxy, /\/auth\/v1\/user/);
  assert.match(proxy, /Authorization: authorization/);
  assert.match(proxy, /OPENAI_ALLOWED_ORIGINS/);
  assert.match(proxy, /OPENAI_ALLOWED_(EMAILS|USER_IDS)/);
  assert.match(proxy, /!allowedUserIds\.size && !allowedEmails\.size/);
  assert.match(proxy, /safety_identifier/);
  assert.match(proxy, /type: "json_schema"/);
  assert.match(proxy, /store: false/);
});
