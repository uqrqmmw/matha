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
  assert.equal(run("daysUntil('2027-01-22', '2026-07-17')"), 189);
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

test('跨裝置在同一回訂正不同題時，完成狀態與重想紀錄都不遺失', () => {
  const { context, run } = loadApp();
  context.__states = {
    a: { corrections: [{ id:'mock-1', mockTs:1, mt:20, entries:[
      { qid:'q1', examNo:1, done:true, completedAt:20, outcome:'answer-only', attempts:0, logs:[{ ts:20, note:'方向一', resolved:true }] },
      { qid:'q2', examNo:2, done:false, attempts:0, logs:[] },
    ] }] },
    b: { corrections: [{ id:'mock-1', mockTs:1, mt:30, entries:[
      { qid:'q1', examNo:1, done:false, attempts:0, logs:[] },
      { qid:'q2', examNo:2, done:true, completedAt:30, outcome:'solution', attempts:1, logs:[{ ts:30, note:'方向二', resolved:true }] },
    ] }] },
  };
  const merged = plain(run('mergeState(__states.a, __states.b).corrections[0]'));
  assert.deepEqual(merged.entries.map((entry) => [entry.examNo, entry.done, entry.outcome]), [
    [1, true, 'answer-only'],
    [2, true, 'solution'],
  ]);
  assert.equal(merged.entries[0].logs[0].note, '方向一');
  assert.equal(merged.entries[1].logs[0].note, '方向二');
});

