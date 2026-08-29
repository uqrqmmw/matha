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

test('長筆畫只把當前一筆寫入增量日誌，不在每次 checkpoint 重存整頁', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const writes = [];
    inkRecordPut = async (row) => { writes.push(row); return { ...row, updatedAt:Date.now() }; };
    paperSourceSession = {
      page:0, inkUserId:'user-1',
      run:{ id:'journal-run', sourceId:'paper-1', createdAt:10, paperInkClients:{ 0:'snapshot-0' } },
      source:{ id:'paper-1', scans:[{}] },
      inkPages:{ 0:{ s:Array.from({ length:3000 }, (_, i) => ({ id:'old-'+i, t0:i, pts:[[.1,.1,.5],[.2,.2,.5]] })), revision:0, dirty:false } },
      inkCurrent:{ id:'new-stroke', t0:9000, w:1, c:'black', pts:[[.3,.3,.5],[.4,.4,.5]] },
      inkCheckpointAt:0, journalPromises:new Set(), journalRetry:new Map(),
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    const checkpointed = paperInkCheckpointCurrent(10000);
    await paperInkJournalDrain();
    const page = paperInkPage();
    clearTimeout(paperInkCloudTimer);
    return {
      checkpointed, writes:writes.map((row) => ({
        event:row.proc.event, draft:row.proc.draft, count:row.strokes.s.length,
        id:row.strokes.s[0] && row.strokes.s[0].id,
      })),
      revision:page.revision, dirty:page.dirty,
    };
  })()`));
  assert.equal(result.checkpointed, true);
  assert.deepEqual(result.writes, [{ event:'stroke', draft:true, count:1, id:'new-stroke' }]);
  assert.equal(result.revision, 0);
  assert.equal(result.dirty, false);
});

test('同一筆的部分與完成日誌使用相同 client_id，完成版一定最後寫入', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const writes = [];
    inkRecordPut = async (row) => {
      writes.push({ clientId:row.client_id, draft:row.proc.draft, t1:row.strokes.s[0].t1, points:row.strokes.s[0].pts.length });
      return { ...row, updatedAt:Date.now() };
    };
    const stroke = { id:'stable-stroke', t0:100, w:1, c:'blue', pts:[[.1,.1,.5],[.2,.2,.5]] };
    paperSourceSession = {
      page:0, inkUserId:'user-1', source:{ id:'paper-1', scans:[{}] },
      run:{ id:'journal-final', sourceId:'paper-1', createdAt:1 },
      inkPages:{ 0:{ s:[], revision:0, dirty:false } },
      journalPromises:new Set(), journalRetry:new Map(),
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    paperInkJournalStroke(stroke, false);
    stroke.pts.push([.3,.3,.5]); stroke.t1 = 200;
    paperInkJournalStroke(stroke, true);
    await paperInkJournalDrain();
    clearTimeout(paperInkCloudTimer);
    return writes;
  })()`));
  assert.equal(result.length, 2);
  assert.equal(result[0].clientId, result[1].clientId);
  assert.equal(result[0].draft, true);
  assert.equal(result[1].draft, false);
  assert.equal(result[1].t1, 200);
  assert.equal(result[1].points, 3);
});

