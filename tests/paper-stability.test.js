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

test('交卷、暫停與救援使用的全頁快照會連空白頁一起寫入且綁定各自 qid', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const records = [];
    inkRecordPut = async (row) => { records.push(row); return { ...row, updatedAt:Date.now() }; };
    const session = {
      source:{ id:'paper-all-pages', scans:[{},{},{}] },
      run:{ id:'all-pages', sourceId:'paper-all-pages', createdAt:1000, paperLayoutVersion:PAPER_LAYOUT_VERSION },
      inkPages:{ 1:{ s:[{ id:'one', t0:10, t1:11, w:1, c:'black', pts:[[0,0,.5],[1,1,.5]] }], deleted:new Set(), loaded:true, revision:1, persistedRevision:0, dirty:true } },
      inkClientIds:{}, journalPromises:new Set(), journalRetry:new Map(),
      durability:{ pendingClientIds:new Set(), localError:false, cloudError:false },
    };
    paperSourceSession = session;
    const ok = await paperInkPersistAll(true, session);
    clearTimeout(paperInkCloudTimer);
    return { ok, count:records.length, qids:records.map((row) => row.qid),
      t0s:records.map((row) => row.t0), strokes:records.map((row) => row.strokes.s.length),
      pages:Object.keys(session.inkPages).map(Number).sort((a,b) => a-b) };
  })()`));
  assert.deepEqual(result, {
    ok:true, count:3,
    qids:['paper:all-pages:v2:0','paper:all-pages:v2:1','paper:all-pages:v2:2'],
    t0s:[1000,1001,1002], strokes:[0,1,0], pages:[0,1,2],
  });
});

test('交卷狀態未知時維持鎖定；晚到 accepted 收據只用同一 attemptId 繼續一次', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    let rendered = 0, aiCalled = false, afterSubmit = 0, settleCalls = 0, firstAttemptId = '';
    const now = 1700000000000; Date.now = () => now;
    const root = { innerHTML:'' };
    document.body = { classList:{ toggle(){} } };
    document.querySelector = (selector) => selector === '#app' ? root : null;
    const source = { id:'paper-timeout', title:'逾時測試卷', minutes:100, scans:[{},{}] };
    const row = { id:'paper-run-1700000000000', sourceId:source.id, status:'active', createdAt:1,
      remainingMs:6000000, resumeAt:now - 4800000,
      paperLayoutVersion:PAPER_LAYOUT_VERSION, runtimeAudit:{ schema:PAPER_RUNTIME_AUDIT_SCHEMA,
        appVersion:APP_VER, runId:'paper-run-1700000000000', sourceId:source.id, activeElapsedMs:4800000 } };
    const session = { source, run:row, grading:false, submitLocked:false,
      inkPages:{ 0:{revision:1,persistedRevision:1,dirty:false}, 1:{revision:0,persistedRevision:0,dirty:false} },
      durability:{ pendingClientIds:new Set() } };
    paperSourceSession = session; sessionMode = 'paper-source';
    stopTicker = () => {}; paperInkCommitCurrent = () => {};
    paperInkJournalDrain = async () => true; paperInkPersistAll = async () => true;
    paperInkCloudFlushBarrier = async () => true; paperInkPendingCount = () => 0;
    paperInkCloudReadbackVerify = async () => ({ passed:true, readbackVerifiedAt:Date.now(), verifiedPages:2,
      pages:[0,1].map((page) => ({ page, qid:'paper:' + row.id + ':v' + PAPER_LAYOUT_VERSION + ':' + page,
        clientId:'c' + page, localSha256:'a'.repeat(64), cloudSha256:'a'.repeat(64), matched:true })) });
    renderPaperSource = () => { rendered++; }; alert = () => {};
    paperAiGradeCall = async () => { aiCalled = true; return {}; };
    paperSubmitAttemptSettle = async (attempt) => {
      settleCalls++; firstAttemptId ||= attempt.attemptId;
      if (settleCalls === 1) return { outcome:'unknown', row:null };
      return { outcome:'accepted', row:{ ...attempt, status:'accepted', acceptedAt:now + 1, updatedAt:now + 1 } };
    };
    paperSourceGradeAfterSubmit = async () => { afterSubmit++; return true; };
    const completed = await paperSourceGrade('完成作答');
    const ambiguous = { completed, mode:sessionMode, status:row.status, submittedAt:row.submittedAt || null,
      grading:session.grading, locked:session.submitLocked, rendered, aiCalled,
      remaining:row.remainingMs, attemptId:row.submitAttempt && row.submitAttempt.attemptId,
      hasReconcile:root.innerHTML.includes('重新確認交卷狀態') };
    const reconciled = await paperSourceSubmitReconcile();
    return { ambiguous, reconciled, finalStatus:row.status, finalAttemptId:row.submitAttempt.attemptId,
      settleCalls, afterSubmit, finalRemaining:row.remainingMs, firstAttemptId };
  })()`));
  assert.equal(result.ambiguous.completed, false);
  assert.equal(result.ambiguous.mode, 'paper-submit-reconcile');
  assert.equal(result.ambiguous.status, 'active');
  assert.equal(result.ambiguous.grading, true);
  assert.equal(result.ambiguous.locked, true);
  assert.equal(result.ambiguous.rendered, 0);
  assert.equal(result.ambiguous.aiCalled, false);
  assert.equal(result.ambiguous.hasReconcile, true);
  assert.equal(result.ambiguous.remaining, 1200000, '不確定期間不得繼續扣考試時間');
  assert.equal(result.reconciled, true);
  assert.equal(result.finalStatus, 'grading');
  assert.equal(result.finalAttemptId, result.firstAttemptId, '重試只能沿用同一 attemptId');
  assert.equal(result.settleCalls, 2);
  assert.equal(result.afterSubmit, 1, '晚到 accepted 只可進批改一次');
  assert.equal(result.finalRemaining, 1200000);
});

