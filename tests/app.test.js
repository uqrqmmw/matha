'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('內建題庫 schema 與 id 全部有效', () => {
  const { run } = loadApp();
  const rows = plain(run('BANK.map((q) => ({ id: q.id, error: validateQ(q) }))'));
  assert.equal(rows.length > 0, true);
  assert.deepEqual(rows.filter((row) => row.error), []);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test('答案正規化支援分數、多根不拘順序，但不交換座標', () => {
  const { context, run } = loadApp();
  context.__cases = [
    ['0.5', ['1/2']],
    ['5,-1', ['-1,5']],
    ['0,7', ['(7,0)', '7,0']],
  ];
  const result = plain(run('__cases.map(([input, accepted]) => checkFill(input, accepted))'));
  assert.deepEqual(result, [true, true, false]);
});

test('台灣日期與跨年日期加減不偏一天', () => {
  const { run } = loadApp();
  run("Date.now = () => Date.parse('2026-07-15T16:01:00Z')");
  assert.equal(run('today()'), '2026-07-16');
  assert.equal(run("addDays('2026-12-31', 1)"), '2027-01-01');
});

test('AI 數學界定符、Unicode 上標與數A範圍過濾維持 0714c 修復', () => {
  const { context, run } = loadApp();
  context.__aiText = String.raw`**答案**是 \(x+1$`;
  assert.equal(run('fixAiMath(__aiText)'), String.raw`答案是 \(x+1\)`);
  context.__aiEdges = [
    String.raw`$x+1$`,
    String.raw`$$x+1$$`,
    String.raw`費用 $100`,
    String.raw`落單 $$`,
    String.raw`費用 \$100`,
    String.raw`a\\b`,
    String.raw`\(AM$ 後面是說明`,
  ];
  assert.deepEqual(plain(run('__aiEdges.map(fixAiMath)')), [
    String.raw`\(x+1\)`,
    String.raw`\(x+1\)`,
    '費用 $100',
    '落單 $$',
    '費用 $100',
    String.raw`a\\b`,
    String.raw`\(AM\) 後面是說明`,
  ]);
  assert.equal(run("normUnicodeMath('vᵀ')"), 'v<sup>T</sup>');
  assert.equal(run("outOfRange({ q: '求 \\\\cot x' })"), true);
  assert.equal(run("outOfRange({ q: '使用十分逼近法估算' })"), true);
  assert.equal(run("outOfRange({ q: '求正切值', sol: '\\\\sec x' })"), false);
});

test('內容後備儲存逐 pack 合併，不因最大 rev 二選一而丟包', () => {
  const { context, run } = loadApp();
  context.__stores = {
    idb: {
      'idb-only': { kind: 'notes', name: 'IDB', rev: 100, items: [{ id: 'i', rev: 1 }] },
      shared: { kind: 'qpack', name: 'IDB shared', rev: 10, items: [{ id: 'same', rev: 1, value: 'old' }, { id: 'from-idb', rev: 1 }] },
    },
    fallback: {
      'fallback-only': { kind: 'flash', name: 'Fallback', rev: 90, items: [{ id: 'f', rev: 1 }] },
      shared: { kind: 'qpack', name: 'Fallback shared', rev: 30, items: [{ id: 'same', rev: 2, value: 'new' }, { id: 'from-fallback', rev: 1 }] },
    },
  };
  const merged = plain(run('mergePackStores(__stores.idb, __stores.fallback)'));
  assert.deepEqual(Object.keys(merged).sort(), ['fallback-only', 'idb-only', 'shared']);
  assert.equal(merged.shared.name, 'Fallback shared');
  assert.equal(merged.shared.items.find((item) => item.id === 'same').value, 'new');
  assert.deepEqual(merged.shared.items.map((item) => item.id).sort(), ['from-fallback', 'from-idb', 'same']);

  context.__metadataOnly = {
    primary: { p: { id: 'p', rev: 1, items: [{ id: 'kept' }] } },
    fallback: { p: { id: 'p', rev: 2, title: 'metadata-only' } },
  };
  const metadataOnly = plain(run('mergePackStores(__metadataOnly.primary, __metadataOnly.fallback)'));
  assert.deepEqual(metadataOnly.p.items.map((item) => item.id), ['kept']);
});

test('contentInit 實際載入時保留 IDB 與 localStorage 的獨有內容包', async () => {
  const { context, run } = loadApp();
  const idb = { a: { kind: 'notes', name: 'A', rev: 9, items: [{ id: 'a1', rev: 1 }] } };
  const fallback = { b: { kind: 'flash', name: 'B', rev: 8, items: [{ id: 'b1', rev: 1 }] } };
  context.localStorage.setItem('mathA13_split_v1', '1');
  context.localStorage.setItem('mathA13_content_v1', JSON.stringify(fallback));
  context.__idb = idb;
  run('idbReadAll = async () => __idb');
  await run('contentInit()');
  assert.deepEqual(Object.keys(plain(run('CONTENT.packs'))).sort(), ['a', 'b']);
});

test('跨裝置合併保留兩邊作答，錯題採較新的修改時間', () => {
  const { context, run } = loadApp();
  context.__states = {
    a: { attempts: [{ qid: 'q1', ts: 1, d: '2026-07-16', ms: 10, ok: true }], wrong: { q1: { fails: 1, wins: 0, itv: 1, mt: 10 } } },
    b: { attempts: [{ qid: 'q2', ts: 2, d: '2026-07-16', ms: 20, ok: false }], wrong: { q1: { fails: 1, wins: 2, itv: 7, mt: 20 } } },
  };
  const merged = plain(run('mergeState(__states.a, __states.b)'));
  assert.deepEqual(merged.attempts.map((row) => row.qid), ['q1', 'q2']);
  assert.equal(merged.wrong.q1.itv, 7);
});

