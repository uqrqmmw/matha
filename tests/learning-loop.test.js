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
    return { before, after };
  })()`));
  assert.equal(result.before.count, 0, '全對的弱項練習也不得冒充模擬校準');
  assert.equal(result.after.count, 3);
  assert.equal(result.after.stable, true);
  assert.equal(result.after.passes, 3);
  assert.equal(result.after.grade, '13 級分');
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

test('模考與破題把原版模考置頂，並依每回自動日期保留可回看的批改歷史', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    S.paperRuns = [{
      id:'history-run-1', sourceId:source.id, name:source.title, d:'2026-07-18',
      createdAt:100, submittedAt:200, status:'awaiting-correction', due:'2026-07-19',
      score:75, wrongNos:[2, 5, 12], aiGrade:{ score:75, wrongNos:[2, 5, 12], questions:[] },
    }];
    S.mocks = []; S.visionQueue = [];
    renderMockIntro();
    const html = __app.innerHTML;
    return {
      html,
      paperAt:html.indexOf('原版模考'),
      systemAt:html.indexOf('全真模考'),
      date:paperRunDisplayDate(S.paperRuns[0]),
      fallbackDate:paperRunDisplayDate({ submittedAt:Date.parse('2026-07-17T16:30:00Z') }),
    };
  })()`));
  assert.ok(result.paperAt >= 0 && result.paperAt < result.systemAt);
  assert.equal(result.date, '2026-07-18');
  assert.equal(result.fallbackDate, '2026-07-18');
  assert.match(result.html, /原卷作答歷史/);
  assert.match(result.html, /2026-07-18/);
  assert.match(result.html, /75\/100/);
  assert.match(result.html, /查看紅筆卷/);
  assert.match(result.html, /逐題紀錄/);
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
  assert.match(html, /整個畫面皆可直接書寫並左右滑動翻頁/);
  assert.match(html, /id="paper-ai-canvas"/);
  assert.match(html, /id="paper-pen-width" type="range" min="35" max="200" step="5"/);
  assert.match(html, /id="paper-color-black"/);
  assert.match(html, /id="paper-color-blue"/);
  assert.match(html, /id="paper-color-green"/);
  assert.match(html, /id="paper-ui-toggle"/);
  assert.match(html, /aria-label="收起工具"/);
  assert.match(html, /交卷並第一次批改/);
  assert.match(html, /調整畫筆粗細/);
  assert.doesNotMatch(html, /paper-pane-caption|paper-write-hint|paper-spread-preview/);
  assert.doesNotMatch(html, /paperAnswerOpen|paper-answer-button|答案卡已填/);
  assert.doesNotMatch(html, /paper-color-red|紅色筆/);
  assert.doesNotMatch(html, /paper-draft-pane|paper-view-switch/);
});

