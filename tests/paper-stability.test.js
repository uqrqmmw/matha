'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('原卷 Canvas 在 400% 與高 DPR 下仍受 12MP backing-store 上限保護', () => {
  const { context, run } = loadApp();
  context.devicePixelRatio = 2;
  const result = plain(run(`(() => {
    const width = 1480 * 4, height = Math.round(width * 2535 / 2112);
    const scale = paperCanvasBackingScale(width, height);
    return {
      scale,
      pixels:Math.round(width * scale) * Math.round(height * scale),
      limit:PAPER_CANVAS_MAX_PIXELS,
      normal:paperCanvasBackingScale(1480, Math.round(1480 * 2535 / 2112)),
    };
  })()`));
  assert.ok(result.pixels <= result.limit * 1.001);
  assert.equal(result.limit, 12_000_000);
  assert.equal(result.normal, 2);
  assert.ok(result.scale < 1);
});

test('落筆移動只追加新線段，不再清空並重畫整頁歷史', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const calls = { clear:0, line:0, stroke:0 };
    const ctx = {
      setTransform(){}, clearRect(){ calls.clear++; }, beginPath(){}, moveTo(){},
      lineTo(){ calls.line++; }, stroke(){ calls.stroke++; },
      set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, set lineWidth(v){},
    };
    const canvas = {
      clientWidth:1000, clientHeight:1200, width:1000, height:1200, dataset:{},
      setPointerCapture(){}, closest(){ return null; }, getContext(){ return ctx; },
      getBoundingClientRect(){ return { left:0, top:0, width:1000, height:1200 }; },
    };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas : null;
    const old = Array.from({ length:2500 }, (_, i) => ({
      t0:i, w:1, c:'black', pts:[[.8, i / 5000, .5],[.9, i / 5000, .5]],
    }));
    paperSourceSession = {
      inkMode:'pen', inkWidth:1, inkColor:'black', page:0,
      run:{ id:'incremental', createdAt:1, paperInkClients:{} },
      inkPages:{ 0:{ s:old, loaded:true, revision:0, dirty:false } },
    };
    const event = (type, x) => ({
      type, pointerType:'pen', pointerId:7, button:type === 'pointerdown' ? 0 : -1,
      buttons:type === 'pointerup' ? 0 : 1, pressure:type === 'pointerup' ? 0 : .5,
      clientX:x, clientY:500, currentTarget:canvas, preventDefault(){},
    });
    paperInkDown(event('pointerdown', 100));
    paperInkMove(event('pointermove', 160));
    const during = { ...calls, current:paperSourceSession.inkCurrent.pts.length };
    paperInkUp(event('pointerup', 160));
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return { during, saved:paperInkPage().s.length };
  })()`));
  assert.equal(result.during.clear, 0);
  assert.equal(result.during.line, 1);
  assert.equal(result.during.stroke, 1);
  assert.equal(result.during.current, 2);
  assert.equal(result.saved, 2501);
});

test('橡皮擦用空間索引縮小候選，不再逐點掃描整頁', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    let distanceCalls = 0;
    const originalDistance = inkPointSegmentDistance;
    inkPointSegmentDistance = (...args) => { distanceCalls++; return originalDistance(...args); };
    const ctx = {
      setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
      save(){}, restore(){}, rect(){}, clip(){},
      set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, set lineWidth(v){},
    };
    const canvas = {
      clientWidth:1000, clientHeight:1000, width:1000, height:1000,
      getContext(){ return ctx; },
      getBoundingClientRect(){ return { left:0, top:0, width:1000, height:1000 }; },
    };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas : null;
    const far = Array.from({ length:4000 }, (_, i) => ({
      t0:i, w:1, c:'black', pts:[[.88, .05 + (i % 800) / 1000, .5],[.92, .05 + (i % 800) / 1000, .5]],
    }));
    const near = { t0:9000, w:1, c:'black', pts:[[.48,.5,.5],[.52,.5,.5]] };
    paperSourceSession = {
      page:0, run:{ id:'eraser-index', createdAt:1, paperInkClients:{} },
      inkPages:{ 0:{ s:[...far, near], loaded:true, revision:0, dirty:false } },
    };
    const erased = paperInkEraseAt({ clientX:500, clientY:500, pressure:.5 }, canvas);
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return { erased, dead:!!near.dead, distanceCalls };
  })()`));
  assert.equal(result.erased, true);
  assert.equal(result.dead, true);
  assert.ok(result.distanceCalls < 20, `只應檢查附近筆畫，實際 ${result.distanceCalls} 次`);
});

