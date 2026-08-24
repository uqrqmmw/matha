'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

// These are deterministic, bounded workload regressions. They intentionally assert
// final state rather than elapsed wall-clock time, so a busy CI runner cannot make
// the suite flaky.

test('6 頁、1200 筆 journal 壓力合併不遺失不重複，刪除 tombstone 永遠勝出', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const source = paperSourceById('paper-mock-1');
    const pageCount = source.scans.length;
    const strokesPerPage = 200;
    const pointCount = 12;
    const stored = new Map();
    const idsByPage = Array.from({ length:pageCount }, () => []);
    const deletedByPage = Array.from({ length:pageCount }, () => []);
    let writeSequence = 0;
    let virtualNow = 10_000;
    Date.now = () => virtualNow;
    localStorage.setItem(PAPER_INK_DEVICE_KEY, 'stress-device');
    inkRecordPut = async (row) => {
      const saved = { ...row, updatedAt:++writeSequence };
      // IndexedDB/Supabase upsert semantics: a final stroke replaces its draft by client_id.
      stored.set(saved.client_id, saved);
      return saved;
    };
    paperSourceSession = {
      page:0,
      inkUserId:'stress-user',
      source,
      run:{
        id:'stress-six-page', sourceId:source.id, createdAt:1,
        remainingMs:100 * 60_000, resumeAt:null, paperInkClients:{},
      },
      inkPages:{},
      journalPromises:new Set(),
      journalRetry:new Map(),
      recoveryStateAt:virtualNow,
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    sessionMode = 'paper-source';

    for (let page = 0; page < pageCount; page++) {
      paperSourceSession.page = page;
      for (let i = 0; i < strokesPerPage; i++) {
        const id = 'page-' + page + '-stroke-' + i;
        const t0 = page * 1_000_000 + i * 100 + 1;
        const points = Array.from({ length:pointCount }, (_, point) => [
          ((i * 17 + point * 7) % 997) / 997,
          ((page * 101 + i * 13 + point * 11) % 991) / 991,
          .35 + (point % 5) * .1,
        ]);
        const stroke = {
          id, t0, w:1 + (i % 3) * .25,
          c:['black', 'blue', 'green'][i % 3],
          pts:points.slice(0, 4),
        };
        idsByPage[page].push(id);
        paperInkJournalStroke(stroke, false);
        stroke.pts.push(...points.slice(4));
        stroke.t1 = t0 + pointCount;
        paperInkJournalStroke(stroke, true);
      }
    }
    const strokeJournalOk = await paperInkJournalDrain();

    for (let page = 0; page < pageCount; page++) {
      paperSourceSession.page = page;
      // Delete strokes from the beginning, middle and end of every page.
      deletedByPage[page] = idsByPage[page].filter((_, i) => i % 17 === 0 || i === strokesPerPage - 1);
      virtualNow++;
      paperInkJournalDeleted(deletedByPage[page]);
    }
    const deleteJournalOk = await paperInkJournalDrain();

    const rows = [...stored.values()];
    const pages = [];
    for (let page = 0; page < pageCount; page++) {
      const qid = paperInkQid(paperSourceSession.run, page);
      const pageRows = rows.filter((row) => row.qid === qid);
      const olderSnapshot = {
        paper:true,
        s:idsByPage[page].map((id, i) => ({
          id, t0:page * 1_000_000 + i * 100 + 1,
          t1:page * 1_000_000 + i * 100,
          w:1, c:'black', pts:[[.01,.01,.5],[.02,.02,.5]],
        })),
        deleted:[],
      };
      // Repeat every journal payload and snapshot to model local/cloud overlap and retries.
      const duplicatedPayloads = pageRows.flatMap((row) => [row.strokes, row.strokes]);
      const merged = paperInkMergePayloads([olderSnapshot, ...duplicatedPayloads, olderSnapshot]);
      const actualIds = merged.s.map((stroke) => stroke.id);
      const actualSet = new Set(actualIds);
      const deletedSet = new Set(deletedByPage[page]);
      const expectedIds = idsByPage[page].filter((id) => !deletedSet.has(id));
      pages.push({
        page,
        rows:pageRows.length,
        live:actualIds.length,
        expectedLive:expectedIds.length,
        unique:actualSet.size === actualIds.length,
        complete:expectedIds.every((id) => actualSet.has(id)),
        finalVersion:merged.s.every((stroke) => stroke.pts.length === pointCount),
        tombstones:merged.deleted.length,
        expectedTombstones:deletedSet.size,
        deletedAbsent:[...deletedSet].every((id) => !actualSet.has(id)),
        deletedComplete:[...deletedSet].every((id) => merged.deleted.includes(id)),
      });
    }

    const out = {
      pageCount,
      strokesPerPage,
      totalStrokes:pageCount * strokesPerPage,
      writes:writeSequence,
      storedRows:stored.size,
      strokeJournalOk,
      deleteJournalOk,
      retryCount:paperSourceSession.journalRetry.size,
      pages,
    };
    paperInkSaveTimersClearAll();
    clearTimeout(paperInkCloudTimer); paperInkCloudTimer = null;
    clearTimeout(paperSourceSession.journalRetryTimer);
    return out;
  })()`));

  assert.equal(result.pageCount, 6);
  assert.equal(result.totalStrokes, 1_200);
  assert.equal(result.writes, 2 * result.totalStrokes + result.pageCount);
  assert.equal(result.storedRows, result.totalStrokes + result.pageCount);
  assert.equal(result.strokeJournalOk, true);
  assert.equal(result.deleteJournalOk, true);
  assert.equal(result.retryCount, 0);
  for (const page of result.pages) {
    assert.equal(page.rows, result.strokesPerPage + 1, `第 ${page.page + 1} 頁 journal 數量`);
    assert.equal(page.live, page.expectedLive, `第 ${page.page + 1} 頁不可遺失筆畫`);
    assert.equal(page.unique, true, `第 ${page.page + 1} 頁不可重複筆畫`);
    assert.equal(page.complete, true, `第 ${page.page + 1} 頁所有未刪筆畫都要存在`);
    assert.equal(page.finalVersion, true, `第 ${page.page + 1} 頁 draft 不可蓋過 final`);
    assert.equal(page.tombstones, page.expectedTombstones, `第 ${page.page + 1} 頁 tombstone 數量`);
    assert.equal(page.deletedAbsent, true, `第 ${page.page + 1} 頁被刪筆畫不可復活`);
    assert.equal(page.deletedComplete, true, `第 ${page.page + 1} 頁 tombstone 不可遺失`);
  }
});

test('虛擬 80 分鐘共 960 次 heartbeat 後當機，重開會凍結剩餘 20 分鐘與第 6 頁', () => {
  const first = loadApp();
  const startedAt = 2_000_000_000_000;
  first.context.__now = startedAt;
  first.context.__saveCalls = 0;
  const heartbeat = plain(first.run(`(() => {
    Date.now = () => __now;
    save = () => { __saveCalls++; };
    const source = paperSourceById('paper-mock-1');
    const run = {
      id:'stress-80-minute', sourceId:source.id, status:'active', createdAt:__now,
      remainingMs:100 * 60_000, resumeAt:__now, paperPage:0,
    };
    paperSourceSession = {
      page:0, source, run,
      recoveryHeartbeatAt:__now,
      recoveryStateAt:__now,
      durability:{ pendingClientIds:new Set(), localError:false },
    };
    sessionMode = 'paper-source';
    const heartbeatCount = 80 * 60_000 / PAPER_RECOVERY_HEARTBEAT_MS;
    for (let step = 1; step <= heartbeatCount; step++) {
      __now = ${startedAt} + step * PAPER_RECOVERY_HEARTBEAT_MS;
      const elapsed = step * PAPER_RECOVERY_HEARTBEAT_MS;
      paperSourceSession.page = Math.min(source.scans.length - 1, Math.floor(elapsed / (16 * 60_000)));
      paperRecoveryHeartbeat(__now);
    }
    const key = paperRecoveryStorageKey(run.id);
    return {
      key,
      stored:localStorage.getItem(key),
      heartbeatCount,
      saveCalls:__saveCalls,
      pageCount:source.scans.length,
      snapshot:JSON.parse(localStorage.getItem(key)),
    };
  })()`));

  assert.equal(heartbeat.pageCount, 6);
  assert.equal(heartbeat.heartbeatCount, 960);
  assert.equal(heartbeat.saveCalls, 240);
  assert.equal(heartbeat.snapshot.remainingMs, 20 * 60_000);
  assert.equal(heartbeat.snapshot.page, 5);
  assert.equal(heartbeat.snapshot.updatedAt, startedAt + 80 * 60_000);
  assert.equal(heartbeat.snapshot.closed, false);

  const second = loadApp();
  const reopenedAt = startedAt + 97 * 60_000;
  second.context.__now = reopenedAt;
  second.context.localStorage.setItem(heartbeat.key, heartbeat.stored);
  second.context.__run = {
    id:'stress-80-minute', sourceId:'paper-mock-1', status:'active', createdAt:startedAt,
    remainingMs:100 * 60_000, resumeAt:startedAt, paperPage:0,
  };
  const restored = plain(second.run(`(() => {
    Date.now = () => __now;
    const recovery = paperRecoveryApply(__run);
    return {
      found:!!recovery,
      remainingMs:__run.remainingMs,
      page:__run.paperPage,
      status:__run.status,
      resumeAt:__run.resumeAt,
      recoveredFrom:__run.recoveredFrom,
      recoveredAt:__run.recoveredAt,
    };
  })()`));
  assert.deepEqual(restored, {
    found:true,
    remainingMs:20 * 60_000,
    page:5,
    status:'paused',
    resumeAt:null,
    recoveredFrom:startedAt + 80 * 60_000,
    recoveredAt:reopenedAt,
  });
});

test('6 頁在 400% 與 DPR 4 的 canvas backing store 每頁都不超過 12MP', () => {
  const { context, run } = loadApp();
  context.devicePixelRatio = 4;
  const result = plain(run(`(() => {
    const source = paperSourceById('paper-mock-1');
    const canvases = source.scans.map((scan, page) => {
      const fitWidth = 1180 + page * 50;
      const width = fitWidth * PAPER_ZOOM_MAX;
      const height = Math.round(width * 2535 / 2112);
      const transforms = [];
      const canvas = {
        clientWidth:width, clientHeight:height, width:0, height:0,
        getContext(){ return { setTransform(...args){ transforms.push(args); } }; },
      };
      const prepared = paperCanvasPrepare(canvas);
      return {
        page,
        side:scan.side,
        cssWidth:width,
        cssHeight:height,
        pixelWidth:canvas.width,
        pixelHeight:canvas.height,
        pixels:canvas.width * canvas.height,
        scale:prepared.scale,
        transformed:transforms.length === 1 && transforms[0][0] === prepared.scale,
      };
    });
    return { pages:source.scans.length, zoom:PAPER_ZOOM_MAX, limit:PAPER_CANVAS_MAX_PIXELS, canvases };
  })()`));

  assert.equal(result.pages, 6);
  assert.equal(result.zoom, 4);
  assert.equal(result.limit, 12_000_000);
  for (const canvas of result.canvases) {
    assert.ok(canvas.pixels <= result.limit,
      `第 ${canvas.page + 1} 頁 backing store ${canvas.pixels} 必須 <= ${result.limit}`);
    assert.ok(canvas.scale < 1, `第 ${canvas.page + 1} 頁在 400% 應降低 backing scale`);
    assert.equal(canvas.transformed, true);
  }
});