test('原版題本預設使用 cover 尺寸，直向滿高、橫向滿寬且不受 1180px 上限', () => {
  const { context, run } = loadApp();
  const result = plain(run(`(() => {
    const pane = { clientWidth:924, clientHeight:1480 };
    const sheet = { style:{} };
    document.querySelector = (selector) => selector === '.paper-page-viewport' ? pane : selector === '#paper-write-sheet' ? sheet : null;
    paperSourceSession = { zoom:1, inkPages:{ 0:{ s:[], loaded:true } }, page:0 };
    paperWorkspaceFit();
    const portrait = { fit:paperSourceSession.fitWidth, width:sheet.style.width, max:sheet.style.maxWidth };
    pane.clientWidth = 1707; pane.clientHeight = 791; sheet.style = {};
    paperWorkspaceFit();
    const landscape = { fit:paperSourceSession.fitWidth, width:sheet.style.width, max:sheet.style.maxWidth };
    return { portrait, landscape };
  })()`));
  assert.equal(Math.round(result.portrait.fit), 1233);
  assert.equal(result.portrait.width, `${result.portrait.fit}px`);
  assert.equal(result.portrait.max, 'none');
  assert.equal(result.landscape.fit, 1707);
  assert.equal(result.landscape.width, '1707px');
  assert.equal(result.landscape.max, 'none');
  context.document.querySelector = () => null;
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

test('原版模考只提供黑藍綠三種學生筆色，且每一筆保存自己的顏色', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const colors = [];
    const ctx = { lineWidth:0, set strokeStyle(v){ colors.push(v); }, set lineCap(v){}, set lineJoin(v){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} };
    const pts = [[.1,.1,.5],[.2,.2,.5]];
    paperInkLine(ctx, { pts, c:'black' }, 100, 100);
    paperInkLine(ctx, { pts, c:'blue' }, 100, 100);
    paperInkLine(ctx, { pts, c:'green' }, 100, 100);
    paperInkLine(ctx, { pts, c:'red' }, 100, 100);
    paperSourceSession = { inkColor:'black', inkMode:'pen', run:{ mt:0 } };
    paperInkColorSet('blue'); clearTimeout(paperStateSaveTimer);
    paperInkColorSet('red'); clearTimeout(paperStateSaveTimer);
    return { keys:Object.keys(PAPER_INK_COLORS), colors, selected:paperSourceSession.inkColor, saved:paperSourceSession.run.paperInkColor, ai:PAPER_AI_RED };
  })()`));
  assert.deepEqual(result.keys, ['black', 'blue', 'green']);
  assert.deepEqual(result.colors, ['#343a36', '#315f78', '#4f7158', '#343a36']);
  assert.equal(result.selected, 'blue');
  assert.equal(result.saved, 'blue');
  assert.equal(result.ai, '#b43b32');
});

test('S Pen 側鍵暫時切換橡皮擦，懸停不誤刪且放開恢復原工具', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const active = { pen:false, erase:false }, status = { textContent:'' };
    const button = (key) => ({ classList:{ toggle(name, value){ if (name === 'active') active[key] = value; } } });
    const ctx = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, set lineWidth(v){} };
    const canvas = {
      clientWidth:1000, clientHeight:1000, width:1000, height:1000, dataset:{},
      setPointerCapture(){}, closest(){ return null; }, getContext(){ return ctx; },
      getBoundingClientRect(){ return { left:0, top:0, width:1000, height:1000 }; },
    };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas
      : selector === '#paper-tool-pen' ? button('pen')
      : selector === '#paper-tool-erase' ? button('erase')
      : selector === '#paper-ink-status' ? status : null;
    const stroke = { pts:[[.4,.5,.5],[.6,.5,.5]] };
    paperSourceSession = { inkMode:'pen', inkWidth:1, inkPages:{ 0:{ s:[stroke], loaded:true } }, page:0, run:{ id:'spen', createdAt:1 } };
    const pen = (type, buttons, pressure) => ({ type, pointerType:'pen', pointerId:7, button:type === 'pointerdown' ? 2 : -1, buttons, pressure, clientX:500, clientY:500, currentTarget:canvas, preventDefault(){} });
    const mapping = {
      barrel:paperInkPenErasePressed({ pointerType:'pen', buttons:2 }),
      barrelWithTip:paperInkPenErasePressed({ pointerType:'pen', buttons:3 }),
      samsungBarrel:paperInkPenErasePressed({ pointerType:'pen', buttons:4 }),
      samsungWithTip:paperInkPenErasePressed({ pointerType:'pen', buttons:5 }),
      tail:paperInkPenErasePressed({ pointerType:'pen', buttons:32 }),
      androidSecondary:paperInkPenErasePressed({ pointerType:'pen', buttons:64 }),
      samsungDown:paperInkPenErasePressed({ type:'pointerdown', pointerType:'pen', button:1, buttons:0 }),
      fallback:paperInkPenErasePressed({ type:'pointerdown', pointerType:'pen', button:2, buttons:0 }),
      released:paperInkPenErasePressed({ type:'pointermove', pointerType:'pen', button:2, buttons:1 }),
      mouse:paperInkPenErasePressed({ pointerType:'mouse', buttons:2 }),
    };
    paperInkDown(pen('pointerdown', 2, 0));
    const hover = { deleted:!!stroke.dead, mode:canvas.dataset.mode, status:status.textContent };
    paperInkMove(pen('pointermove', 3, .6));
    const contact = { deleted:!!stroke.dead, mode:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkUp(pen('pointerup', 0, 0));
    const restored = { mode:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return { mapping, hover, contact, restored };
  })()`));
  assert.deepEqual(result.mapping, { barrel:true, barrelWithTip:true, samsungBarrel:true, samsungWithTip:true, tail:true, androidSecondary:true, samsungDown:true, fallback:true, released:false, mouse:false });
  assert.deepEqual(result.hover, { deleted:false, mode:'erase', status:'S Pen 側鍵按住：暫時橡皮擦' });
  assert.deepEqual(result.contact, { deleted:true, mode:'erase', status:'S Pen 側鍵按住：暫時橡皮擦', active:{ pen:false, erase:true } });
  assert.deepEqual(result.restored, { mode:'pen', status:'筆跡自動保存', active:{ pen:true, erase:false } });
});