test('OpenAI 遷移會剔除舊版瀏覽器與 app_state AI 金鑰', () => {
  const { context, run } = loadApp();
  context.__states = {
    a: { attempts: [], wrong: {}, aikey: 'legacy-local-secret', aikeyTs: 1 },
    b: { attempts: [], wrong: {}, aikey: 'legacy-cloud-secret', aikeyTs: 2 },
  };
  const merged = plain(run('mergeState(__states.a, __states.b)'));
  assert.equal(Object.hasOwn(merged, 'aikey'), false);
  assert.equal(Object.hasOwn(merged, 'aikeyTs'), false);

  context.localStorage.setItem('mathA13_aikey', 'legacy-browser-secret');
  context.localStorage.setItem('mathA13_aimodel', 'legacy-model');
  context.localStorage.setItem('mathA13', JSON.stringify({ attempts: [], wrong: {}, aikey: 'legacy-state-secret', aikeyTs: 3 }));
  run('S = load(); aiCredentialCleanup()');
  assert.equal(context.localStorage.getItem('mathA13_aikey'), null);
  assert.equal(context.localStorage.getItem('mathA13_aimodel'), null);
  assert.equal(Object.hasOwn(JSON.parse(context.localStorage.getItem('mathA13')), 'aikey'), false);
});

test('OpenAI 前端只把登入 JWT 傳給 Supabase 安全代理', async () => {
  const { context, run } = loadApp();
  context.__request = null;
  context.fetch = async (url, options) => {
    context.__request = { url, options };
    return { ok: true, status: 200, json: async () => ({ text: 'OK', model: 'gpt-test' }) };
  };
  context.__supa = { auth: { getSession: async () => ({ data: { session: { access_token: 'session-jwt' } } }) } };
  const result = plain(await run("supa = __supa; syncState.user = { id: 'u1' }; openAiInvoke({ responseType: 'test' }, 1000)"));
  const request = context.__request;
  assert.equal(result.text, 'OK');
  assert.match(request.url, /\/functions\/v1\/openai-proxy$/);
  assert.equal(request.options.headers.Authorization, 'Bearer session-jwt');
  assert.equal(JSON.parse(request.options.body).responseType, 'test');
  assert.equal(request.options.body.includes('OPENAI_API_KEY'), false);
});

test('批改後重新啟用畫筆工具，但不解鎖作答按鈕', () => {
  const { context, run } = loadApp();
  const tools = Array.from({ length: 5 }, () => ({ disabled: true }));
  context.document.querySelector = (selector) => selector === '#ink-cv' ? {} : null;
  context.document.querySelectorAll = (selector) => selector === '.sheet-tools .ink-tools button' ? tools : [];
  run("sessionInk.q1 = { s: [], e: [] }; ink = { qid: 'q1', sur: {} }; inkRedrawAll = () => {}; resumeWithMarks('q1', null, null)");
  assert.deepEqual(tools.map((button) => button.disabled), [false, false, false, false, false]);
});

test('沒有手寫筆跡的選擇題，批改後仍排程恢復畫筆', () => {
  const { context, run } = loadApp();
  context.__resumed = [];
  run(`setTimeout = (fn) => { fn(); return 1; };
    qsess = { q: { id: 'q1' } };
    resumeWithMarks = (...args) => __resumed.push(args);
    resumeAfterGrade('q1', null, null);`);
  assert.deepEqual(plain(context.__resumed), [['q1', null, null]]);
});

test('切換到下一題會把頁面捲回題目頂端', () => {
  const { context, run } = loadApp();
  context.__scrollCalls = [];
  context.scrollTo = (...args) => context.__scrollCalls.push(args);
  run('scrollQuestionTop()');
  assert.deepEqual(plain(context.__scrollCalls), [[{ top: 0, left: 0, behavior: 'instant' }]]);
});

test('同步卡片會跳脫遠端錯誤訊息與 email', () => {
  const { context, run } = loadApp();
  context.__sync = { user: { email: '<img src=x onerror=alert(1)>' }, msg: '<script>alert(1)</script>' };
  const html = run('supa = {}; syncState = __sync; syncCard()');
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('一般登出只登出本機；撤銷配對連結使用 global scope', async () => {
  const { context, run } = loadApp();
  const scopes = [];
  context.__auth = { signOut: async ({ scope }) => { scopes.push(scope); return { error: null }; } };
  context.confirm = () => true;
  run('supa = { auth: __auth }; syncState = { user: { email: "x@example.com" }, msg: "" }; renderStats = () => {}');
  await run('syncLogout(false)');
  await run('syncLogout(true)');
  assert.deepEqual(scopes, ['local', 'global']);
});

test('公式卡 id 唯一，模擬卷固定 12 題且不重複', () => {
  const { run } = loadApp();
  const flashIds = plain(run('FLASH.map((card) => card.id)'));
  assert.equal(flashIds.length, 65);
  assert.equal(new Set(flashIds).size, flashIds.length);
  for (let i = 0; i < 20; i++) {
    const ids = plain(run('buildPaper().map((q) => q.id)'));
    assert.equal(ids.length, 12);
    assert.equal(new Set(ids).size, 12);
  }
});
