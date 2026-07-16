'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('級分校準只採完整模擬，三場皆過 72% 才標穩定', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = Array.from({length: 40}, (_, i) => ({ qid: BANK[i].id, ok: true, ms: 1000, d: today(), mode: 'mixed', ts: i + 1 }));
    const before = mockCalibration();
    S.mocks = [
      { d: addDays(today(), -2), ok: 9, n: 12, acc: .75 },
      { d: addDays(today(), -1), ok: 10, n: 12, acc: 10 / 12 },
      { d: today(), ok: 9, n: 12, acc: .75 },
    ];
    const after = mockCalibration();
    return { before, after, pulse: practicePulse() };
  })()`));
  assert.equal(result.before.count, 0, '全對的弱項練習也不得冒充模擬校準');
  assert.equal(result.after.count, 3);
  assert.equal(result.after.stable, true);
  assert.equal(result.after.passes, 3);
  assert.equal(result.after.grade, '13 級分');
  assert.equal(result.pulse.n, 40);
});

test('下一步優先順序為隔日盲訂正、未完成大綱；大綱完成後才排全真校準、弱點與觀念', () => {
  const { run } = loadApp();
  const states = plain(run(`(() => {
    S.attempts = []; S.mocks = []; S.wrong = {}; S.corrections = []; S.outlineAttempts = [];
    const outline = nextBestAction();
    S.corrections = [{ id:'c1', due:today(), entries:[{ qid:BANK[0].id, done:false }] }];
    const due = nextBestAction();
    S.corrections = [];
    S.outlineAttempts = OUTLINE_DEFAULTS.map((unit, i) => ({ id:'o' + i, unitId:unit.id, ts:i + 1, due:addDays(today(), 2) }));
    const noData = nextBestAction();
    S.mocks = [{ d: today(), score:68, total:100, ok:68, n:100, acc:.68 }];
    for (let i = 0; i < 4; i++) S.attempts.push({ qid:BANK.find((q) => q.topic === 'num').id, ok:false, ms:180000, d:today(), mode:'mixed', ts:i + 1 });
    const weak = nextBestAction();
    S.attempts = [];
    const normal = nextBestAction();
    return { outline:outline.kind, noData:noData.kind, due:due.kind, weak:weak.kind, normal:normal.kind };
  })()`));
  assert.deepEqual(states, { outline:'outline', noData:'mock', due:'correction', weak:'topic', normal:'concept' });
});

test('全真多選採部分計分，模考錯題排到隔天且當天不開放', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    mock = { judge:{} };
    const q = { id:'x', type:'multi', opts:['a','b','c','d','e'], ans:[0,2], points:5 };
    const oneError = mockAnswerResult(q, { type:'multi', v:[0] });
    const detail = [{ q:{ id:BANK[0].id, examNo:1, examSection:'single', points:5 }, ok:false, yourAns:'(2)', answered:true }];
    S.corrections = [];
    const batch = queueMockCorrection(detail, 123);
    return { points:oneError.points, due:batch.due, today:today(), dueNow:dueCorrections().length };
  })()`));
  assert.equal(result.points, 3);
  assert.notEqual(result.due, result.today);
  assert.equal(result.dueNow, 0);
});

test('主要導覽只留下新版五條路，章節與速度工具不再佔主入口', () => {
  const { run } = loadApp();
  const views = plain(run('Object.entries(VIEWS).map(([key, value]) => [key, value.label])'));
  assert.deepEqual(views, [
    ['home', '今日'],
    ['outline', '大綱默寫'],
    ['mock', '模考與破題'],
    ['correct', '隔日訂正'],
    ['concept', '觀念理解'],
  ]);
  assert.equal(run("Object.values(VIEWS).some((v) => /章節|速度|番茄/.test(v.label))"), false);
  assert.deepEqual(plain(run('Object.keys(LEGACY_VIEWS)')), ['stats']);
});