test('逐題模考與十一單元共用的整頁畫布支援 S Pen 按住擦、放開恢復筆', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const status = { hidden:true, textContent:'' };
    const ctx = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, set strokeStyle(v){}, set lineWidth(v){}, set lineCap(v){}, set lineJoin(v){} };
    const canvas = {
      dataset:{}, style:{}, classList:{ contains(){ return true; } }, parentElement:{ clientWidth:800, clientHeight:900 }, clientWidth:800, clientHeight:900, width:800, height:900,
      getContext(){ return ctx; }, setPointerCapture(){}, getBoundingClientRect(){ return { left:0, top:0, width:800, height:900 }; }, closest(){ return null; },
    };
    document.querySelector = (selector) => selector === '#ink-s-pen-status' ? status : selector === '#ink-cv' ? canvas : null;
    const stroke = { t0:10, c:'k', pts:[[100,100],[200,100]] };
    sessionInk.shared = { s:[stroke], e:[] };
    ink = { qid:'shared', t0:1, clientId:'shared-client', penAt:0, sur:{} };
    const sur = inkSurface('calc', canvas, 900); ink.sur.calc = sur;
    const pen = (type, buttons, x, y) => ({ type, pointerType:'pen', pointerId:12, button:type === 'pointerdown' ? 1 : -1, buttons, pressure:type === 'pointerup' ? 0 : .6, clientX:x, clientY:y, currentTarget:canvas, preventDefault(){} });
    inkDown(pen('pointerdown', 5, 150, 100), sur);
    const pressed = { dead:!!stroke.dead, mode:canvas.dataset.mode, hidden:status.hidden, status:status.textContent };
    inkMove(pen('pointermove', 1, 300, 300), sur);
    const released = { mode:canvas.dataset.mode, hidden:status.hidden, status:status.textContent, drawing:!!sur.cur };
    inkUp(pen('pointerup', 0, 300, 300), sur);
    clearTimeout(inkCheckpointTimer);
    return { pressed, released, direct:sPenErasePressed({ type:'pointerdown', pointerType:'pen', button:1, buttons:0 }) };
  })()`));
  assert.deepEqual(result.pressed, { dead:true, mode:'erase', hidden:false, status:'側鍵按住：橡皮擦' });
  assert.deepEqual(result.released, { mode:'pen', hidden:true, status:'', drawing:true });
  assert.equal(result.direct, true);
});

test('三星 Chrome 的懸停 button=1 只在按住期間暫時使用橡皮擦', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const active = { pen:false, erase:false }, status = { textContent:'' };
    const button = (key) => ({ classList:{ toggle(name, value){ if (name === 'active') active[key] = value; } } });
    const canvas = { dataset:{} };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas
      : selector === '#paper-tool-pen' ? button('pen')
      : selector === '#paper-tool-erase' ? button('erase')
      : selector === '#paper-ink-status' ? status : null;
    paperSourceSession = { inkMode:'pen', inkPointer:null };
    const hover = (buttonValue) => ({ type:'pointermove', pointerType:'pen', pointerId:9, button:buttonValue, buttons:buttonValue === 1 ? 4 : 0, pressure:0, currentTarget:canvas, preventDefault(){} });
    paperInkMove(hover(1));
    const pressed = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkMove(hover(1));
    const stillHeld = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode };
    paperInkMove(hover(-1));
    const released = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkMove(hover(1));
    let prevented = false;
    paperInkContextMenu({ preventDefault(){ prevented = true; } });
    const menu = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, prevented };
    return { pressed, stillHeld, released, menu };
  })()`));
  assert.deepEqual(result.pressed, { held:true, mode:'pen', shown:'erase', status:'S Pen 側鍵按住：暫時橡皮擦', active:{ pen:false, erase:true } });
  assert.deepEqual(result.stillHeld, { held:true, mode:'pen' });
  assert.deepEqual(result.released, { held:false, mode:'pen', shown:'pen', status:'筆跡自動保存', active:{ pen:true, erase:false } });
  assert.deepEqual(result.menu, { held:false, mode:'pen', shown:'pen', status:'筆跡自動保存', prevented:true });
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