test('IndexedDB 寫入失敗時保留 dirty 並排程重試，不會假裝已保存', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    inkRecordPut = async () => { throw new Error('quota'); };
    document.querySelector = () => null;
    paperSourceSession = {
      page:0, run:{ id:'persist-fail', createdAt:1, paperInkClients:{ 0:'client-0' } },
      inkPages:{ 0:{ s:[{ t0:1, pts:[[.1,.1,.5],[.2,.2,.5]] }], loaded:true, revision:1, dirty:true } },
    };
    const ok = await paperInkPersist(true);
    const page = paperInkPage();
    const out = { ok, dirty:page.dirty, revision:page.revision, persistPromise:!!page.persistPromise, retry:paperInkSaveTimers.size > 0 };
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return out;
  })()`));
  assert.deepEqual(result, { ok:false, dirty:true, revision:1, persistPromise:false, retry:true });
});

test('連續保存失敗超過三次仍持續退避重試，不會永久停擺', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const page = { s:[], loaded:true, revision:9, dirty:true, persistFailures:7 };
    paperSourceSession = { page:0, inkPages:{ 0:page } };
    paperInkScheduleRetry(0, page);
    const scheduled = paperInkSaveTimers.size > 0;
    paperInkSaveTimersClearAll();
    return { scheduled, failures:page.persistFailures };
  })()`));
  assert.deepEqual(result, { scheduled:true, failures:7 });
});

test('不同頁各自排程保存；前頁寫入失敗不會被後頁計時器吃掉', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    document.querySelector = () => null;
    const page0 = { s:[{ t0:1, pts:[[.1,.1,.5],[.2,.2,.5]] }], loaded:true, revision:1, dirty:true };
    const page1 = { s:[{ t0:2, pts:[[.3,.3,.5],[.4,.4,.5]] }], loaded:true, revision:1, dirty:true };
    paperSourceSession = {
      page:0, inkUserId:'user-1',
      run:{ id:'two-page-retry', createdAt:10, paperInkClients:{ 0:'client-0', 1:'client-1' } },
      inkClientIds:{ 0:'client-0', 1:'client-1' },
      inkPages:{ 0:page0, 1:page1 },
    };
    inkRecordPut = async (row) => {
      if (row.proc.page === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('page 0 quota');
      }
      return row;
    };
    const first = paperInkPersist(true);
    paperSourceSession.page = 1;
    paperInkPersist(false);
    await first;
    const out = {
      keys:[...paperInkSaveTimers.keys()].sort(),
      page0Dirty:page0.dirty,
      page0Failures:page0.persistFailures,
      page1Dirty:page1.dirty,
    };
    paperInkSaveTimersClearAll();
    clearTimeout(paperInkCloudTimer);
    return out;
  })()`));
  assert.deepEqual(result.keys, ['two-page-retry:0', 'two-page-retry:1']);
  assert.equal(result.page0Dirty, true);
  assert.equal(result.page0Failures, 1);
  assert.equal(result.page1Dirty, true);
});

test('私人內容的本機索引含帳號 scope', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /contentLocalStorageKey\(\)/);
  assert.match(source, /st\.put\(packs\[k\], prefix \+ k\)/);
  assert.match(source, /KEY = storedActiveUserId\(\) \? userStateKey\(storedActiveUserId\(\)\) : ANONYMOUS_KEY/);
});

test('儲存途中又落筆會接著寫入新 revision，且死筆畫會被壓縮', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const writes = [];
    document.querySelector = () => null;
    paperSourceSession = {
      page:0, run:{ id:'persist-race', createdAt:1, paperInkClients:{ 0:'client-0' } },
      inkPages:{ 0:{ s:[
        { t0:1, pts:[[.1,.1,.5],[.2,.2,.5]] },
        { t0:2, dead:2, pts:[[.3,.3,.5],[.4,.4,.5]] },
      ], loaded:true, revision:1, dirty:true } },
    };
    inkRecordPut = async (row) => {
      writes.push({ revision:row.strokes.revision, count:row.strokes.s.length });
      if (writes.length === 1) paperInkMarkDirty();
      return row;
    };
    const ok = await paperInkPersist(true);
    const page = paperInkPage();
    const out = { ok, writes, dirty:page.dirty, persisted:page.persistedRevision, live:page.s.length };
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return out;
  })()`));
  assert.equal(result.ok, true);
  assert.deepEqual(result.writes, [{ revision:1, count:1 }, { revision:2, count:1 }]);
  assert.equal(result.dirty, false);
  assert.equal(result.persisted, 2);
  assert.equal(result.live, 1);
});