test('跨裝置合併原版模考紀錄時保留不同回，且同一回採較新階段', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const a = { paperRuns:[
      { id:'p1', sourceId:'paper-mock-1', status:'paused', remainingMs:5000, mt:10, createdAt:1 },
      { id:'p2', sourceId:'paper-mock-2', status:'paused', remainingMs:9000, mt:12, createdAt:2 },
    ] };
    const b = { paperRuns:[
      { id:'p1', sourceId:'paper-mock-1', status:'awaiting-key', score:70, wrongNos:[3,8], mt:20, createdAt:1 },
      { id:'p3', sourceId:'paper-mock-3', status:'grading', mt:15, createdAt:3 },
    ] };
    return mergeState(a, b).paperRuns;
  })()`));
  assert.deepEqual(result.map((x) => x.id), ['p1', 'p2', 'p3']);
  assert.equal(result[0].status, 'awaiting-key');
  assert.equal(result[0].score, 70);
});

test('原版模考捨棄狀態會跨裝置勝過較舊暫存，不被雲端復活', () => {
  const { context, run } = loadApp();
  context.__states = {
    local: { paperRuns:[
      { id:'p1', sourceId:'paper-mock-1', status:'discarded', remainingMs:5000, discardedAt:30, mt:30, createdAt:1 },
    ] },
    remote: { paperRuns:[
      { id:'p1', sourceId:'paper-mock-1', status:'paused', remainingMs:9000, mt:20, createdAt:1 },
    ] },
  };
  const merged = plain(run('mergeState(__states.local, __states.remote)'));
  assert.equal(merged.paperRuns[0].status, 'discarded');
  context.__states.merged = merged;
  run('S = __states.merged');
  assert.equal(run("paperActiveRun('paper-mock-1')"), null);
  assert.equal(run("paperLatestRun('paper-mock-1')"), null);
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

test('註冊確認信固定回到 GitHub Pages 的 matha 專案路徑', async () => {
  const { context, run } = loadApp();
  context.__fields = {
    '#sy-email': { value: 'learner@example.com' },
    '#sy-pass': { value: 'secret123' },
  };
  context.__signupPayload = null;
  context.__auth = {
    signUp: async (payload) => {
      context.__signupPayload = payload;
      return { data: { session: null }, error: null };
    },
  };
  context.document.querySelector = (selector) => context.__fields[selector] || null;
  run('renderStats = () => {}; supa = { auth: __auth }');

  await run('syncLogin(true)');

  assert.equal(context.__signupPayload.options.emailRedirectTo, 'https://uqrqmmw.github.io/matha/');
});

test('公式卡 id 唯一，模擬卷符合 20 題、100 分與正式題型順序', () => {
  const { run } = loadApp();
  const flashIds = plain(run('FLASH.map((card) => card.id)'));
  assert.equal(flashIds.length, 65);
  assert.equal(new Set(flashIds).size, flashIds.length);
  for (let i = 0; i < 20; i++) {
    const paper = plain(run('buildPaper().map((q) => ({ id:q.id, no:q.examNo, section:q.examSection, points:q.points, groupId:q.groupId, stem:q.stem, responseType:q.responseType }))'));
    assert.equal(paper.length, 20);
    assert.equal(new Set(paper.map((q) => q.id)).size, 20);
    assert.deepEqual(paper.map((q) => q.no), Array.from({ length: 20 }, (_, n) => n + 1));
    assert.deepEqual(paper.map((q) => q.section), [
      ...Array(6).fill('single'), ...Array(6).fill('multi'), ...Array(5).fill('fill'), ...Array(3).fill('mixed'),
    ]);
    assert.equal(paper.reduce((sum, q) => sum + q.points, 0), 100);
    const mixed = paper.slice(17);
    assert.equal(new Set(mixed.map((q) => q.groupId)).size, 1, '末三題必須共享同一題組');
    assert.equal(mixed.every((q) => q.responseType === 'written' && /題幹/.test(q.stem)), true);
  }
});

test('眼睛刷題建立完整 20 題學測結構，並能從同一整回續寫', () => {
  const { run } = loadApp();
  run(`
    S.visionQueue = [];
    S.visionHistory = [];
    syncGate = () => true;
    save = () => {};
    globalThis.__openedVision = null;
    visionOpenEntry = (entry, entries, paperRun) => {
      globalThis.__openedVision = { id: entry.id, index: entry.paperIndex, count: entries.length, paperRun };
    };
    startVisionScan();
  `);
  const entries = plain(run(`S.visionQueue.map((entry) => ({
    id: entry.id, paperId: entry.paperId, paperIndex: entry.paperIndex,
    examNo: entry.examNo, examSection: entry.examSection, points: entry.points,
    mixedGroupId: entry.mixedGroupId, paperSeen: entry.paperSeen
  }))`));
  assert.equal(entries.length, 20);
  assert.equal(new Set(entries.map((entry) => entry.paperId)).size, 1);
  assert.deepEqual(entries.map((entry) => entry.paperIndex), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(entries.map((entry) => entry.examNo), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(entries.map((entry) => entry.examSection), [
    ...Array(6).fill('single'), ...Array(6).fill('multi'), ...Array(5).fill('fill'), ...Array(3).fill('mixed'),
  ]);
  assert.equal(entries.reduce((sum, entry) => sum + entry.points, 0), 100);
  assert.equal(new Set(entries.slice(17).map((entry) => entry.mixedGroupId)).size, 1);
  assert.deepEqual(plain(run('__openedVision')), { id: entries[0].id, index: 0, count: 20, paperRun: true });

  run(`S.visionQueue[0].paperSeen = true; S.visionQueue[1].paperSeen = true; startVisionScan();`);
  assert.equal(run('S.visionQueue.length'), 20, '續寫時不應另開新卷');
  assert.deepEqual(plain(run('__openedVision')), { id: entries[2].id, index: 2, count: 20, paperRun: true });
  assert.equal(run('visionCompletedPaperCount()'), 0);
  run('S.visionQueue.forEach((entry) => { entry.paperSeen = true; })');
  assert.equal(run('visionCompletedPaperCount()'), 1);
});

test('眼睛刷題入口不再提供單題模式', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /20 題完整學測結構/);
  assert.match(source, /開始一整回（20 題）/);
  assert.doesNotMatch(source, /看一題，只找方向|只用眼睛刷一題|再看一題/);
});

test('裝置配對只接受一次性 magic-link token，不再解析帳密或 session 權杖', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = source.indexOf('async function autoLoginFromHash');
  const end = source.indexOf('async function makePairLink');
  const pairing = source.slice(start, end);
  assert.match(pairing, /verifyOtp\(\{ token_hash:/);
  assert.doesNotMatch(pairing, /signInWithPassword|setSession|atob|refresh_token|access_token/);
});

test('revision compare-and-swap 遇到另一台搶先更新會重拉合併，不丟任一方紀錄', async () => {
  const { context, run } = loadApp();
  context.__remote = {
    revision: 7,
    data: { attempts: [{ qid:'remote-a', ts:1, d:'2026-07-17', ms:10, ok:true }], wrong:{}, drills:{}, mocks:[], corrections:[], daily:{} },
  };
  context.__updates = [];
  context.__from = () => {
    let mode = 'read', payload = null, filters = {};
    const chain = {
      select() { return chain; },
      update(value) { mode = 'update'; payload = value; return chain; },
      insert(value) { mode = 'insert'; payload = value; return chain; },
      eq(key, value) { filters[key] = value; return chain; },
      async maybeSingle() {
        if (mode === 'read') return { data: JSON.parse(JSON.stringify(context.__remote)), error: null };
        if (mode === 'update') {
          context.__updates.push({ revision: payload.revision, expected: filters.revision });
          if (filters.revision === 7) {
            context.__remote = {
              revision: 8,
              data: { ...context.__remote.data, attempts: [...context.__remote.data.attempts, { qid:'remote-b', ts:2, d:'2026-07-17', ms:20, ok:false }] },
            };
            return { data: null, error: null };
          }
          context.__remote = { revision: payload.revision, data: JSON.parse(JSON.stringify(payload.data)) };
          return { data: { revision: payload.revision }, error: null };
        }
        return { data: { revision: 1 }, error: null };
      },
    };
    return chain;
  };
  run(`stateWrite = async () => {}; flushInkQueue = async () => {}; syncPill = () => {};
    supa = { from: __from };
    syncState = { user:{ id:'u1' }, msg:'', last:null };
    S = load();
    S.attempts = [{ qid:'local', ts:3, d:'2026-07-17', ms:30, ok:true }];`);
  await run('syncPush()');
  assert.deepEqual(context.__updates, [{ revision: 8, expected: 7 }, { revision: 9, expected: 8 }]);
  assert.deepEqual(context.__remote.data.attempts.map((x) => x.qid), ['remote-a', 'remote-b', 'local']);
});