test('server 明確 canceled 後才恢復原卷，且不把交卷等待時間重複扣除', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const now = 1700000000000; Date.now = () => now;
    const root = { innerHTML:'' };
    document.body = { classList:{ toggle(){} } };
    document.querySelector = (selector) => selector === '#app' ? root : null;
    const source = { id:'paper-canceled', title:'取消測試卷', minutes:100, scans:[{}] };
    const row = { id:'paper-run-1700000000002', sourceId:source.id, status:'active', createdAt:1,
      runCreatedAppVersion:APP_VER, remainingMs:6000000, resumeAt:now - 4800000,
      paperLayoutVersion:PAPER_LAYOUT_VERSION, runtimeAudit:{ schema:PAPER_RUNTIME_AUDIT_SCHEMA,
        appVersion:APP_VER, runId:'paper-run-1700000000002', sourceId:source.id, activeElapsedMs:4800000 } };
    const session = { source, run:row, grading:false, submitLocked:false,
      inkPages:{ 0:{revision:1,persistedRevision:1,dirty:false} }, durability:{ pendingClientIds:new Set() } };
    paperSourceSession = session; sessionMode = 'paper-source';
    stopTicker = () => {}; paperInkCommitCurrent = () => {};
    paperInkJournalDrain = async () => true; paperInkPersistAll = async () => true;
    paperInkCloudFlushBarrier = async () => true; paperInkPendingCount = () => 0;
    paperInkCloudReadbackVerify = async () => ({ passed:true, readbackVerifiedAt:now, verifiedPages:1,
      pages:[{ page:0, qid:'paper:' + row.id + ':v' + PAPER_LAYOUT_VERSION + ':0', clientId:'c0',
        localSha256:'a'.repeat(64), cloudSha256:'a'.repeat(64), matched:true }] });
    let rendered = 0; renderPaperSource = () => { rendered++; }; alert = () => {};
    paperSubmitAttemptSettle = async (attempt) => ({ outcome:'canceled', row:{
      ...attempt, status:'canceled', decisionReason:'client-canceled-before-accept',
      canceledAt:now + 1, updatedAt:now + 1,
    } });
    const completed = await paperSourceGrade('完成作答');
    return { completed, mode:sessionMode, status:row.status, grading:session.grading,
      locked:session.submitLocked, rendered, remaining:paperRunLeft(row), resumeAt:row.resumeAt,
      attemptStatus:row.submitAttempt.status };
  })()`));
  assert.deepEqual(result, {
    completed:false, mode:'paper-source', status:'active', grading:false, locked:false,
    rendered:1, remaining:1200000, resumeAt:1700000000000, attemptStatus:'canceled',
  });
});

test('另一裝置已 accepted 時 loser 採 winner 收據保持鎖定，絕不恢復作答', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const now = 1700000000000; Date.now = () => now;
    const root = { innerHTML:'' };
    document.body = { classList:{ toggle(){} } };
    document.querySelector = (selector) => selector === '#app' ? root : null;
    const source = { id:'paper-two-device', title:'雙裝置測試卷', scans:[{}] };
    const local = {
      schema:PAPER_SUBMIT_ATTEMPT_SCHEMA,
      attemptId:'paper-submit-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       runId:'paper-run-1700000000003', sourceId:source.id, status:'reconciling',
      remainingMs:500000, inkSnapshotSha256:'b'.repeat(64), submittedAt:now,
      runCreatedAppVersion:APP_VER, createdAt:now, updatedAt:now,
      runCreatedAt:now - 1000, paperLayoutVersion:PAPER_LAYOUT_VERSION, sourcePageCount:1,
    };
    const winner = {
      attempt_id:'paper-submit-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      run_id:local.runId, source_id:source.id, status:'accepted', remaining_ms:510000,
      ink_snapshot_sha256:'a'.repeat(64), submitted_at:now - 1,
      accepted_at:new Date(now + 1).toISOString(), canceled_at:null,
       run_created_app_version:APP_VER, decision_reason:'accepted-first-for-run',
       run_created_at:now - 1000, paper_layout_version:PAPER_LAYOUT_VERSION, source_page_count:1,
       winner_attempt_id:null, winner:null,
       page_manifest:[{ page:0, qid:'paper:' + local.runId + ':v' + PAPER_LAYOUT_VERSION + ':0',
         clientId:'winner-client-0', revision:1, cloudSha256:'a'.repeat(64),
         updatedAt:'2026-08-30T00:00:00.000Z' }],
    };
    const loser = {
      attempt_id:local.attemptId, run_id:local.runId, source_id:source.id,
      status:'canceled', remaining_ms:local.remainingMs,
      ink_snapshot_sha256:local.inkSnapshotSha256, submitted_at:local.submittedAt,
      accepted_at:null, canceled_at:new Date(now + 2).toISOString(),
      run_created_app_version:APP_VER, decision_reason:'superseded-by-accepted-attempt',
      winner_attempt_id:winner.attempt_id, winner,
    };
    const row = { id:local.runId, sourceId:source.id, status:'active', remainingMs:local.remainingMs,
      resumeAt:now, submitAttempt:{ ...local }, submitAttemptHistory:[{ ...local }],
      submitRollback:{ status:'active', wasRunning:true, remainingAtSubmit:local.remainingMs }, mt:now };
    const session = { source, run:row, grading:false, submitLocked:true };
    paperSourceSession = session; sessionMode = 'paper-submit-reconcile';
    syncState.user = { id:'user-1' }; supa = {}; syncPush = async () => {};
    paperSubmitAttemptRpc = async () => paperSubmitAttemptRow(loser);
    let afterSubmit = 0, rendered = 0;
    paperSourceGradeAfterSubmit = async () => { afterSubmit++; return true; };
    renderPaperSource = () => { rendered++; };
    const settled = await paperSubmitAttemptSettle(local);
    const cloudMerged = mergePaperRunRecord(
      { id:local.runId, sourceId:source.id, status:'active', mt:now, submitAttempt:paperSubmitAttemptRow(loser) },
      { id:local.runId, sourceId:source.id, status:'paused', mt:now + 1 }
    );
    const completed = await paperSourceSubmitReconcile();
    return { outcome:settled.outcome, completed, status:row.status, locked:session.submitLocked,
      grading:session.grading, current:row.submitAttempt, history:row.submitAttemptHistory,
      rollback:row.submitRollback || null, rendered, afterSubmit,
      mergeStatus:cloudMerged.status, mergeAttempt:cloudMerged.submitAttempt };
  })()`));
  assert.equal(result.outcome, 'superseded');
  assert.equal(result.completed, true);
  assert.equal(result.status, 'grading');
  assert.equal(result.locked, true);
  assert.equal(result.grading, true);
  assert.equal(result.current.status, 'accepted');
  assert.equal(result.current.attemptId, 'paper-submit-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(result.history.some((row) => row.decisionReason === 'superseded-by-accepted-attempt'), true);
  assert.equal(result.rollback, null);
  assert.equal(result.rendered, 0);
  assert.equal(result.afterSubmit, 1);
  assert.equal(result.mergeStatus, 'grading');
  assert.equal(result.mergeAttempt.status, 'accepted');
  assert.equal(result.mergeAttempt.attemptId, 'paper-submit-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('accepted 後必須等待 app_state 雲端寫入與回讀，期間不啟動答案或批改', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const now = 1700000000000; Date.now = () => now;
    const source = { id:'paper-durable-submit', title:'延遲同步測試卷', scans:[{}] };
    const accepted = {
      schema:PAPER_SUBMIT_ATTEMPT_SCHEMA,
      attemptId:'paper-submit-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId:'paper-run-1700000000004', sourceId:source.id, status:'accepted', remainingMs:400000,
      inkSnapshotSha256:'c'.repeat(64), submittedAt:now, acceptedAt:now + 1, canceledAt:null,
      runCreatedAppVersion:APP_VER, decisionReason:'accepted-first-for-run', winnerAttemptId:'',
      runCreatedAt:now - 1000, paperLayoutVersion:PAPER_LAYOUT_VERSION, sourcePageCount:1,
      winner:null, updatedAt:now + 1,
      pageManifest:[{ page:0, qid:'paper:paper-run-1700000000004:v' + PAPER_LAYOUT_VERSION + ':0',
        clientId:'accepted-client-0', revision:1, cloudSha256:'c'.repeat(64),
        updatedAt:'2026-08-30T00:00:00.000Z' }],
    };
    const row = { id:accepted.runId, sourceId:source.id, status:'grading', remainingMs:accepted.remainingMs,
      resumeAt:null, submitAttempt:{ ...accepted }, submitAttemptHistory:[{ ...accepted }], mt:now };
    const session = { source, run:row, grading:true, submitLocked:true, inkPages:{} };
    paperSourceSession = session; sessionMode = 'paper-submit';
    syncState.user = { id:'user-1' }; syncState.pushErr = false;
    let releaseSync;
    const syncGate = new Promise((resolve) => { releaseSync = resolve; });
    let syncStarted = 0, readbacks = 0, keyCalls = 0, aiCalls = 0, rendered = 0;
    syncPush = async () => { syncStarted++; await syncGate; syncState.pushErr = false; };
    supa = { from(){ return {
      select(){ return this; }, eq(){ return this; },
      maybeSingle(){ readbacks++; return Promise.resolve({ error:null, data:{ revision:2,
        data:{ paperRuns:[{ ...row, submitAttempt:{ ...accepted }, submitAttemptHistory:[{ ...accepted }] }] } } }); },
    }; } };
    paperRuntimeAuditFinish = () => {}; paperRecoveryClose = () => {};
    paperAcceptedInkLoadAll = async () => ({ 0:{s:[],deleted:new Set(),revision:1,persistedRevision:1,dirty:false} });
    paperAcceptedGradeSnapshotPreflight = async () => ({ canonicalDigest:'c'.repeat(64) });
    paperPageComposite = async () => 'data:image/jpeg;base64,page';
    paperAnswerKeyAfterSubmit = async () => { keyCalls++; return ['1']; };
    paperAiGradeCall = async () => { aiCalls++; return { json:{}, model:'test', requestId:'r', usage:{}, budget:{}, serverGradeReceipt:{} }; };
    paperNormalizeAiGrade = () => ({ score:100, wrongNos:[], uncertainNos:[], questions:[] });
    paperApplyServerGradeReceipt = () => {}; paperGradeAlignMarksToInk = () => {};
    paperSourceRecordGrade = () => { row.aiGrade = { score:100, wrongNos:[], uncertainNos:[], questions:[] }; row.status = 'awaiting-correction'; };
    paperSourceGradeLoading = () => {}; renderPaperGradeResult = () => { rendered++; };
    const pending = paperSourceGradeAfterSubmit(session, '完成作答', accepted.remainingMs);
    await Promise.resolve(); await Promise.resolve();
    const before = { syncStarted, readbacks, keyCalls, aiCalls, locked:session.submitLocked };
    releaseSync();
    const completed = await pending;
    return { before, completed, readbacks, keyCalls, aiCalls, rendered,
      locked:session.submitLocked, mode:sessionMode };
  })()`));
  assert.deepEqual(result.before, { syncStarted:1, readbacks:0, keyCalls:0, aiCalls:0, locked:true });
  assert.equal(result.completed, undefined);
  assert.equal(result.readbacks, 1);
  assert.equal(result.keyCalls, 1);
  assert.equal(result.aiCalls, 1);
  assert.equal(result.rendered, 1);
  assert.equal(result.locked, false);
  assert.equal(result.mode, 'paper-result');
});

test('accepted 的雲端保存失敗時維持 grading 鎖定且不取答案', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const now = 1700000000000; Date.now = () => now;
    const source = { id:'paper-sync-fail', title:'同步失敗測試卷', scans:[{}] };
    const accepted = { attemptId:'paper-submit-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId:'paper-run-sync-fail', sourceId:source.id, status:'accepted', remainingMs:300000,
      inkSnapshotSha256:'d'.repeat(64), submittedAt:now, acceptedAt:now + 1, canceledAt:null,
      runCreatedAppVersion:APP_VER, decisionReason:'accepted-first-for-run', winnerAttemptId:'', winner:null };
    const row = { id:accepted.runId, sourceId:source.id, status:'grading', remainingMs:accepted.remainingMs,
      submitAttempt:{ ...accepted }, submitAttemptHistory:[{ ...accepted }], mt:now };
    const session = { source, run:row, grading:true, submitLocked:true };
    paperSourceSession = session; syncState.user = { id:'user-1' }; syncState.pushErr = false;
    syncPush = async () => { syncState.pushErr = true; };
    supa = {}; paperRuntimeAuditFinish = () => {};
    let keyCalls = 0; paperAnswerKeyAfterSubmit = async () => { keyCalls++; return []; };
    const root = { innerHTML:'' }; document.body = { classList:{ toggle(){} } };
    document.querySelector = (selector) => selector === '#app' ? root : null;
    const completed = await paperSourceGradeAfterSubmit(session, '完成作答', accepted.remainingMs);
    return { completed, keyCalls, status:row.status, locked:session.submitLocked,
      grading:session.grading, mode:sessionMode, retry:root.innerHTML.includes('重試雲端保存') };
  })()`));
  assert.deepEqual(result, { completed:false, keyCalls:0, status:'grading', locked:true,
    grading:false, mode:'paper-submit-reconcile', retry:true });
});