test('原版模考單指水平滑動翻頁；題本放大或尚未移到邊界時只平移不誤翻', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => ({
    next:paperTouchPageDelta({ startX:400, startY:200, x:285, y:208 }),
    prev:paperTouchPageDelta({ startX:200, startY:200, x:310, y:190 }),
    short:paperTouchPageDelta({ startX:200, startY:200, x:145, y:203 }),
    vertical:paperTouchPageDelta({ startX:200, startY:200, x:105, y:320 }),
    pinched:paperTouchPageDelta({ startX:400, startY:200, x:285, y:208, swipeBlocked:true }),
    coverCenter:paperTouchPanBlocksPage({ startX:300, x:170, startScrollLeft:120, maxScrollLeft:309 }, 1),
    coverLeftPrev:paperTouchPanBlocksPage({ startX:200, x:310, startScrollLeft:0, maxScrollLeft:309 }, 1),
    coverRightNext:paperTouchPanBlocksPage({ startX:400, x:285, startScrollLeft:309, maxScrollLeft:309 }, 1),
    zoomed:paperTouchPanBlocksPage({ startX:400, x:285, startScrollLeft:309, maxScrollLeft:309 }, 1.25),
  }))()`));
  assert.deepEqual(result, {
    next:1, prev:-1, short:0, vertical:0, pinched:0,
    coverCenter:true, coverLeftPrev:false, coverRightNext:false, zoomed:true,
  });
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

test('GPT-5.5 第一次整卷批改保存對錯、分數與正式答案，但不保存詳解或步驟診斷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:i === 1 ? '手寫 99' : '作答',
      status:i === 1 ? 'incorrect' : 'correct', points:i === 1 ? 0 : q.points,
      hasFinalAnswer:true, finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : i === 1 ? [1] : q.ans.map((option) => option + 1),
      marks:[{ kind:i === 1 ? 'cross' : 'check', option:0, box:[.1,.1,.2,.2], label:i === 1 ? '正解是機密答案' : '洩漏詳解' }],
    })), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    const row = { id:'paper-run-1', sourceId:source.id, name:source.title, d:today(), createdAt:1, mt:1, status:'grading', remainingMs:600000, wrongNos:[] };
    S.paperRuns = [row]; S.extMocks = [];
    paperSourceRecordGrade(source, row, grade);
    return {
      status:row.status, due:row.due, today:today(), score:row.score, wrong:row.wrongNos,
      ext:S.extMocks[0], labels:grade.questions.flatMap((q) => q.marks.map((m) => m.label)),
      kinds:grade.questions.flatMap((q) => q.marks.map((m) => m.kind)),
      answers:grade.questions.map((q) => q.answer), model:grade.model,
      hasDetailedFields:grade.questions.some((q) => 'firstError' in q || 'explanation' in q || 'solution' in q),
    };
  })()`));
  assert.equal(result.status, 'awaiting-correction');
  assert.notEqual(result.due, result.today);
  assert.equal(result.score, 95);
  assert.deepEqual(result.wrong, [2]);
  assert.equal(result.ext.paperRunId, 'paper-run-1');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.labels.every((label) => /^(✓ \+\d+(?:\.\d+)?|△ \+\d+(?:\.\d+)?|✕ 0|未作答|看不清楚)$/.test(label)), true);
  assert.equal(result.labels.some((label) => /正解|答案|詳解/.test(label)), false);
  assert.equal(result.kinds.includes('cross'), true);
  assert.equal(result.kinds.includes('check'), true);
  assert.equal(result.answers.length, 20);
  assert.equal(result.answers.every(Boolean), true);
  assert.equal(result.hasDetailedFields, false);
});