test('批改卷合成會把原掃描、學生筆跡與 AI 紅筆放進同一頁', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const calls = { scan:0, ink:0, red:0, merged:0 };
    const ctx = {
      fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
      drawImage(image){ if (image && image.red) calls.merged++; else calls.scan++; },
      set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){}, set filter(v){},
    };
    document.createElement = (tag) => {
      if (tag !== 'canvas') return {};
      return {
        width:0, height:0, getContext(){ return ctx; },
        toDataURL(){ return 'data:image/jpeg;base64,graded-page'; },
      };
    };
    paperImageLoad = async () => ({ naturalWidth:2000, naturalHeight:1200 });
    paperInkLine = () => { calls.ink++; };
    paperAiPaintCanvas = (canvas) => { calls.red++; canvas.red = true; };
    const source = { scans:[{ side:'left' }] };
    const out = await paperCompositeImage(source, ['scan'], { 0:{ s:[{ pts:[[0,0],[1,1]] }] } }, 0, true);
    return { calls, out };
  })()`));
  assert.deepEqual(result, {
    calls:{ scan:1, ink:1, red:1, merged:1 },
    out:'graded-page',
  });
});

test('第一次批改結果提供內建 PDF 匯出入口', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /id="paper-export-pdf"[^>]+onclick="paperExportGradedPdf\(\)"/);
  assert.match(source, /paperCompositeImage\(source, urls, inkPages, page, true\)/);
  assert.match(source, /printWindow\.print\(\)/);
});

test('兩台裝置的原卷筆畫採聯集，任一裝置的刪除墓碑都不會被復活', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const stroke = (id, x) => ({ id, t0:x * 100, t1:x * 100 + 1, c:'black', w:1, pts:[[x,.1,.5],[x,.2,.5]] });
    const a = { paper:true, s:[stroke('shared',.1), stroke('only-a',.2)], deleted:[] };
    const b = { paper:true, s:[stroke('shared',.1), stroke('only-b',.3)], deleted:['only-a'] };
    return paperInkMergePayloads([a, b]);
  })()`));
  assert.deepEqual(result.s.map((stroke) => stroke.id), ['shared', 'only-b']);
  assert.deepEqual(result.deleted, ['only-a']);
});

test('原卷每台裝置使用不同 client_id，同一頁不再 whole-row 互相覆寫', () => {
  const a = loadApp(), b = loadApp();
  a.context.localStorage.setItem('mathA13_paper_device_v1', 'tablet-a');
  b.context.localStorage.setItem('mathA13_paper_device_v1', 'desktop-b');
  const left = a.run(`paperInkClientFor({ id:'paper-run-1' }, 2)`);
  const right = b.run(`paperInkClientFor({ id:'paper-run-1' }, 2)`);
  assert.equal(left, 'ink-paper-paper-run-1-2-tablet-a');
  assert.equal(right, 'ink-paper-paper-run-1-2-desktop-b');
  assert.notEqual(left, right);
});