test('時間歸零後安全交卷失敗會停在救援畫面，不啟動 ticker 無限自動重試', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    let rendered = 0, tickerStarts = 0, alerts = 0;
    const root = { innerHTML:'' };
    document.body = { classList:{ toggle(){} } };
    document.querySelector = (selector) => selector === '#app' ? root : null;
    const source = { id:'paper-expired', title:'時間到測試卷', minutes:100, scans:[{}] };
    const row = { id:'paper-run-1700000000001', sourceId:source.id, status:'active', createdAt:1,
      remainingMs:0, resumeAt:null, paperLayoutVersion:PAPER_LAYOUT_VERSION,
      runtimeAudit:{ schema:PAPER_RUNTIME_AUDIT_SCHEMA, appVersion:APP_VER,
        runId:'paper-run-1700000000001', sourceId:source.id, activeElapsedMs:6000000 } };
    const session = { source, run:row, grading:false, submitLocked:false,
      inkPages:{ 0:{revision:1,persistedRevision:0,dirty:true} }, durability:{ pendingClientIds:new Set() } };
    paperSourceSession = session; sessionMode = 'paper-source';
    stopTicker = () => {}; startTicker = () => { tickerStarts++; };
    renderPaperSource = () => { rendered++; startTicker(() => paperSourceGrade('時間到')); };
    alert = () => { alerts++; }; paperInkCommitCurrent = () => {};
    paperInkJournalDrain = async () => false; paperInkPersistAll = async () => false;
    const completed = await paperSourceGrade('時間到');
    return { completed, mode:sessionMode, status:row.status, remaining:row.remainingMs,
      grading:session.grading, locked:session.submitLocked, rendered, tickerStarts, alerts,
      hasRescue:root.innerHTML.includes('匯出救援檔'), hasRetry:root.innerHTML.includes('重新安全交卷') };
  })()`));
  assert.deepEqual(result, {
    completed:false, mode:'paper-submit-error', status:'active', remaining:0,
    grading:false, locked:false, rendered:0, tickerStarts:0, alerts:0,
    hasRescue:true, hasRetry:true,
  });
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
  assert.match(source, /paperCompositeImage\(source, urls, inkPages, page, includeGrade\)/);
  assert.match(source, /paperBuildPdfBytes\(images\)/);
  assert.match(source, /magic !== '%PDF-'/);
  assert.match(source, /sha256 = await sha256Bytes\(bytes\)/);
  assert.doesNotMatch(source, /printWindow\.print\(\)/);
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

test('交卷後隔離只標記實際送出的版本，不會吃掉同 client 的較新筆跡', async () => {
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
    const stale = await inkRecordMarkCloudRejected(
      [{ clientId:'same-stroke', sentUpdatedAt:100 }], 'accepted-paper', 'user-1');
    const afterStale = { state:row.upload_state, updatedAt:row.updatedAt };
    const current = await inkRecordMarkCloudRejected(
      [{ clientId:'same-stroke', sentUpdatedAt:101 }], 'accepted-paper', 'user-1');
    const lateSuccess = await inkRecordMarkUploaded('same-stroke', 101, 'user-1');
    return { stale, afterStale, current, lateSuccess, state:row.upload_state, uploaded:row.uploaded,
      updatedAt:row.updatedAt, reason:row.cloudRejectedReason };
  })()`));
  assert.deepEqual(result, {
    stale:[],
    afterStale:{ state:'pending', updatedAt:101 },
    current:['same-stroke'],
    lateSuccess:false,
    state:'cloud-rejected',
    uploaded:false,
    updatedAt:101,
    reason:'accepted-paper',
  });
});