test('交卷會合成全部單頁、呼叫一次整卷批改並直接進入紅筆唯讀結果', async () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(await run(`(async () => {
    save = () => {}; sessionChrome = () => {}; stopTicker = () => {};
    paperInkPersist = async () => true;
    const composed = [];
    paperPageComposite = async (page) => { composed.push(page); return 'page-' + page; };
    paperAiGradeCall = async (source, pages) => ({ model:'gpt-5.5', json:{ questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:'作答', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1), points:q.points, marks:[],
    })), note:'' } });
    let rendered = 0; renderPaperGradeResult = () => { rendered++; };
    const source = PAPER_SOURCES[0], row = { id:'grade-flow', sourceId:source.id, name:source.title, d:today(), createdAt:1, mt:1, status:'active', remainingMs:6000000, resumeAt:Date.now(), wrongNos:[] };
    S.paperRuns = [row]; S.extMocks = [];
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:3, zoom:2, inkMode:'pen', inkWidth:1, inkColor:'black' };
    sessionActive = true; sessionMode = 'paper-source';
    await paperSourceGrade('主動交卷');
    return { composed, status:row.status, score:row.score, due:row.due, today:today(), readOnly:paperSourceSession.readOnly, page:paperSourceSession.page, zoom:paperSourceSession.zoom, mode:sessionMode, active:sessionActive, rendered, ext:S.extMocks.length };
  })()`));
  assert.deepEqual(result.composed, [0, 1, 2, 3, 4, 5]);
  assert.equal(result.status, 'awaiting-correction');
  assert.equal(result.score, 100);
  assert.notEqual(result.due, result.today);
  assert.equal(result.readOnly, true);
  assert.equal(result.page, 0);
  assert.equal(result.zoom, 1);
  assert.equal(result.mode, 'paper-result');
  assert.equal(result.active, false);
  assert.equal(result.rendered, 1);
  assert.equal(result.ext, 1);
});

test('第一次整卷結果直接疊加對錯、分數與正確答案，不再出現答案卡或人工分數欄位', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const html = run(`(() => {
    sessionChrome = () => {}; paperInkAttach = () => {};
    const source = PAPER_SOURCES[0], row = {
      id:'red-result', name:source.title, due:addDays(today(), 1),
      aiGrade:{ score:95, wrongNos:[2], uncertainNos:[], questions:[], model:'gpt-5.5' },
    };
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:0, zoom:1, readOnly:true };
    renderPaperGradeResult();
    return __app.innerHTML;
  })()`);
  assert.match(html, /第一次批改｜對錯、分數、正確答案/);
  assert.match(html, /你的原筆跡＋AI 紅筆標記/);
  assert.match(html, /id="paper-ink-canvas"/);
  assert.match(html, /id="paper-ai-canvas" aria-label="AI 紅筆批改標記"/);
  assert.match(html, /95 \/ 100/);
  assert.match(html, /錯題：2/);
  assert.match(html, /第二次詳批最早/);
  assert.doesNotMatch(html, /paper-score|paper-wrong|paperAnswer|答案卡/);
});

test('原版三回的正式答案鍵與配分各自完整加總 100 分，可供整卷視覺批改', () => {
  const { run } = loadApp();
  const result = plain(run(`PAPER_SOURCES.map((source) => ({
    questions:source.questions, key:source.key.length,
    total:source.key.reduce((sum, q) => sum + q.points, 0),
    prompt:paperGradePromptKey(source),
  }))`));
  assert.deepEqual(result.map((x) => [x.questions, x.key, x.total, x.prompt.length]), [
    [20, 20, 100, 20],
    [19, 19, 100, 19],
    [20, 20, 100, 20],
  ]);
  assert.equal(result.every((x) => x.prompt.every((q) => q.answer && q.page >= 1 && q.page <= 6)), true);
  assert.equal(result.every((x) => x.prompt.every((q) => Array.isArray(q.correctOptions))), true);
});

test('GPT-5.5 多選批分會強制收斂到正式的 5、3、1、0 分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0], multiNos = source.key.map((q, i) => q.type === 'multi' ? i + 1 : 0).filter(Boolean);
    const raw = { questions:source.key.map((q, i) => ({ no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:'', status:'correct', points:q.points, marks:[] })), note:'' };
    const candidates = [2.9, 1.1, .1];
    multiNos.slice(0, 3).forEach((no, i) => { raw.questions[no - 1].status = 'incorrect'; raw.questions[no - 1].points = candidates[i]; });
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return [source.key[multiNos[3] - 1].points, ...multiNos.slice(0, 3).map((no) => grade.questions[no - 1].points)];
  })()`));
  assert.deepEqual(result, [5, 3, 1, 0]);
});

test('第一次簡批的單選與填答由正式答案重新核分，不採信模型自稱答對', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:'模型辨識', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })), note:'' };
    raw.questions[0].selectedOptions = [1];
    raw.questions[0].status = 'correct';
    raw.questions[13].finalAnswer = '999';
    raw.questions[13].status = 'correct';
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return {
      score:grade.score,
      q1:{ status:grade.questions[0].status, points:grade.questions[0].points },
      q14:{ status:grade.questions[13].status, points:grade.questions[13].points },
      wrong:grade.wrongNos,
    };
  })()`));
  assert.deepEqual(result, {
    score:90,
    q1:{ status:'incorrect', points:0 },
    q14:{ status:'incorrect', points:0 },
    wrong:[1,14],
  });
});

