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
  context.localStorage.setItem(run('contentLocalStorageKey()'), JSON.stringify(fallback));
  context.__idb = idb;
  run('idbReadAll = async () => __idb');
  await run('contentInit()');
  assert.deepEqual(Object.keys(plain(run('CONTENT.packs'))).sort(), ['a', 'b']);
});

test('登出重載固定進匿名命名空間，私人內容包也依帳號分開', async () => {
  const { context, run } = loadApp();
  assert.equal(run('KEY'), 'mathA13_anonymous_v1');
  context.localStorage.setItem('mathA13_split_v1', '1');
  run("KEY = userStateKey('account-a')");
  const aKey = run('contentLocalStorageKey()');
  context.localStorage.setItem(aKey, JSON.stringify({ a:{ kind:'notes', rev:1, items:[{ id:'only-a' }] } }));
  run("KEY = userStateKey('account-b')");
  const bKey = run('contentLocalStorageKey()');
  context.localStorage.setItem(bKey, JSON.stringify({ b:{ kind:'notes', rev:1, items:[{ id:'only-b' }] } }));
  run('idbReadAll = async () => ({})');
  await run('contentInit()');
  assert.deepEqual(Object.keys(plain(run('CONTENT.packs'))), ['b']);
  run("KEY = userStateKey('account-a')");
  await run('contentInit()');
  assert.deepEqual(Object.keys(plain(run('CONTENT.packs'))), ['a']);
  assert.notEqual(aKey, bKey);
});

test('首位帳號接收 legacy 私人題包後立刻搬入 scope，不留下可復活的全域副本', async () => {
  const { context, run } = loadApp();
  context.localStorage.setItem('mathA13_split_v1', '1');
  context.localStorage.setItem('mathA13_legacy_owner_v1', 'owner-a');
  context.localStorage.setItem('mathA13_content_v1', JSON.stringify({
    legacy:{ kind:'notes', rev:1, items:[{ id:'legacy-only' }] },
  }));
  run("KEY = userStateKey('owner-a')");
  context.__written = null;
  run('idbReadAll = async () => ({}); idbWriteAll = async (packs) => { __written = packs; }');
  await run('contentInit()');
  assert.deepEqual(Object.keys(plain(context.__written)), ['legacy']);
  assert.deepEqual(Object.keys(plain(run('CONTENT.packs'))), ['legacy']);
  assert.equal(context.localStorage.getItem('mathA13_content_v1'), null);
  assert.equal(context.localStorage.getItem(run('contentLegacyClaimKey()')), '1');
});

test('legacy 題包只落到 localStorage 後備時也會封存 claim，IDB 恢復後不再復活舊副本', async () => {
  const { context, run } = loadApp();
  context.localStorage.setItem('mathA13_split_v1', '1');
  context.localStorage.setItem('mathA13_legacy_owner_v1', 'owner-a');
  context.localStorage.setItem('mathA13_content_v1', JSON.stringify({
    legacy:{ kind:'notes', rev:1, items:[{ id:'legacy-only' }] },
  }));
  run("KEY = userStateKey('owner-a')");
  run("idbReadAll = async () => ({}); idbWriteAll = async () => { throw new Error('idb offline'); }");
  await run('contentInit()');
  const scoped = JSON.parse(context.localStorage.getItem(run('contentLocalStorageKey()')));
  assert.deepEqual(Object.keys(scoped), ['legacy']);
  assert.equal(context.localStorage.getItem('mathA13_content_v1'), null);
  assert.equal(run('contentLegacyClaimFinished()'), true);
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

test('跨裝置在同一回原版模考訂正不同題時逐題合併，不整回互蓋', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const a = { paperRuns:[{ id:'p1', sourceId:'paper-mock-1', status:'awaiting-correction', mt:100, createdAt:1, review:{
      3:{ attempts:1, done:true, completedAt:100, level:2, logs:[{ ts:100, note:'第三題重想' }]}
    }}]};
    const b = { paperRuns:[{ id:'p1', sourceId:'paper-mock-1', status:'awaiting-correction', mt:200, createdAt:1, review:{
      4:{ attempts:2, done:true, completedAt:200, level:3, logs:[{ ts:200, note:'第四題重想' }]}
    }}]};
    return mergeState(a, b).paperRuns[0];
  })()`));
  assert.deepEqual(Object.keys(result.review).sort(), ['3', '4']);
  assert.equal(result.review['3'].done, true);
  assert.equal(result.review['3'].logs[0].note, '第三題重想');
  assert.equal(result.review['4'].done, true);
  assert.equal(result.review['4'].logs[0].note, '第四題重想');
});

test('跨裝置人工覆核不同題時逐題合併，且保留詳批解鎖時間', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const original = (no) => ({ no, status:'correct', points:5, mt:0 });
    const a = { paperRuns:[{ id:'p1', mt:100, createdAt:1,
      aiGrade:{ gradedAt:10, adjustedAt:100, questions:[
        { no:1, status:'incorrect', points:0, manual:true, manualAt:100, mt:100 },
        original(2),
      ]},
      review:{ 1:{ attempts:1, solutionUnlockedAt:100, logs:[{ ts:100, note:'A' }] } },
    }] };
    const b = { paperRuns:[{ id:'p1', mt:200, createdAt:1,
      aiGrade:{ gradedAt:10, adjustedAt:200, questions:[
        original(1),
        { no:2, status:'incorrect', points:0, manual:true, manualAt:200, mt:200 },
      ]},
      review:{ 1:{ attempts:1, logs:[{ ts:200, note:'B' }] } },
    }] };
    return mergeState(a, b).paperRuns[0];
  })()`));
  assert.deepEqual(result.aiGrade.questions.map((q) => [q.no, q.status, q.points]), [
    [1, 'incorrect', 0],
    [2, 'incorrect', 0],
  ]);
  assert.equal(result.aiGrade.score, 0);
  assert.deepEqual(result.aiGrade.wrongNos, [1, 2]);
  assert.equal(result.review['1'].solutionUnlockedAt, 100);
  assert.equal(result.review['1'].attempts, 2);
});