test('十一單元固定保留空白頁，完成後固定兩天再測', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.outlineAttempts = [];
    S.extoutlines = OUTLINE_DEFAULTS.map((x, i) => ({ ...x, title:'單元' + (i + 1), reference:'重點' + (i + 1) }));
    const first = outlineDueUnits().length;
    S.outlineAttempts.push({ id:'oa1', unitId:'outline-1', d:today(), ts:1, due:addDays(today(), 2), coverage:70 });
    return { count:outlineUnits().length, first, dueNow:outlineDueUnits().length, dueDate:outlineLast('outline-1').due };
  })()`));
  assert.equal(result.count, 11);
  assert.equal(result.first, 11);
  assert.equal(result.dueNow, 10);
  assert.notEqual(result.dueDate, run('today()'));
});

test('十一單元大綱來源已完整建立語意核對基準', () => {
  const { run } = loadApp();
  const result = plain(run(`OUTLINE_DEFAULTS.map((unit) => ({ id:unit.id, title:unit.title, n:unit.reference.length }))`));
  assert.deepEqual(result.map((x) => x.title), [
    '集合、邏輯與實數系', '直角坐標系中直線、半平面與圓', '函數與多項式函數', '三角比與三角函數',
    '有限數列與有限級數', '數據分析', '排列組合與機率', '指數與對數',
    '平面向量、線性組合與二階行列式', '空間中的向量與直線、平面方程式', '矩陣與線性變換及其應用',
  ]);
  assert.equal(result.every((x, i) => x.id === `outline-${i + 1}` && x.n >= 150), true);
  assert.equal(run("OUTLINE_DEFAULTS[9].reference.includes('高斯消去')"), true);
  assert.equal(run("OUTLINE_DEFAULTS[10].reference.includes('線性變換')"), true);
});

test('三回私有原版模考依正式題數拆成清晰單頁，且左右頁共用私有高解析跨頁', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const scans = PAPER_SOURCES.flatMap((source) => source.scans.map((scan) => scan.file));
    return { bucket:PAPER_SOURCE_BUCKET, papers:PAPER_SOURCES.map((source) => ({ q:source.questions, min:source.minutes, pages:source.pages, scans:source.scans.length, sides:source.scans.map((scan) => scan.side) })), scans, unique:new Set(scans).size };
  })()`));
  assert.equal(result.bucket, 'matha-papers');
  assert.deepEqual(result.papers, [
    { q:20, min:100, pages:6, scans:6, sides:['left','right','left','right','left','right'] },
    { q:19, min:100, pages:6, scans:6, sides:['left','right','left','right','left','right'] },
    { q:20, min:100, pages:4, scans:4, sides:['left','right','left','right'] },
  ]);
  assert.equal(result.scans.length, 16);
  assert.equal(result.unique, 8);
  assert.equal(result.scans.every((name) => /^mock-[123]-page-[1-6]-[1-6]\.png$/.test(name)), true);
});

test('原版工作台把筆跡畫布直接覆蓋在題目與右側留白，不再壓縮成左右分割', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const html = run(`(() => {
    sessionChrome = () => {}; paperInkAttach = () => {}; startTicker = () => {};
    const source = PAPER_SOURCES[0], row = { id:'write-1', status:'active', remainingMs:6000000, resumeAt:Date.now(), answers:{} };
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:0, zoom:1, inkMode:'pen' };
    renderPaperSource();
    return __app.innerHTML;
  })()`);
  assert.match(html, /paper-write-sheet/);
  assert.match(html, /paper-question-crop/);
  assert.match(html, /paper-note-margin/);
  assert.match(html, /可直接書寫的題本頁/);
  assert.match(html, /id="paper-pen-width" type="range" min="35" max="200" step="5"/);
  assert.match(html, /調整畫筆粗細/);
  assert.doesNotMatch(html, /paper-draft-pane|paper-view-switch/);
});