test('模型 status 與結構化答案衝突時，以實際辨識答案確定性核分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:'模型辨識', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })) };
    raw.questions[0].status = 'unanswered';
    raw.questions[13].status = 'unanswered';
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return {
      score:grade.score,
      q1:[grade.questions[0].status, grade.questions[0].points],
      q14:[grade.questions[13].status, grade.questions[13].points],
      wrong:grade.wrongNos,
    };
  })()`));
  assert.deepEqual(result, {
    score:100,
    q1:['correct', 5],
    q14:['correct', 5],
    wrong:[],
  });
});

test('重新 AI 批改保留前版稽核快照，且不延後原本隔日訂正日期', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const source = PAPER_SOURCES[0], due = '2026-07-19';
    const oldGrade = { model:'gpt-5.5', gradedAt:1, score:75, wrongNos:[3], uncertainNos:[], questions:[{ no:3, status:'incorrect', points:0, read:'x', marks:[] }] };
    const newGrade = { model:'gpt-5.5', gradedAt:2, score:70, wrongNos:[3,4], uncertainNos:[], questions:[{ no:3, status:'incorrect', points:0, read:'x', marks:[] },{ no:4, status:'incorrect', points:0, read:'y', marks:[] }] };
    const row = { id:'audit-run', sourceId:source.id, name:source.title, d:'2026-07-18', submittedAt:10, due, aiGrade:oldGrade, score:75, remainingMs:1, mt:1 };
    S.extMocks = [{ id:'external-audit-run', paperRunId:'audit-run', score:75, total:100 }];
    paperSourceRecordGrade(source, row, newGrade);
    return {
      due:row.due, submittedAt:row.submittedAt, audits:row.gradeAudit.length,
      previous:row.gradeAudit[0].score, current:row.score,
      ext:S.extMocks.filter((x) => x.paperRunId === 'audit-run').map((x) => x.score),
    };
  })()`));
  assert.deepEqual(result, {
    due:'2026-07-19', submittedAt:10, audits:1, previous:75, current:70, ext:[70],
  });
});

test('第一次簡批依正式答案逐項重算複選，錯選劃掉、漏選補上且不信任模型亂給分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const chosen = {
      8:[1,4],
      11:[3,4],
      12:[1,2,4,5],
      13:[1,3,5],
    };
    const raw = { questions:source.key.map((q, i) => {
      const no = i + 1;
      const selectedOptions = q.type === 'fill' ? []
        : q.type === 'multi' ? (chosen[no] || q.ans.map((option) => option + 1))
        : q.ans.map((option) => option + 1);
      return {
        no, page:paperQuestionScanIndex(source, no) + 1, read:selectedOptions.join('、'),
        status:'correct', hasFinalAnswer:true, finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
        selectedOptions, points:99,
        marks:selectedOptions.map((option, markIndex) => ({
          kind:'check', option, box:[.1 + markIndex * .03,.2,.12 + markIndex * .03,.23], label:'模型亂判',
        })),
      };
    }), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return [8,11,12,13].map((no) => ({
      no,
      points:grade.questions[no - 1].points,
      status:grade.questions[no - 1].status,
      edits:grade.questions[no - 1].marks.map((mark) => [mark.kind, mark.option]),
      answer:grade.questions[no - 1].answer,
    }));
  })()`));
  assert.deepEqual(result, [
    { no:8, points:5, status:'correct', edits:[['check',1],['check',4]], answer:'(1)(4)' },
    { no:11, points:1, status:'incorrect', edits:[['strike',3],['check',4],['add',5]], answer:'(4)(5)' },
    { no:12, points:3, status:'incorrect', edits:[['check',1],['strike',2],['check',4],['check',5]], answer:'(1)(4)(5)' },
    { no:13, points:1, status:'incorrect', edits:[['strike',1],['check',3],['check',5],['add',4]], answer:'(3)(4)(5)' },
  ]);
});

test('圈住印刷題號並寫不會必須視為未答，不能誤當成同號選項', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:i === 3 ? '圈住印刷題號 4，寫不會' : '有最終答案',
      status:'correct', hasFinalAnswer:i !== 3,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    const q4 = grade.questions[3];
    return { status:q4.status, points:q4.points, kind:q4.marks[0].kind, answer:q4.answer, score:grade.score };
  })()`));
  assert.deepEqual(result, { status:'unanswered', points:0, kind:'unanswered', answer:'(4)', score:95 });
});