test('復原會立即寫入刪除墓碑，快照尚未執行也不會讓筆畫復活', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const writes = [];
    inkRecordPut = async (row) => { writes.push(row); return { ...row, updatedAt:Date.now() }; };
    paperSourceSession = {
      page:0, inkUserId:'user-1', source:{ id:'paper-1', scans:[{}] },
      run:{ id:'delete-run', sourceId:'paper-1', createdAt:1, paperInkClients:{ 0:'snapshot-0' } },
      inkClientIds:{ 0:'snapshot-0' },
      inkPages:{ 0:{ s:[{ id:'erase-me', t0:1, pts:[[.1,.1,.5],[.2,.2,.5]] }], revision:0, dirty:false } },
      journalPromises:new Set(), journalRetry:new Map(),
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    paperInkUndo();
    await paperInkJournalDrain();
    const out = {
      deleted:writes.filter((row) => row.proc.event === 'delete').flatMap((row) => row.strokes.deleted),
      dirty:paperInkPage().dirty,
      scheduled:paperInkSaveTimers.size,
    };
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return out;
  })()`));
  assert.deepEqual(result.deleted, ['erase-me']);
  assert.equal(result.dirty, true);
  assert.equal(result.scheduled, 1);
});

test('雲端補傳以一批 upsert，多筆成功後才從待同步集合移除', async () => {
  const { context, run } = loadApp();
  context.__pending = [1, 2, 3].map((n) => ({
    client_id:'event-'+n, qid:'paper:run:v2:0', t0:n, updatedAt:100+n,
    proc:{ event:'stroke' }, strokes:{ s:[], deleted:[] }, uploaded:false,
  }));
  const result = plain(await run(`(async () => {
    const calls = [];
    syncState.user = { id:'user-1' };
    supa = { from(){ return { async upsert(rows, options){ calls.push({ rows, options }); return { error:null }; } }; } };
    inkRecordPending = async () => __pending;
    inkRecordMarkUploaded = async () => true;
    refreshInkLocalStatus = async () => ({ total:3, pending:0 });
    syncPill = () => {};
    paperSourceSession = {
      run:{ id:'run' },
      durability:{ pendingClientIds:new Set(__pending.map((row) => row.client_id)), localError:false },
    };
    const ok = await flushInkQueue();
    return { ok, calls:calls.map((call) => ({ count:call.rows.length, array:Array.isArray(call.rows), conflict:call.options.onConflict })), pending:[...paperSourceSession.durability.pendingClientIds] };
  })()`));
  assert.equal(result.ok, true);
  assert.deepEqual(result.calls, [{ count:3, array:true, conflict:'user_id,client_id' }]);
  assert.deepEqual(result.pending, []);
});

test('雲端原卷日誌超過一千筆時會分頁全部載回，不被 Supabase 預設上限截斷', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const ranges = [];
    syncState.user = { id:'user-1' };
    supa = {
      from(){
        return {
          start:0,
          select(){ return this; },
          like(){ return this; },
          order(){ return this; },
          range(from, to){ this.start = from; ranges.push([from, to]); return this; },
          then(resolve){
            const count = this.start === 0 ? PAPER_INK_CLOUD_PAGE_SIZE : 2;
            resolve({ data:Array.from({ length:count }, (_, i) => ({ client_id:'c-'+(this.start+i), qid:'paper:large:v2:0' })), error:null });
          },
        };
      },
    };
    const rows = await paperInkCloudRows('large');
    return { count:rows.length, ranges };
  })()`));
  assert.equal(result.count, 1002);
  assert.deepEqual(result.ranges, [[0, 999], [1000, 1999]]);
});

test('雲端回報較舊版本成功時，不得把剛完成的新版本誤標成已上傳', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    let row = { client_id:'same-stroke', updatedAt:101, uploaded:false, upload_state:'pending' };
    const database = {
      transaction(){
        let tx;
        const store = {
          get(){
            const request = { result:row };
            Promise.resolve().then(() => {
              request.onsuccess();
              Promise.resolve().then(() => tx.oncomplete());
            });
            return request;
          },
          put(next){ row = next; },
        };
        tx = { error:null, objectStore(){ return store; } };
        return tx;
      },
    };
    _idb = database;
    const stale = await inkRecordMarkUploaded('same-stroke', 100, 'user-1');
    const afterStale = { uploaded:row.uploaded, state:row.upload_state, updatedAt:row.updatedAt };
    const current = await inkRecordMarkUploaded('same-stroke', 101, 'user-1');
    return { stale, afterStale, current, uploaded:row.uploaded, state:row.upload_state, updatedAt:row.updatedAt };
  })()`));
  assert.deepEqual(result, {
    stale:false,
    afterStale:{ uploaded:false, state:'pending', updatedAt:101 },
    current:true,
    uploaded:true,
    state:'uploaded',
    updatedAt:101,
  });
});

test('增量日誌本機寫入失敗會保留最新事件並重試，成功前不顯示安全', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    let attempts = 0;
    inkRecordPut = async (row) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary quota');
      return { ...row, updatedAt:Date.now() };
    };
    const session = {
      run:{ id:'retry-run' }, source:{ id:'paper-1', scans:[{}] },
      journalRetry:new Map(), journalPromises:new Set(),
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    paperSourceSession = session;
    const record = {
      client_id:'retry-event', qid:'paper:retry-run:v2:0', t0:1,
      proc:{ event:'stroke' }, strokes:{ s:[{ id:'s', pts:[[0,0],[1,1]] }], deleted:[] }, uploaded:false,
    };
    const first = await paperInkJournalRecord(record, session);
    const failed = { first, retry:session.journalRetry.size, localError:session.durability.localError };
    clearTimeout(session.journalRetryTimer); session.journalRetryTimer = null;
    const second = await paperInkJournalRetryNow(session);
    clearTimeout(paperInkCloudTimer);
    return { failed, second, retry:session.journalRetry.size, localError:session.durability.localError, pending:[...session.durability.pendingClientIds], attempts };
  })()`));
  assert.deepEqual(result, {
    failed:{ first:false, retry:1, localError:true },
    second:true,
    retry:0,
    localError:false,
    pending:['retry-event'],
    attempts:2,
  });
});