test('原版模考每一筆保存當下粗細，調整後不會改變既有筆跡', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const widths = [];
    const ctx = { lineWidth:0, set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){ widths.push(this.lineWidth); } };
    const pts = [[.1,.1,.5],[.2,.2,.5]];
    paperInkLine(ctx, { pts, w:.4 }, 100, 100);
    paperInkLine(ctx, { pts, w:1.6 }, 100, 100);
    paperInkLine(ctx, { pts }, 100, 100);
    const label = { textContent:'' };
    document.querySelector = (selector) => selector === '#paper-pen-width-label' ? label : null;
    paperSourceSession = { inkWidth:1, run:{ mt:0 } };
    paperInkWidthSet(45); clearTimeout(paperStateSaveTimer);
    return { widths, selected:paperSourceSession.inkWidth, saved:paperSourceSession.run.paperInkWidth, label:label.textContent };
  })()`));
  assert.deepEqual(result.widths.map((n) => Math.round(n * 100) / 100), [.84, 3.36, 2.1]);
  assert.equal(result.selected, .45);
  assert.equal(result.saved, .45);
  assert.equal(result.label, '45%');
});

test('原版模考支援雙指以手勢中心縮放，放開一指後恢復單指拖曳', () => {
  const { context, run } = loadApp();
  const result = plain(run(`(() => {
    const pane = { scrollLeft:0, scrollTop:0 };
    const label = { textContent:'' };
    const inkContext = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} };
    const canvas = {
      clientWidth:1000, clientHeight:1200, width:1000, height:1200, dataset:{},
      setPointerCapture(){}, closest(){ return pane; }, getContext(){ return inkContext; },
      getBoundingClientRect(){ return { left:100 - pane.scrollLeft, top:100 - pane.scrollTop, width:1000 * paperSourceSession.zoom, height:1200 * paperSourceSession.zoom }; },
    };
    const sheet = {
      style:{},
      getBoundingClientRect(){ return { left:100 - pane.scrollLeft, top:100 - pane.scrollTop, width:1000 * paperSourceSession.zoom, height:1200 * paperSourceSession.zoom }; },
    };
    document.querySelector = (selector) => selector === '#paper-write-sheet' ? sheet : selector === '#paper-zoom-label' ? label : selector === '#paper-ink-canvas' ? canvas : null;
    paperSourceSession = { zoom:1, inkMode:'pen', inkPages:{ 0:{ s:[], loaded:true } }, page:0 };
    const touch = (pointerId, clientX, clientY) => ({ pointerType:'touch', pointerId, clientX, clientY, currentTarget:canvas, preventDefault(){} });
    paperInkAttach();
    paperInkDown(touch(1, 200, 200));
    paperInkDown(touch(2, 400, 200));
    paperInkMove(touch(2, 600, 200));
    const pinch = { zoom:paperSourceSession.zoom, label:label.textContent, left:pane.scrollLeft, top:pane.scrollTop, strokes:paperInkPage().s.length };
    paperInkUp(touch(2, 600, 200));
    const release = { pinching:!!paperSourceSession.inkPinch, touchId:paperSourceSession.inkTouch && paperSourceSession.inkTouch.id, touches:paperSourceSession.inkTouches.size };
    paperWorkspaceSetZoom(9); const max = paperSourceSession.zoom;
    paperWorkspaceSetZoom(.1); const min = paperSourceSession.zoom;
    return { pinch, release, max, min };
  })()`));
  assert.deepEqual(result.pinch, { zoom:2, label:'200%', left:100, top:100, strokes:0 });
  assert.deepEqual(result.release, { pinching:false, touchId:1, touches:1 });
  assert.equal(result.max, 4);
  assert.equal(result.min, .75);
  context.document.querySelector = () => null;
});

test('原版隔日訂正會定位到每題真正所在的清晰單頁，新舊筆跡版面不混用', () => {
  const { run } = loadApp();
  const result = plain(run(`({
    maps:PAPER_SOURCES.map((source) => source.key.map((_, i) => paperQuestionScanIndex(source, i + 1))),
    qid:paperInkQid({id:'run-1'}, 3), version:PAPER_LAYOUT_VERSION,
  })`));
  assert.deepEqual(result.maps[0], [0,0,0,0,0,1,1,1,2,2,2,3,3,3,4,4,4,5,5,5]);
  assert.deepEqual(result.maps[1], [0,0,0,0,1,1,1,2,2,2,3,3,3,4,4,4,4,5,5]);
  assert.deepEqual(result.maps[2], [0,0,0,0,0,1,1,1,2,2,2,2,2,3,3,3,3,3,3,3]);
  assert.equal(result.version, 2);
  assert.equal(result.qid, 'paper:run-1:v2:3');
});

test('原版模考批分只保存分數與錯題號，隔天鎖定且不捏造答案', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.__els = {
    '#paper-score': { value:'64' },
    '#paper-wrong': { value:'2、7, 18' },
    '#paper-note': { value:'第三大題來不及' },
  };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : context.__els[selector] || null;
  const result = plain(run(`(() => {
    save = () => {}; sessionChrome = () => {};
    const source = PAPER_SOURCES[0];
    const run = { id:'paper-run-1', sourceId:source.id, name:source.title, d:today(), createdAt:1, mt:1, status:'grading', remainingMs:600000, wrongNos:[] };
    S.paperRuns = [run]; S.extMocks = [];
    paperSourceSession = { source, run, urls:[] };
    paperSourceSaveGrade();
    return { status:run.status, due:run.due, today:today(), score:run.score, wrong:run.wrongNos, ext:S.extMocks[0], html:__app.innerHTML };
  })()`));
  assert.equal(result.status, 'awaiting-correction');
  assert.notEqual(result.due, result.today);
  assert.equal(result.score, 64);
  assert.deepEqual(result.wrong, [2, 7, 18]);
  assert.equal(result.ext.paperRunId, 'paper-run-1');
  assert.match(result.html, /逐題顯示最終答案/);
  assert.doesNotMatch(result.html, /正確答案|詳解如下/);
});

test('原版三回的正式答案鍵與配分各自完整加總 100 分，數位答案卡可自動批分', () => {
  const { run } = loadApp();
  const result = plain(run(`PAPER_SOURCES.map((source) => {
    const answers = {};
    source.key.forEach((q, i) => { answers[i + 1] = { type:q.type, v:q.type === 'fill' ? q.ans[0] : q.type === 'single' ? q.ans[0] : [...q.ans] }; });
    const graded = paperGradePreview(source, { answers });
    return { questions:source.questions, key:source.key.length, total:source.key.reduce((sum, q) => sum + q.points, 0), graded };
  })`));
  assert.deepEqual(result.map((x) => [x.questions, x.key, x.total, x.graded.score, x.graded.wrongNos.length]), [
    [20, 20, 100, 100, 0],
    [19, 19, 100, 100, 0],
    [20, 20, 100, 100, 0],
  ]);
});

test('原版多選題依五個選項的判定錯誤數給 5、3、1、0 分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = { type:'multi', ans:[0, 3], points:5 };
    return [
      paperAnswerGradeItem(q, { type:'multi', v:[0,3] }).points,
      paperAnswerGradeItem(q, { type:'multi', v:[0] }).points,
      paperAnswerGradeItem(q, { type:'multi', v:[1,3] }).points,
      paperAnswerGradeItem(q, { type:'multi', v:[1,2] }).points,
    ];
  })()`));
  assert.deepEqual(result, [5, 3, 1, 0]);
});