test('整卷視覺提示明定圈題號不是答案、逐項複選與第一次禁止詳解', async () => {
  const { run } = loadApp();
  const prompt = await run(`(async () => {
    let request = null;
    openAiInvoke = async (payload) => { request = payload; return { model:'gpt-5.5', json:{} }; };
    await paperAiGradeCall(PAPER_SOURCES[0], []);
    return request.messages[0].content[0].text;
  })()`);
  assert.match(prompt, /圈住「印刷的題號」[\s\S]*絕對不是選了同號選項/);
  assert.match(prompt, /kind=strike/);
  assert.match(prompt, /kind=add/);
  assert.match(prompt, /系統會在紅叉或部分得分旁強制寫出完整正解/);
  assert.match(prompt, /禁止輸出詳解、提示、破題方向、錯誤類型/);
});

test('真人式紅筆會在錯答旁畫叉並直接寫正解，不再用整框標籤', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const calls = { line:0, rect:0, text:[] };
    const ctx = {
      setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){ calls.line++; },
      closePath(){}, strokeRect(){ calls.rect++; }, fillRect(){}, save(){}, restore(){},
      measureText(text){ return { width:String(text).length * 11 }; },
      strokeText(){}, fillText(text){ calls.text.push(String(text)); },
    };
    const cv = { clientWidth:1000, clientHeight:1400, width:0, height:0, getContext(){ return ctx; } };
    paperAiPaintCanvas(cv, [{
      no:4, status:'incorrect', points:0, answer:'(4)',
      marks:[{ kind:'cross', option:0, box:[.2,.3,.25,.33], label:'✕ 0' }],
    }], true);
    return calls;
  })()`));
  assert.equal(result.rect, 0);
  assert.equal(result.line > 0, true);
  assert.equal(result.text.some((text) => /✕ 0.*正解 \(4\)/.test(text)), true);
  assert.equal(result.text.some((text) => /詳解|提示|錯誤步驟/.test(text)), false);
});

test('原版隔日詳批必須先有一次重想，才會呼叫第二種 AI 並保存第一個錯誤與完整解法', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {};
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'detail-flow', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    paperReview = { source, run:row, urls:[], inkPages:{}, nos:[no], i:0, detailLoading:false, detailError:'' };
    let calls = 0;
    paperReviewPageComposite = async () => 'composite';
    paperAiDetailCall = async (givenSource, givenNo, image, logs) => {
      calls++;
      return { model:'gpt-5.5', json:{
        readable:true, read:'先把 x 當成常數', firstError:'把變數 x 當成常數',
        errorKind:'條件誤讀', explanation:'x 會隨條件改變。',
        solution:['先整理條件', '代回並化簡'], answer:'模型亂填答案',
        nextTime:'先標出變數與常數', marks:[{box:[.1,.2,.3,.4],label:'模型洩漏文字'}],
      } };
    };
    await paperReviewDetailed();
    const blockedCalls = calls;
    state.logs.push({ ts:1, direction:'我重新代入條件，但在第二行卡住。', topic:'num', concept:'條件整理' });
    state.attempts = 1;
    await paperReviewDetailed();
    const detail = state.aiDetail;
    paperReviewFinishDetailed();
    return {
      blockedCalls, calls, done:state.done, level:state.level, outcome:state.outcome,
      firstError:detail.firstError, solution:detail.solution,
      answer:detail.answer, official:paperFinalAnswerText(source.key[no - 1]),
      mark:detail.marks[0].label, unlocked:!!state.solutionUnlockedAt,
    };
  })()`));
  assert.equal(result.blockedCalls, 0);
  assert.equal(result.calls, 1);
  assert.equal(result.done, true);
  assert.equal(result.level, 3);
  assert.equal(result.outcome, 'ai-detail');
  assert.equal(result.firstError, '把變數 x 當成常數');
  assert.deepEqual(result.solution, ['先整理條件', '代回並化簡']);
  assert.equal(result.answer, result.official, '正式答案必須以本地答案鍵覆蓋模型文字');
  assert.equal(result.mark, '第一個錯誤');
  assert.equal(result.unlocked, true);
});