test('舊版人工覆核沒有逐題時間時，依覆核前快照保留兩台各自修改', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const originalQuestions = [
      { no:1, status:'correct', points:5 },
      { no:2, status:'correct', points:5 },
    ];
    const audit = (at) => [{
      id:'audit-' + at, at, reason:'人工覆核前', score:10,
      questions:originalQuestions.map((item) => ({ ...item })),
    }];
    const a = { paperRuns:[{ id:'legacy-p1', mt:100, createdAt:1,
      aiGrade:{ gradedAt:10, adjustedAt:100, questions:[
        { no:1, status:'incorrect', points:0, manual:true },
        { no:2, status:'correct', points:5, manual:true },
      ]},
      gradeAudit:audit(90),
    }] };
    const b = { paperRuns:[{ id:'legacy-p1', mt:200, createdAt:1,
      aiGrade:{ gradedAt:10, adjustedAt:200, questions:[
        { no:1, status:'correct', points:5, manual:true },
        { no:2, status:'incorrect', points:0, manual:true },
      ]},
      gradeAudit:audit(190),
    }] };
    return mergeState(a, b).paperRuns[0];
  })()`));
  assert.deepEqual(result.aiGrade.questions.map((q) => [q.no, q.status, q.points]), [
    [1, 'incorrect', 0],
    [2, 'incorrect', 0],
  ]);
  assert.equal(result.aiGrade.score, 0);
  assert.deepEqual(result.aiGrade.wrongNos, [1, 2]);
  assert.equal(result.gradeAudit.length, 2);
});

test('沒有稽核快照的早期人工覆核資料仍以 adjustedAt 保留已標記題目', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => mergePaperGrade(
    { gradedAt:10, adjustedAt:100, questions:[
      { no:1, status:'incorrect', points:0, manual:true },
      { no:2, status:'correct', points:5 },
    ]},
    { gradedAt:10, adjustedAt:200, questions:[
      { no:1, status:'correct', points:5 },
      { no:2, status:'incorrect', points:0, manual:true },
    ]}
  ))()`));
  assert.deepEqual(result.questions.map((q) => [q.no, q.status, q.points]), [
    [1, 'incorrect', 0],
    [2, 'incorrect', 0],
  ]);
  assert.equal(result.score, 0);
});

test('隔日訂正的完成紀錄不會被合併器多算成一次重新嘗試', () => {
  const { run } = loadApp();
  const result = plain(run(`mergePaperReviewState(
    { attempts:2, logs:[
      { ts:100, note:'第一次重想' },
      { ts:200, note:'第二次重想' },
    ]},
    { attempts:2, done:true, completedAt:301, logs:[
      { ts:100, note:'第一次重想' },
      { ts:200, note:'第二次重想' },
      { ts:300, note:'只看答案後完成' },
    ]}
  )`));
  assert.equal(result.logs.length, 3);
  assert.equal(result.attempts, 2);
  assert.equal(result.done, true);
});