test('原版模考暫停會凍結剩餘時間並可跨頁面續寫', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const row = { id:'pause-1', status:'active', remainingMs:100000, resumeAt:Date.now() - 2000, mt:1 };
    paperSourceSession = { source:PAPER_SOURCES[0], run:row, urls:[] };
    paperSourcePause();
    const frozen = paperRunLeft(row);
    return { status:row.status, resumeAt:row.resumeAt, remaining:row.remainingMs, frozen };
  })()`));
  assert.equal(result.status, 'paused');
  assert.equal(result.resumeAt, null);
  assert.equal(result.remaining >= 97000 && result.remaining <= 99000, true);
  assert.equal(Math.abs(result.frozen - result.remaining) < 20, true);
});

test('捨棄原版模考會留下同步墓碑並清掉關聯成績', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const row = { id:'discard-1', sourceId:'paper-mock-1', status:'paused', remainingMs:100000, resumeAt:null, mt:1, createdAt:1 };
    S.paperRuns = [row];
    S.extMocks = [{ id:'external-discard-1', paperRunId:'discard-1', score:0 }];
    paperSourceDiscard('discard-1');
    return { row, active:paperActiveRun('paper-mock-1'), latest:paperLatestRun('paper-mock-1'), ext:S.extMocks };
  })()`));
  assert.equal(result.row.status, 'discarded');
  assert.equal(result.row.resumeAt, null);
  assert.equal(result.row.discardedAt > 1, true);
  assert.equal(result.row.mt, result.row.discardedAt);
  assert.equal(result.active, null);
  assert.equal(result.latest, null);
  assert.deepEqual(result.ext, []);
});

test('眼睛刷題沒有方向時隔天才到期，基本定義卡依語意結果排程', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.visionQueue = [{ id:'v1', qid:BANK[0].id, stage:'waiting', due:addDays(today(),1), done:false }];
    S.conceptAttempts = [{ id:'c1', conceptId:CONCEPT_CARDS[0].id, ts:1, due:addDays(today(),7), understood:true }];
    return { visionToday:visionDueEntries().length, conceptDue:conceptDueCards().length, total:CONCEPT_CARDS.length };
  })()`));
  assert.equal(result.visionToday, 0);
  assert.equal(result.conceptDue, result.total - 1);
});

test('完整模考二十題全部進三級報告，考場答對題直接列第一級', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.corrections = [];
    const detail = buildPaper().map((q, i) => ({ q, ok:i < 12, yourAns:i < 12 ? '正確作答' : '錯誤作答', answered:true }));
    const batch = queueMockCorrection(detail, 999);
    return { total:batch.entries.length, counts:correctionCounts(batch) };
  })()`));
  assert.equal(result.total, 20);
  assert.deepEqual(result.counts, { open: 8, l1: 12, l2: 0, l3: 0 });
});