test('隔離筆跡重開後不再補傳，但仍會進原卷讀取與救援檔', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    syncState.user = { id:'user-1', email:'owner@example.com' };
    const session = {
      run:{ id:'paper-run-1700000000000', sourceId:'paper-1', createdAt:1 },
      source:{ id:'paper-1', scans:[{}] },
    };
    const qid = paperInkQid(session.run, 0);
    const rows = [
      { client_id:'rejected', user_id:'user-1', qid, updatedAt:10, uploaded:false,
        upload_state:'cloud-rejected', strokes:{ s:[{ id:'kept' }], e:[] } },
      { client_id:'pending', user_id:'user-1', qid, updatedAt:11, uploaded:false,
        upload_state:'pending', strokes:{ s:[{ id:'new' }], e:[] } },
      { client_id:'uploaded', user_id:'user-1', qid, updatedAt:12, uploaded:true,
        upload_state:'uploaded', strokes:{ s:[{ id:'cloud' }], e:[] } },
      { client_id:'other-user', user_id:'user-2', qid, updatedAt:13, uploaded:false,
        upload_state:'pending', strokes:{ s:[{ id:'private' }], e:[] } },
    ];
    const cursorRequest = (items) => {
      const request = { result:null };
      let index = 0;
      const pump = () => Promise.resolve().then(() => {
        request.result = index < items.length
          ? { value:items[index++], continue:pump } : null;
        if (request.onsuccess) request.onsuccess();
      });
      pump();
      return request;
    };
    const getAllRequest = (items) => {
      const request = { result:null };
      Promise.resolve().then(() => { request.result = items; request.onsuccess(); });
      return request;
    };
    const store = {
      indexNames:{ contains(){ return true; } },
      index(name){
        return {
          getAll(value){ return getAllRequest(rows.filter((row) => name !== 'qid' || row.qid === value)); },
          openCursor(value){ return cursorRequest(rows.filter((row) => row.upload_state === value)); },
        };
      },
      openCursor(){ return cursorRequest(rows); },
      getAll(){ return getAllRequest(rows); },
    };
    _idb = { transaction(){ return { objectStore(){ return store; } }; } };
    const pending = await inkRecordPending(80);
    const byQid = await inkRecordByQid(qid);
    const rescue = await paperRecoveryRows(session);
    const stats = await inkRecordStats();
    inkLocalStatus = stats; supa = {}; syncState.revision = 9;
    const settings = syncCard();
    const pill = { className:'', title:'', innerHTML:'', setAttribute(){} };
    document.querySelector = (selector) => selector === '#syncpill' ? pill : null;
    syncState.pushErr = false; syncPill();
    return {
      pending:pending.map((row) => row.client_id),
      byQid:byQid.map((row) => row.client_id),
      rescue:rescue.map((row) => row.client_id),
      stats,
      settingsShowsRejected:settings.includes('交卷後隔離 1 份'),
      settingsSeparatesUploaded:settings.includes('已上傳 1 份'),
      pillTitle:pill.title,
    };
  })()`));
  assert.deepEqual(result, {
    pending:['pending'],
    byQid:['rejected', 'pending', 'uploaded', 'other-user'],
    rescue:['rejected', 'pending', 'uploaded'],
    stats:{ total:3, uploaded:1, pending:1, rejected:1 },
    settingsShowsRejected:true,
    settingsSeparatesUploaded:true,
    pillTitle:'待同步 1 份｜交卷後隔離 1 份',
  });
});

test('同批含已交卷舊筆跡時會隔離舊筆跡並繼續上傳其他新筆跡', async () => {
  const { context, run } = loadApp();
  context.__rows = [
    { client_id:'frozen', qid:'paper:paper-run-1700000000000:v2:0', t0:1,
      updatedAt:100, upload_state:'pending', uploaded:false, strokes:{ s:[], e:[] } },
    { client_id:'new-work', qid:'practice:q1', t0:2,
      updatedAt:101, upload_state:'pending', uploaded:false, strokes:{ s:[], e:[] } },
  ];
  const result = plain(await run(`(async () => {
    const calls = [];
    syncState.user = { id:'user-1' };
    supa = { from(){ return { async upsert(rows){
      calls.push(rows.map((row) => row.client_id));
      return rows.some((row) => row.client_id === 'frozen')
        ? { error:{ code:'55000', message:'accepted paper ink is immutable for run paper-run-1700000000000' } }
        : { error:null };
    } }; } };
    inkRecordPending = async () => __rows.filter((row) => row.upload_state === 'pending');
    inkRecordMarkCloudRejected = async (versions) => {
      const ids = versions.map((row) => row.clientId);
      for (const row of __rows) if (ids.includes(row.client_id)) row.upload_state = 'cloud-rejected';
      return ids;
    };
    inkRecordMarkUploaded = async (clientId) => {
      const row = __rows.find((item) => item.client_id === clientId);
      if (row) { row.upload_state = 'uploaded'; row.uploaded = true; }
      return !!row;
    };
    refreshInkLocalStatus = async () => (inkLocalStatus = { total:2, uploaded:0, pending:0, rejected:1 });
    syncPill = () => {}; syncPull = async () => {};
    // Suppress the automatic retry so the test can model a full reload boundary explicitly.
    inkFlushRetryTimer = { blocked:true };
    const first = await flushInkQueue();
    inkFlushRetryTimer = null;
    const second = await flushInkQueue();
    return { first, second, calls, states:__rows.map((row) => [row.client_id, row.upload_state]) };
  })()`));
  assert.deepEqual(result, {
    first:false,
    second:true,
    calls:[['frozen', 'new-work'], ['new-work']],
    states:[['frozen', 'cloud-rejected'], ['new-work', 'uploaded']],
  });
});

test('無法綁定 run 的 55000 與訂正筆跡都不會被誤隔離', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    async function scenario(message, qid) {
      let marked = 0;
      inkFlushBusy = false; inkFlushRetryTimer = { blocked:true };
      syncState.user = { id:'user-1' }; syncState.pushErr = false;
      supa = { from(){ return { async upsert(){ return { error:{ code:'55000', message } }; } }; } };
      inkRecordPending = async () => [{ client_id:'one', qid, t0:1, updatedAt:1,
        upload_state:'pending', uploaded:false, strokes:{ s:[], e:[] } }];
      inkRecordMarkCloudRejected = async () => { marked++; return ['one']; };
      refreshInkLocalStatus = async () => (inkLocalStatus = { total:1, uploaded:0, pending:0, rejected:0 });
      syncPill = () => {};
      await flushInkQueue();
      return { marked, pushErr:syncState.pushErr };
    }
    const unparseable = await scenario('check constraint violation', 'paper:paper-run-1700000000000:v2:0');
    const correction = await scenario(
      'accepted paper ink is immutable for run paper-run-1700000000000',
      'paper-correction:paper-run-1700000000000:v2:0');
    return { unparseable, correction };
  })()`));
  assert.deepEqual(result, {
    unparseable:{ marked:0, pushErr:true },
    correction:{ marked:0, pushErr:true },
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
    JSON.stringify({ version:1, runId:'crash-run', sourceId:'paper-1', remainingMs:555000, page:4, questionNo:17, updatedAt:now - 10000, closed:false }),
  );
  const result = plain(run(`(() => {
    const recovery = paperRecoveryApply(__run);
    return { recovery:!!recovery, remainingMs:__run.remainingMs, page:__run.paperPage, questionNo:__run.paperQuestionNo, status:__run.status, resumeAt:__run.resumeAt };
  })()`));
  assert.deepEqual(result, { recovery:true, remainingMs:555000, page:4, questionNo:17, status:'paused', resumeAt:null });
});