test('同一 paperRun 的外部模考成績只保留一筆較新版本，不重複計入級分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const a = { extMocks:[{ id:'external-p1', paperRunId:'p1', score:75, total:100, ts:1, mt:100, topics:['vec'] }] };
    const b = { extMocks:[{ id:'external-p1', paperRunId:'p1', score:70, total:100, ts:1, mt:200, topics:['prob'] }] };
    const merged = mergeState(a, b);
    return { rows:merged.extMocks, calibration:(() => { S = merged; return mockCalibration(); })() };
  })()`));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].score, 70);
  assert.deepEqual(result.rows[0].topics.sort(), ['prob', 'vec']);
  assert.equal(result.calibration.count, 1);
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

test('模擬卷符合 20 題、100 分與正式題型順序', () => {
  const { run } = loadApp();
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

test('匯入題包的 fill 正解與 src 皆經跳脫，不得成為儲存型 XSS', () => {
  const { context, run } = loadApp();
  // 1) texVal / mDispOpt：fill 題 ans 是匯入資料，裸 < 不可原樣進 innerHTML
  const island = run(`mDispOpt('<img src=x onerror=alert(1)>')`);
  assert.equal(island.includes('<img'), false);
  assert.match(island, /&lt;img/);
  // 合法數學（0<x<1）跳脫後仍保留語意（innerHTML 還原成文字節點給 KaTeX）
  assert.equal(run(`mDispOpt('0<x<1')`), '\\(0&lt;x&lt;1\\)');
  // 2) renderQuestion 的 src 標籤
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const html = run(`(() => {
    sessionChrome = () => {}; inkStart = () => {}; startTicker = () => {}; rtTxt = (value) => escH(String(value || ''));
    const q = { id: 'xss-src', topic: 'prob', type: 'fill', diff: 1, q: '題目', ans: ['1'], src: '<img src=x onerror=alert(1)>' };
    renderQuestion(q, { head: 1, noTimer: true, onDone: () => {} });
    return __app.innerHTML;
  })()`);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img/);
});

test('validateQ 拒絕原型鏈保留字 id', () => {
  const { run } = loadApp();
  const errs = plain(run(`['__proto__', 'constructor', 'prototype', 'normal-1'].map((id) =>
    validateQ({ id, topic: 'prob', type: 'fill', diff: 1, q: 'q', ans: ['1'] }))`));
  assert.equal(errs[0] !== null && errs[1] !== null && errs[2] !== null, true);
  assert.equal(errs[3], null);
});

test('多選題空白送出＝未作答＝0 分；部分給分依學測 3/5、1/5 階梯且兩套批改一致', () => {
  const { run } = loadApp();
  const q = { id: 'm1', type: 'multi', ans: [0, 2], opts: ['a', 'b', 'c', 'd', 'e'], points: 5 };
  const cases = plain(run(`(() => {
    const q = ${JSON.stringify({ id: 'm1', type: 'multi', ans: [0, 2], opts: ['a', 'b', 'c', 'd', 'e'], points: 5 })};
    return {
      empty: mockAnswerResult(q, { type: 'multi', v: [] }).points,
      skip: mockAnswerResult(q, null).points,
      oneErr: mockAnswerResult(q, { type: 'multi', v: [0] }).points,
      twoErr: mockAnswerResult(q, { type: 'multi', v: [0, 1] }).points,
      threeErr: mockAnswerResult(q, { type: 'multi', v: [1, 3, 4] }).points,
      full: mockAnswerResult(q, { type: 'multi', v: [0, 2] }).points,
      paperOneErr: multiPartialPoints(5, [1], [1, 3], [1, 2, 3, 4, 5]),
      paperEmpty: multiPartialPoints(5, [], [1, 3], [1, 2, 3, 4, 5]),
    };
  })()`));
  assert.equal(cases.empty, 0, '空白送出不得優於跳過');
  assert.equal(cases.skip, 0);
  assert.equal(cases.oneErr, 3);
  assert.equal(cases.twoErr, 1);
  assert.equal(cases.threeErr, 0);
  assert.equal(cases.full, 5);
  assert.equal(cases.paperOneErr, 3, '掃描卷與系統模考同一套階梯');
  assert.equal(cases.paperEmpty, 0);
});

test('src 為 __proto__ 的匯入題不會污染原型鏈或炸掉題包卡', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    extBankArr = () => [{ id: 'evil-1', topic: 'prob', type: 'fill', diff: 1, q: 'q', ans: ['1'], src: '__proto__' }];
    curatedState = { lastChecked: 0 };
    const html = packCard();
    return { html: typeof html === 'string', polluted: {}.n !== undefined };
  })()`));
  assert.equal(result.html, true, 'packCard 不得因 __proto__ src 拋錯');
  assert.equal(result.polluted, false, 'Object.prototype 不得被寫入 n');
});