test('當機後用最後心跳凍結剩餘時間與頁碼，不把離線時間扣掉', () => {
  const { context, run } = loadApp();
  const now = Date.now();
  context.__run = {
    id:'crash-run', sourceId:'paper-1', status:'active',
    remainingMs:600000, resumeAt:now - 300000, paperPage:0,
  };
  context.localStorage.setItem(
    'mathA13_anonymous_v1:paper-recovery:crash-run',
    JSON.stringify({ version:1, runId:'crash-run', sourceId:'paper-1', remainingMs:555000, page:4, updatedAt:now - 10000, closed:false }),
  );
  const result = plain(run(`(() => {
    const recovery = paperRecoveryApply(__run);
    return { recovery:!!recovery, remainingMs:__run.remainingMs, page:__run.paperPage, status:__run.status, resumeAt:__run.resumeAt };
  })()`));
  assert.deepEqual(result, { recovery:true, remainingMs:555000, page:4, status:'paused', resumeAt:null });
});

test('保存狀態明確區分本機待補傳、已同步與本機失敗', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    paperSourceSession = { durability:{ pendingClientIds:new Set(['a','b']), localAt:1, cloudAt:null, localError:false } };
    const pending = paperInkStatusText();
    paperSourceSession.durability.pendingClientIds.clear();
    paperSourceSession.durability.cloudAt = 2;
    const synced = paperInkStatusText();
    paperSourceSession.durability.localError = true;
    const failed = paperInkStatusText();
    return { pending, synced, failed };
  })()`));
  assert.match(result.pending, /本機|雲端同步中/);
  assert.equal(result.synced, '本機與雲端已同步');
  assert.match(result.failed, /本機保存失敗/);
});

test('救援檔含本回所有增量紀錄、恢復資訊與版本識別', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /kind:\s*'matha-paper-rescue-v1'/);
  assert.match(source, /records,\s*\n\s*runtimeAudit:session\.run\.runtimeAudit \|\| null,\s*\n\s*\};/);
  assert.match(source, /paperRecoveryRows\(session\)/);
  assert.match(source, /id="paper-ink-status"[^>]+paperRecoveryOpen\(\)/);
});

test('真機驗收用實際翻頁 P95、落筆保存、100 分鐘、恢復與 PDF 證據判定', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = paperSourceById('paper-mock-3');
    const audit = {
      schema:PAPER_RUNTIME_AUDIT_SCHEMA, appVersion:APP_VER, runId:'audit-pass', sourceId:source.id,
      activeElapsedMs:source.minutes * 60000, sessions:2, crashRecoveries:1, pdfPreparedAt:Date.now(),
      pageSwitches:[100, 180, 220, 430].map((ms, index) => ({ from:index % 2, to:(index + 1) % 2, ms })),
      localSaveMs:[25, 80, 130, 850], localSaveFailures:0,
      maxSingleCanvasPixels:PAPER_CANVAS_MAX_PIXELS, maxLiveCanvasCount:2,
      samples:[100, 122, 131].map((mb) => ({ heapBytes:mb * 1048576 })), maxHeapBytes:131 * 1048576,
    };
    const passing = paperRuntimeAuditSummary({ id:'audit-pass', sourceId:source.id, runtimeAudit:audit });
    const failing = paperRuntimeAuditSummary({ id:'audit-fail', sourceId:source.id, runtimeAudit:{
      ...audit, runId:'audit-fail', pageSwitches:[100, 180, 220, 720].map((ms) => ({ ms })),
      localSaveMs:[25, 2400], localSaveFailures:1,
    } });
    return {
      pass:passing.passed,
      pageP95:passing.pageP95Ms,
      saveP95:passing.localSaveP95Ms,
      statuses:Object.fromEntries(passing.checks.map((row) => [row.id, row.status])),
      failed:failing.passed,
      failedStatuses:Object.fromEntries(failing.checks.map((row) => [row.id, row.status])),
    };
  })()`));
  assert.equal(result.pass, true);
  assert.equal(result.pageP95, 430);
  assert.equal(result.saveP95, 850);
  assert.deepEqual(result.statuses, {
    duration:'pass', page:'pass', save:'pass', canvas:'pass', resume:'pass', pdf:'pass', memory:'pass',
  });
  assert.equal(result.failed, false);
  assert.equal(result.failedStatuses.page, 'fail');
  assert.equal(result.failedStatuses.save, 'fail');
});