test('當機恢復必須讓當機前與重載後的整份筆跡 SHA-256 完全相同', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const stroke = { id:'stroke-1', t0:1, t1:2, w:1, c:'black', pts:[[.1,.2,.5],[.3,.4,.7]] };
    const session = {
      source:{ id:'paper-mock-3', scans:[{},{}] },
      run:{ id:'recovery-hash-run', sourceId:'paper-mock-3', remainingMs:1000, resumeAt:null },
      page:1, inkPages:{
        0:{ s:[stroke], deleted:new Set(), revision:1, persistedRevision:1, dirty:false },
        1:{ s:[], deleted:new Set(['old-stroke']), revision:1, persistedRevision:1, dirty:false },
      },
      durability:{ localError:false, pendingClientIds:new Set() },
      journalPromises:new Set(), journalRetry:new Map(),
    };
    paperSourceSession = session;
    const checkpoint = await paperRecoveryRefreshCheckpoint(session);
    const recovery = paperRecoverySnapshot(session);
    const verified = await paperRecoveryVerifyInk(recovery, session);
    session.inkPages[0].s[0].pts[1][0] = .31;
    const altered = await paperRecoveryVerifyInk(recovery, session);
    return { sha256:checkpoint.sha256, pageCount:checkpoint.pageCount,
      verified:verified && verified.inkVerified, same:verified && verified.checkpointInkSha256 === verified.recoveredInkSha256,
      altered:!!altered };
  })()`));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result, { ...result, pageCount:2, verified:true, same:true, altered:false });
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
  assert.match(source, /partial,\s*\n\s*completeness:/);
  assert.match(source, /memoryInk,\s*\n\s*records,\s*\n\s*runtimeAudit:session\.run\.runtimeAudit \|\| null/);
  assert.match(source, /paperRecoveryRows\(session\)/);
  assert.match(source, /paperRecoveryExport\(\)[\s\S]*paperAwaitWithTimeout\(paperInkJournalDrain\(session\)[\s\S]*paperAwaitWithTimeout\(paperInkPersistAll\(true, session\)/);
  assert.match(source, /id="paper-ink-status"[^>]+paperRecoveryOpen\(\)/);
});

test('IndexedDB 永久 pending 時救援匯出仍會下載記憶體筆跡並明示 partial', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    let serialized = '', warning = '';
    Blob = class { constructor(parts) { serialized = String(parts[0] || ''); } };
    URL = { createObjectURL(){ return 'blob:rescue'; }, revokeObjectURL(){} };
    document.createElement = () => ({ href:'', download:'', click(){} });
    setTimeout = () => 0; alert = (message) => { warning = message; };
    paperInkCommitCurrent = () => {};
    paperInkJournalDrain = () => new Promise(() => {});
    paperInkPersistAll = () => new Promise(() => {});
    paperRecoveryRows = () => new Promise(() => {});
    paperAwaitWithTimeout = async () => { throw new Error('bounded timeout'); };
    paperRecoveryWrite = () => ({ version:2, runId:'rescue-run' });
    paperSourceSession = {
      source:{ id:'paper-rescue', title:'救援卷', scans:[{}] },
      run:{ id:'rescue-run', sourceId:'paper-rescue', name:'救援卷', d:'2026-08-30',
        createdAt:1, remainingMs:1000, resumeAt:null },
      page:0, inkPages:{ 0:{ s:[{ id:'stroke-memory', t0:1, t1:2, w:1, c:'black', pts:[[.1,.2,.5],[.2,.3,.5]] }],
        deleted:new Set(), revision:1, persistedRevision:0, dirty:true } },
      durability:{ pendingClientIds:new Set() }, journalPromises:new Set([new Promise(() => {})]),
    };
    const ok = await paperRecoveryExport();
    const payload = JSON.parse(serialized);
    return { ok, partial:payload.partial, completeness:payload.completeness,
      strokeIds:payload.memoryInk.pages[0].strokes.map((stroke) => stroke.id),
      recordCount:payload.records.length, warning };
  })()`));
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.completeness.journalDrained, false);
  assert.equal(result.completeness.snapshotPersisted, false);
  assert.equal(result.completeness.localRecordsRead, false);
  assert.equal(result.completeness.memoryInkIncluded, true);
  assert.deepEqual(result.strokeIds, ['stroke-memory']);
  assert.equal(result.recordCount, 0);
  assert.match(result.warning, /部分救援檔/);
});