test('原版隔日頁面明確分成第一次簡批與第二次詳批按鈕，未重想前不解鎖', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    save = () => {}; sessionChrome = () => {}; paperReviewPaint = () => {}; rtAi = (value) => escH(String(value || ''));
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'detail-ui', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    paperReview = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, nos:[no], i:0, detailLoading:false, detailError:'' };
    renderPaperAnswerReview(); const locked = __app.innerHTML;
    state.attempts = 1; state.logs = [{ direction:'我重新整理條件後卡在代入。' }];
    renderPaperAnswerReview(); const unlocked = __app.innerHTML;
    state.aiDetail = { firstError:'第二行符號寫反', errorKind:'符號', read:'', explanation:'移項時變號錯誤', solution:['正確移項'], answer:'(2)', nextTime:'先圈負號', marks:[] };
    renderPaperAnswerReview(); const detailed = __app.innerHTML;
    return { locked, unlocked, detailed };
  })()`));
  assert.doesNotMatch(result.locked, /id="paper-detail-button"/);
  assert.match(result.unlocked, /第二次批改｜AI 找第一個錯誤並詳解/);
  assert.match(result.detailed, /第一個錯誤/);
  assert.match(result.detailed, /第二行符號寫反/);
  assert.match(result.detailed, /我已看懂並重算，列為第三級/);
  assert.doesNotMatch(result.detailed, /paper-review-direction/);
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

test('改判保存類題遷移欄位', () => {
  const { run } = loadApp();
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
    return { source: cal.source, acc: cal.acc };
  })()`));
  assert.equal(result.source, 'external');
  assert.equal(result.acc, 0.71);
});

test('原始 19 題卷保留練習價值，但不污染 20 題正式級分校準', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const practice = PAPER_SOURCES.find((source) => source.questions === 19);
    S.paperRuns = [{ id:'legacy-run', sourceId:practice.id }];
    S.extMocks = [
      { id:'formal', d:'2026-07-17', score:70, total:100, questions:20, calibrationEligible:true, ts:1 },
      { id:'practice', d:'2026-07-18', score:100, total:100, questions:19, calibrationEligible:false, ts:2 },
      { id:'legacy-practice', paperRunId:'legacy-run', sourceId:practice.id, d:'2026-07-16', score:100, total:100, ts:0 },
    ];
    const calibration = mockCalibration();
    return {
      practiceEligible:practice.calibrationEligible,
      reason:practice.practiceReason,
      count:calibration.count,
      acc:calibration.acc,
      card:paperSourceCardHTML(practice),
    };
  })()`));
  assert.equal(result.practiceEligible, false);
  assert.match(result.reason, /19 題/);
  assert.equal(result.count, 1);
  assert.equal(result.acc, 0.7);
  assert.match(result.card, /練習卷，不列入級分校準/);
});

test('原版模考隔日訂正會累積單元、卡點與老師逐題報告', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    typesetIn = () => {}; scrollQuestionTop = () => {}; rtAi = (value) => escH(String(value || ''));
    const source = PAPER_SOURCES[0];
    const questions = source.key.map((key, index) => ({
      no:index + 1, status:index === 0 ? 'incorrect' : 'correct',
      points:index === 0 ? 0 : key.points, read:index === 0 ? '(2)' : '正確', marks:[],
    }));
    const row = {
      id:'teacher-paper', sourceId:source.id, name:source.title, d:'2026-07-18',
      status:'completed', score:95, aiGrade:{ score:95, questions },
      review:{ 1:{ done:true, level:3, topic:'prob', errorKind:'條件翻譯不完整',
        aiErrorKind:'推理缺口', logs:[{ direction:'先縮小樣本空間', topic:'prob', concept:'條件機率', errorKind:'條件翻譯不完整' }],
        aiDetail:{ errorKind:'推理缺口', firstError:'分母仍使用原樣本空間', nextTime:'先重畫樣本空間' } } },
    };
    S.paperRuns = [row];
    const tags = paperRunRefreshLearningTags(row);
    renderPaperTeacherReport(row.id);
    return { tags, html:__app.innerHTML, card:paperLearningSummaryCard(), levels:paperRunLevelCounts(row) };
  })()`));
  assert.deepEqual(result.tags.topics, ['prob']);
  assert.deepEqual(result.tags.errors.sort(), ['推理缺口', '條件翻譯不完整'].sort());
  assert.deepEqual(result.levels, { l1:19, l2:0, l3:1, open:0 });
  assert.match(result.html, /老師檢視版/);
  assert.match(result.html, /先縮小樣本空間/);
  assert.match(result.html, /分母仍使用原樣本空間/);
  assert.match(result.card, /較常失分的單元/);
  assert.match(result.card, /條件翻譯不完整|推理缺口/);
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