test('模考交卷當天只顯示分數與錯題號，不洩漏答案、章節或詳解', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  run(`sessionChrome = () => {}; save = () => {}; recordAttempt = () => {};
    S.attempts = []; S.mocks = []; S.corrections = [];
    const q = { ...BANK.find((x) => x.id === 'line5'), examNo: 13, examSection: 'fill', points: 100 };
    mock = { graded:[q], answers:{ [q.id]:{ type:'fill', v:'0' } }, times:{}, proc:{}, aiv:{}, partial:false };
    mockFinal();`);
  const html = context.__app.innerHTML;
  assert.match(html, /得分 <b>0 \/ 100/);
  assert.match(html, /今天到此為止，不訂正/);
  assert.doesNotMatch(html, /25\/3/);
  assert.doesNotMatch(html, /直線與圓/);
  assert.doesNotMatch(html, /詳解：|正確答案/);
});

test('隔日訂正至少記下一次重想，才允許解鎖詳解', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {}; renderCorrectionWork = () => {};
    const entry = { qid:BANK[0].id, examNo:1, done:false, attempts:0, logs:[] };
    const batch = { id:'c1', d:addDays(today(), -1), due:today(), mt:1, entries:[entry] };
    S.corrections = [batch]; correction = { batch, indexes:[0], i:0, t0:Date.now() };
    correctionUnlock();
    const locked = entry.solutionUnlockedAt == null;
    entry.attempts = 1; correctionUnlock();
    return { locked, unlocked:!!entry.solutionUnlockedAt };
  })()`));
  assert.deepEqual(result, { locked: true, unlocked: true });
});

test('答對但猜中會留下 confidence 並排入隔日重測，不灌成熟練', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = []; S.wrong = {}; S.mocks = []; S.daily = {};
    const q = BANK.find((x) => x.id === 'num1');
    const rec = recordAttempt(q, true, 50000, '用猜的', 'practice');
    return { rec, wrong: S.wrong[q.id] };
  })()`));
  assert.equal(result.rec.ok, true);
  assert.equal(result.rec.confidence, 'guess');
  assert.equal(result.rec.err, '用猜的');
  assert.equal(result.wrong.fails, 0);
  assert.equal(result.wrong.err, '用猜的');
  assert.match(result.wrong.due, /^\d{4}-\d{2}-\d{2}$/);
});

test('儀表板明示練習答對率不換算級分，並保存類題遷移欄位', () => {
  const { run } = loadApp();
  const html = run('scoreGoalCard()');
  assert.match(html, /弱項刷題答對率不拿來灌高級分/);
  const sourceShape = run(`(() => {
    const src = String(qResolve);
    return ['independent-transfer', 'originErr', 'topic: q.topic', 'diff: q.diff'].every((x) => src.includes(x));
  })()`);
  assert.equal(sourceShape, true);
});

test('實體模考優先作為級分證據，失分單元會進入修分建議', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = []; S.mocks = [{ d: today(), ok: 12, n: 12, acc: 1 }]; S.wrong = {};
    S.extMocks = [
      { d: addDays(today(), -1), name: '<img src=x onerror=alert(1)>', score: 68, total: 100, topics: ['prob'], err: '看錯題意', minutesLeft: 0, note: '<script>x</script>', ts: 1 },
      { d: today(), name: '第二次模考', score: 74, total: 100, topics: ['prob', 'comb'], err: '計算失誤', minutesLeft: 3, ts: 2 },
    ];
    const cal = mockCalibration();
    return { source: cal.source, acc: cal.acc, plan: recoveryPlanCard(), card: extMockCard() };
  })()`));
  assert.equal(result.source, 'external');
  assert.equal(result.acc, 0.71);
  assert.match(result.plan, /機率/);
  assert.doesNotMatch(result.card, /<img src=x/);
  assert.doesNotMatch(result.card, /<script>x/);
  assert.match(result.card, /&lt;img/);
  assert.match(result.card, /剩 3 分/);
});

test('未登入時離線開練不再被原生確認框阻擋', () => {
  const { context, run } = loadApp();
  let confirms = 0;
  context.confirm = () => { confirms++; return true; };
  const allowed = run(`(() => { supa = {}; syncState.user = null; syncGateAsked = false; return syncGate(); })()`);
  assert.equal(allowed, true);
  assert.equal(confirms, 0);
  assert.match(run('syncState.msg'), /只存這台/);
});