test('真機驗收用實際翻頁 P95、落筆保存、100 分鐘、恢復與 PDF 證據判定', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = paperSourceById('paper-mock-3');
    const audit = {
      schema:PAPER_RUNTIME_AUDIT_SCHEMA, appVersion:APP_VER, runId:'paper-run-1234567890123', sourceId:source.id,
      submittedAt:2,
      activeElapsedMs:source.minutes * 60000, sessions:2, crashRecoveries:1,
      recoveryEvents:[{sourceId:source.id, checkpointUpdatedAt:1, recoveredAt:2, page:2, remainingMs:1,
        inkVerified:true, checkpointInkSha256:'b'.repeat(64), recoveredInkSha256:'b'.repeat(64),
        pageCount:4, strokeCount:20, deletedCount:1}],
      initialPage:0, visitedPages:[0,1,2,3],
      pageSwitches:[100, 180, 220, 430].map((ms, index) => ({ from:[0,1,2,3][index], to:[1,2,3,2][index], method:'swipe', painted:true, ms })),
      localSaveMs:[25, 80, 130, 850], localSaveFailures:0,
      maxSingleCanvasPixels:PAPER_CANVAS_MAX_PIXELS, maxLiveCanvasCount:2,
      samples:[100, 122, 131].map((mb) => ({ heapBytes:mb * 1048576 })), maxHeapBytes:131 * 1048576,
      submitDurability:{journalDrained:true, allPagesPersisted:true, cloudFlushed:true, pendingAtSubmit:0,
        revisionsUnchanged:true,
        readbackVerifiedAt:3, expectedPages:4, verifiedPages:4, pages:Array.from({length:4}, (_, page) => ({
          page, qid:paperInkQid({id:'paper-run-1234567890123'}, page), clientId:'client-' + page,
          localSha256:'b'.repeat(64), cloudSha256:'b'.repeat(64), matched:true,
        }))},
      pdfArtifact:{format:'application/pdf', magic:'%PDF-', eof:'%%EOF', sha256:'a'.repeat(64), bytes:4096,
        pageCount:4, kind:'graded', generatedAt:3, storageVerified:true, bucket:PAPER_AUDIT_PRIVATE_BUCKET,
        contentBindingVersion:1, contentBindingSha256:'d'.repeat(64),
        sourceAssetVersion:'private-scan-set-paper-mock-3-20260717-v1', gradeBindingSha256:'e'.repeat(64),
        path:'runtime-audits/matha_' + 'c'.repeat(32) + '/pdf/paper-run-1234567890123/graded-' + 'd'.repeat(64) + '-' + 'a'.repeat(64) + '.pdf',
        serverVerifiedAt:'2026-08-30T00:00:00.000Z'},
      pdfPixelQa:{confirmed:true, source:'owner-visual-review', reviewer:'authenticated-owner',
        pdfSha256:'a'.repeat(64), contentBindingSha256:'d'.repeat(64), confirmedAt:'2026-08-30T01:00:00.000Z'},
    };
    const passing = paperRuntimeAuditSummary({ id:'paper-run-1234567890123', sourceId:source.id, runtimeAudit:audit });
    const failing = paperRuntimeAuditSummary({ id:'audit-fail', sourceId:source.id, runtimeAudit:{
      ...audit, runId:'audit-fail', pageSwitches:[100, 180, 220, 720].map((ms, index) => ({from:[0,1,2,3][index], to:[1,2,3,2][index], method:'swipe', painted:true, ms})),
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
    duration:'pass', page:'pass', save:'pass', canvas:'pass', resume:'pass', cloud:'pass', pdf:'pass',
    'pdf-visual':'pass', memory:'pass',
  });
  assert.equal(result.failed, false);
  assert.equal(result.failedStatuses.page, 'fail');
  assert.equal(result.failedStatuses.save, 'fail');
});