test('真機量測事件與樣本都有固定上限，換 app 版本也不會清掉同一回證據', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const runRow = { id:'bounded-audit', sourceId:'paper-mock-3', remainingMs:6000000, runtimeAudit:{
      schema:PAPER_RUNTIME_AUDIT_SCHEMA, appVersion:'older-version', runId:'bounded-audit', sourceId:'paper-mock-3',
      pageSwitches:[], localSaveMs:[], cloudSyncMs:[], samples:[],
    } };
    const session = { run:runRow, source:paperSourceById('paper-mock-3'), durability:{ pendingClientIds:new Set() } };
    const same = paperRuntimeAuditFor(session);
    for (let i = 0; i < 400; i++) paperRuntimeAuditPush(same.pageSwitches, { ms:i });
    for (let i = 0; i < 300; i++) paperRuntimeAuditPush(same.samples, { at:i }, PAPER_RUNTIME_AUDIT_SAMPLE_CAP);
    return {
      sameObject:same === runRow.runtimeAudit,
      originalVersion:same.appVersion,
      lastVersion:same.lastAppVersion,
      events:same.pageSwitches.length,
      firstEvent:same.pageSwitches[0].ms,
      samples:same.samples.length,
      firstSample:same.samples[0].at,
    };
  })()`));
  assert.deepEqual(result, {
    sameObject:true,
    originalVersion:'older-version',
    lastVersion:'0829u',
    events:240,
    firstEvent:160,
    samples:220,
    firstSample:80,
  });
});

test('真機驗收只量完成筆畫的本機保存時間，重試失敗依 client_id 去重', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const session = {
      run:{ id:'save-audit', sourceId:'paper-mock-3', remainingMs:5000000 },
      source:paperSourceById('paper-mock-3'), durability:{ pendingClientIds:new Set() },
    };
    const committedAt = Date.now() - 320;
    const draft = { client_id:'draft', proc:{ draft:true, committedAt }, strokes:{} };
    const final = { client_id:'final', proc:{ draft:false, committedAt }, strokes:{} };
    paperRuntimeAuditLocalStored(draft, session);
    paperRuntimeAuditLocalStored(final, session);
    paperRuntimeAuditLocalFailure(final, session);
    paperRuntimeAuditLocalFailure(final, session);
    return {
      latencies:session.run.runtimeAudit.localSaveMs,
      failures:session.run.runtimeAudit.localSaveFailures,
      pending:[...session.auditCloudPending.keys()],
    };
  })()`));
  assert.equal(result.latencies.length, 1);
  assert.ok(result.latencies[0] >= 300 && result.latencies[0] < 1000);
  assert.equal(result.failures, 1);
  assert.deepEqual(result.pending, ['final']);
});

test('第一次批改頁可把真機驗收報告同步到私有雲端並匯出本機備份', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /paperRuntimeAuditOpen\('\$\{jsA\(run\.id\)\}'\)/);
  assert.match(source, /kind:'matha-paper-runtime-audit-v1'/);
  assert.match(source, /getHighEntropyValues\(\['model'\]\)/);
  assert.match(source, /attestation = \{ confirmed:true, model:'Samsung Galaxy Tab S10 Ultra', source:'user-confirmation', confirmedAt, browserReportedModel \}/);
  assert.match(source, /responseType:'paper_audit_archive'[^]*paperRunId:run\.id/);
  assert.match(source, /同步並匯出驗收檔/);
  assert.match(source, /paperRuntimeAuditSample\(\);[\s\S]*paperRecoveryHeartbeat\(\)/);
});

test('真機驗收封存由後端重讀雲端狀態且不經 OpenAI 金鑰或模型', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/index.ts'), 'utf8');
  const branch = edge.indexOf('if (responseType === "paper_audit_archive")');
  const keyLookup = edge.indexOf('const apiKey = Deno.env.get("OPENAI_API_KEY")');
  assert.ok(branch > 0 && keyLookup > branch, '驗收封存必須在 OpenAI 金鑰與模型路徑之前完成');
  assert.match(edge, /const data = await loadAppState\(userId\);[\s\S]*paperRuntimeAuditEvidence\(data, runId\)/);
  assert.match(edge, /PAPER_AUDIT_BUCKET = "matha-content"/);
});