test('跨裝置 paperRun 合併只會前進，且不會用較晚的殘缺 audit 蓋掉交卷與真機證據', () => {
  const { context, run } = loadApp();
  context.__paperMerge = {
    completed:{
      id:'merge-run', sourceId:'paper-mock-3', status:'completed', mt:400, createdAt:100,
      submittedAt:200, freshnessConfirmedAt:150, recoveredAt:180, resumeAt:null,
      aiGrade:{ gradedAt:250, score:100, wrongNos:[], questions:[] },
      runtimeAudit:{
        schema:2, runId:'merge-run', sourceId:'paper-mock-3', createdAt:100, startedAt:110,
        submittedAt:200, activeElapsedMs:6000000, sessions:2, crashRecoveries:1,
        visitedPages:[0], pageSwitches:[{at:120, from:0, to:1, method:'swipe', ms:100, painted:true}],
        samples:[{at:130, canvasCount:2, heapBytes:100}], localSaveMs:[20,30], cloudSyncMs:[40],
        recoveryEvents:[{recoveredAt:140, checkpointUpdatedAt:130, sourceId:'paper-mock-3', page:0}],
        submitDurability:{journalDrained:true, allPagesPersisted:true, cloudFlushed:true, revisionsUnchanged:true,
          pendingAtSubmit:0, readbackVerifiedAt:220, expectedPages:4, verifiedPages:4,
          pages:Array.from({length:4}, (_, page) => ({page, qid:'paper:merge-run:v2:' + page,
            clientId:'client-' + page, localSha256:'a'.repeat(64), cloudSha256:'a'.repeat(64), matched:true}))},
        pdfArtifact:{format:'application/pdf', magic:'%PDF-', eof:'%%EOF', sha256:'b'.repeat(64), bytes:4096,
          pageCount:4, kind:'graded', generatedAt:260, storageVerified:true, bucket:'matha-content',
          path:'paper-runtime/merge-run/graded.pdf', serverVerifiedAt:'2026-08-30T00:00:00Z'},
        archive:{sha256:'c'.repeat(64), bucket:'matha-content', path:'paper-audits/merge-run.json', archivedAt:300},
        device:{platform:'Linux armv8l'},
        deviceAttestation:{confirmed:true, model:'Samsung Galaxy Tab S10 Ultra', source:'user-confirmation',
          confirmedAt:280, browserReportedModel:'SM-X920'},
      },
    },
    stale:{
      id:'merge-run', sourceId:'paper-mock-3', status:'active', mt:900, createdAt:150,
      submittedAt:null, freshnessConfirmedAt:160, recoveredAt:190, resumeAt:900,
      runtimeAudit:{
        schema:2, runId:'merge-run', sourceId:'paper-mock-3', createdAt:150, lastSampleAt:900,
        activeElapsedMs:1000, sessions:1, visitedPages:[1],
        pageSwitches:[{at:900, from:1, to:0, method:'button', ms:20, painted:true}],
        samples:[{at:900, canvasCount:1, heapBytes:50}], localSaveMs:[5], cloudSyncMs:[],
        submitDurability:{journalDrained:false, allPagesPersisted:false, cloudFlushed:false,
          pendingAtSubmit:3, readbackVerifiedAt:800, expectedPages:4, verifiedPages:0, pages:[]},
        pdfArtifact:{format:'text/plain', sha256:'bad', bytes:10, pageCount:0, generatedAt:850},
        archive:{path:'partial'},
        deviceAttestation:{confirmed:false, model:'unknown', confirmedAt:850},
      },
    },
  };
  const result = plain(run(`(() => {
    const left = mergePaperRunRecord(__paperMerge.completed, __paperMerge.stale);
    const right = mergePaperRunRecord(__paperMerge.stale, __paperMerge.completed);
    const stages = {
      grading:mergePaperRunRecord({id:'g', status:'grading', mt:10}, {id:'g', status:'paused', mt:99}).status,
      correction:mergePaperRunRecord({id:'c', status:'awaiting-correction', mt:10}, {id:'c', status:'active', mt:99}).status,
      discarded:mergePaperRunRecord({id:'d', status:'discarded', mt:10}, {id:'d', status:'active', mt:99}).status,
    };
    const pick = (row) => ({status:row.status, resumeAt:row.resumeAt, createdAt:row.createdAt,
      submittedAt:row.submittedAt, freshnessConfirmedAt:row.freshnessConfirmedAt, recoveredAt:row.recoveredAt,
      durability:row.runtimeAudit.submitDurability, pdf:row.runtimeAudit.pdfArtifact,
      archive:row.runtimeAudit.archive, attestation:row.runtimeAudit.deviceAttestation,
      visits:row.runtimeAudit.visitedPages, switches:row.runtimeAudit.pageSwitches.length,
      elapsed:row.runtimeAudit.activeElapsedMs, sessions:row.runtimeAudit.sessions});
    return {left:pick(left), right:pick(right), stages};
  })()`));
  for (const merged of [result.left, result.right]) {
    assert.equal(merged.status, 'completed');
    assert.equal(merged.resumeAt, null);
    assert.equal(merged.createdAt, 100);
    assert.equal(merged.submittedAt, 200);
    assert.equal(merged.freshnessConfirmedAt, 160);
    assert.equal(merged.recoveredAt, 190);
    assert.equal(merged.durability.verifiedPages, 4);
    assert.equal(merged.durability.pages.length, 4);
    assert.equal(merged.pdf.sha256, 'b'.repeat(64));
    assert.equal(merged.pdf.storageVerified, true);
    assert.equal(merged.archive.sha256, 'c'.repeat(64));
    assert.equal(merged.attestation.confirmed, true);
    assert.deepEqual(merged.visits, [0, 1]);
    assert.equal(merged.switches, 2);
    assert.equal(merged.elapsed, 6000000);
    assert.equal(merged.sessions, 2);
  }
  assert.deepEqual(result.stages, {grading:'grading', correction:'awaiting-correction', discarded:'discarded'});
});

test('重開兩次、按鈕翻頁與只開列印視窗都不能冒充真機驗收', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = paperSourceById('paper-mock-3');
    const audit = {
      schema:PAPER_RUNTIME_AUDIT_SCHEMA, appVersion:APP_VER, runId:'false-pass', sourceId:source.id,
      activeElapsedMs:source.minutes * 60000, sessions:2, crashRecoveries:0, pdfPreparedAt:Date.now(),
      initialPage:0, visitedPages:[0,1,2,3],
      pageSwitches:[0,1,2].map((from) => ({from, to:from + 1, method:'button', painted:true, ms:50})),
      localSaveMs:[30], localSaveFailures:0,
      maxSingleCanvasPixels:1000, maxLiveCanvasCount:2, samples:[],
    };
    const summary = paperRuntimeAuditSummary({id:'false-pass', sourceId:source.id, runtimeAudit:audit});
    return {passed:summary.passed, statuses:Object.fromEntries(summary.checks.map((row) => [row.id, row.status]))};
  })()`));
  assert.equal(result.passed, false);
  assert.equal(result.statuses.page, 'pending');
  assert.equal(result.statuses.resume, 'pending');
  assert.equal(result.statuses.cloud, 'pending');
  assert.equal(result.statuses.pdf, 'pending');
});

test('內建 PDF 生成器輸出真正多頁 PDF 位元組、xref 與 EOF', () => {
  const { context, run } = loadApp();
  const jpeg = Buffer.from([
    0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0x02,0x00,0x03,0x03,
    0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,
    ...new Array(1600).fill(0),0xff,0xd9,
  ]).toString('base64');
  context.__jpeg = jpeg;
  const result = plain(run(`(() => {
    const bytes = paperBuildPdfBytes([__jpeg, __jpeg]);
    const text = String.fromCharCode(...bytes);
    const starts = [...text.matchAll(/(\\d+) 0 obj/g)].map((match) => Number(match.index));
    const xref = text.slice(text.indexOf('xref\\n'));
    const offsets = xref.split('\\n').slice(2, 9).map((line) => Number(String(line).slice(0, 10))).filter(Boolean);
    return {head:text.slice(0, 5), eof:text.trim().slice(-5), count:/\\/Count 2\\b/.test(text), bytes:bytes.length,
      objects:starts.length, offsetsPointToObjects:offsets.every((offset) => /\\d+ 0 obj/.test(text.slice(offset, offset + 16)))};
  })()`));
  assert.deepEqual(result, {head:'%PDF-', eof:'%%EOF', count:true, bytes:result.bytes, objects:8, offsetsPointToObjects:true});
  assert.ok(result.bytes > 3000);
});

test('真機量測事件與樣本都有固定上限，換 app 版本也不會清掉同一回證據', () => {
  const { run } = loadApp();
  const expectedVersion = plain(run('APP_VER'));
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
  assert.equal(result.lastVersion, expectedVersion);
  delete result.lastVersion;
  assert.deepEqual(result, {
    sameObject:true,
    originalVersion:'older-version',
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
  assert.match(source, /kind:'matha-paper-runtime-audit-v2'/);
  assert.match(source, /getHighEntropyValues\(\['model'\]\)/);
  assert.match(source, /attestation = \{ confirmed:true, model:'Samsung Galaxy Tab S10 Ultra', source:'user-confirmation', confirmedAt, browserReportedModel \}/);
  assert.match(source, /responseType:'paper_audit_archive'[^]*paperRunId:run\.id/);
  assert.match(source, /同步並匯出驗收檔/);
  assert.match(source, /paperRuntimeAuditSample\(\);[\s\S]*paperRecoveryHeartbeat\(\)/);
});

test('正式 PDF 必須由後端私有儲存並下載回讀相同 bytes 與 SHA 才算驗收', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    syncState.user = { id:'user-1' }; syncState.pushErr = '';
    supa = {}; syncPush = async () => { syncState.pushErr = ''; return true; };
    blobBase64 = async () => 'cGRm';
    const local = { format:'application/pdf', magic:'%PDF-', eof:'%%EOF', sha256:'d'.repeat(64),
      bytes:4096, pageCount:4, kind:'graded', generatedAt:123, storageVerified:false };
    openAiInvoke = async (body) => ({ paperPdfArtifact:{ ...local, storageVerified:true,
      bucket:PAPER_AUDIT_PRIVATE_BUCKET, contentBindingVersion:1, contentBindingSha256:'c'.repeat(64),
      sourceAssetVersion:'private-scan-set-paper-mock-3-20260717-v1', gradeBindingSha256:'b'.repeat(64),
      path:'runtime-audits/matha_' + 'e'.repeat(32) + '/pdf/paper-run-1234567890123/graded-' + 'c'.repeat(64) + '-' + local.sha256 + '.pdf',
      serverVerifiedAt:'2026-08-30T00:00:00.000Z', runId:'paper-run-1234567890123', sourceId:'paper-mock-3' } });
    const artifact = await paperRuntimePdfStore({ id:'paper-run-1234567890123', sourceId:'paper-mock-3',
      submittedAt:1, status:'awaiting-correction', aiGrade:{} }, new Uint8Array([1,2,3]), local);
    return { verified:artifact.storageVerified, generatedAt:artifact.generatedAt, sha256:artifact.sha256,
      privatePath:artifact.path.includes('/pdf/paper-run-1234567890123/') };
  })()`));
  assert.deepEqual(result, { verified:true, generatedAt:123, sha256:'d'.repeat(64), privatePath:true });
});

test('真機驗收封存由後端重讀雲端狀態且不經 OpenAI 金鑰或模型', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/index.ts'), 'utf8');
  const branch = edge.indexOf('if (responseType === "paper_audit_archive")');
  const keyLookup = edge.indexOf('const apiKey = Deno.env.get("OPENAI_API_KEY")');
  assert.ok(branch > 0 && keyLookup > branch, '驗收封存必須在 OpenAI 金鑰與模型路徑之前完成');
  assert.match(edge, /const data = await loadAppState\(userId\);[\s\S]*paperRuntimeAuditInkReferences\(data, runId\)[\s\S]*loadPaperRuntimeInkRows[\s\S]*paperRuntimeAuditEvidence\(\s*data,\s*runId,\s*inkRows,\s*serverPdf/);
  assert.match(edge, /downloadStoredPdfArtifact[\s\S]*paperRuntimeAuditEvidence\(\s*data,\s*runId,\s*inkRows,\s*serverPdf/);
  assert.match(edge, /PAPER_AUDIT_BUCKET = PAPER_AUDIT_PRIVATE_BUCKET/);
  assert.match(edge, /paperPdfContentBinding\(data, runId, kind\)[\s\S]*contentBindingSha256/);
});

test('六回與最近三回能力證據由後端 app_state 重建、私有封存後即時回讀且不經 OpenAI', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/index.ts'), 'utf8');
  const branch = edge.indexOf('if (responseType === "capability_evidence_archive")');
  const keyLookup = edge.indexOf('const apiKey = Deno.env.get("OPENAI_API_KEY")');
  assert.ok(branch > 0 && keyLookup > branch, '能力證據封存必須在 OpenAI 金鑰與模型路徑之前完成');
  assert.match(edge, /archiveCapabilityGoalEvidence[\s\S]*loadAppState\(userId\)[\s\S]*capabilityGoalServerEvidence/);
  assert.match(edge, /downloadStoredJson\(path\)[\s\S]*readback\.text !== content[\s\S]*readback\.sha256 !== sha256/);
  assert.match(edge, /authority: "supabase-service-role-storage-readback"/);
  assert.match(edge, /尚未有同一組六回可重算的新鮮正式卷/);
});

test('能力卷必須逐頁看過並把本人卷面確認綁到私有 grade receipt 與模型影像', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/index.ts'), 'utf8');
  const branch = edge.indexOf('if (responseType === "paper_grade_visual_attest")');
  const keyLookup = edge.indexOf('const apiKey = Deno.env.get("OPENAI_API_KEY")');
  assert.ok(branch > 0 && keyLookup > branch, '本人像素確認封存不得耗用 OpenAI API');
  assert.match(edge, /archivePaperGradeVisualAttestation[\s\S]*loadVerifiedGradeReceipts[\s\S]*paperGradeVisualAttestation/);
  assert.match(edge, /grade-visual-attestations\/\$\{userHash\}\/\$\{runId\}\/attestation-/);
  assert.match(app, /gradeVisualVisitedPages\.add\(page\)/);
  assert.match(app, /visualVisited < source\.scans\.length \? ' disabled'/);
  assert.match(app, /我已逐頁看過，畫面確實是這一回的原題、我的筆跡與第一次批改/);
  assert.match(app, /remote\.gradeReceiptDigest[^]*receipt\.canonicalDigest/);
  assert.match(app, /remote\.modelInputBindingSha256[^]*receipt\.modelInputBindingSha256/);
  assert.match(app, /ownerStatement:'I reviewed every model-input page and confirm it is this paper run'/);
  assert.match(app, /confirmedPages = Array\.isArray\(run\.serverGradeReceipt\.modelInputImages\)/);
  assert.match(app, /submitAttemptDigest:String\(run\.serverGradeReceipt\.submitAttemptDigest/);
  assert.match(edge, /loadAcceptedPaperSubmitAttempt[\s\S]*paper_submit_attempts/);
  assert.match(app, /delete run\.gradeInputVisualAttestation/);
});

test('首輪批改 receipt 與 App 對每頁 A／B／C 三圖使用同一 imageOrder 契約', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/load-app');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/index.ts'), 'utf8');
  const builder = fs.readFileSync(path.join(ROOT, 'supabase/functions/openai-proxy/paper-grade-model-input.ts'), 'utf8');
  assert.match(edge, /modelInputBinding[^]*\.imageOrder/);
  assert.doesNotMatch(edge, /modelInputBinding[^]*\?\.images/);
  assert.match(app, /modelInputImages\.length !== source\.scans\.length \* 3/);
  assert.match(app, /\['source-scan', 'source-aligned-ink', 'full-workspace-ink'\]\[index % 3\]/);
  for (const kind of ['source-scan', 'source-aligned-ink', 'full-workspace-ink']) {
    assert.match(builder, new RegExp(`kind: "${kind}"`));
  }
});
