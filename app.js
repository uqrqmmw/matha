/* 數A特訓 — 核心邏輯
   設計原則：每一題都帶碼表、每一個錯都分類、用數據決定練什麼。 */
'use strict';

const APP_VER = '0722e'; // 版本戳：顯示在做題畫面右上，用來確認裝置載到的是不是最新版。改版時 index.html ?v= 與 sw.js APP_STAMP 要同步（tests/assets.test.js 會驗）

/* ═══════════ 狀態 ═══════════ */
const LEGACY_KEY = 'mathA13';
const LEGACY_OWNER_KEY = 'mathA13_legacy_owner_v1';
const ACTIVE_USER_KEY = 'mathA13_active_user_v1';
const ANONYMOUS_KEY = 'mathA13_anonymous_v1';
function userStateKey(userId) {
  return `${LEGACY_KEY}:user:${String(userId || '').replace(/[^\w-]/g, '_')}`;
}
function storedActiveUserId() {
  try { return localStorage.getItem(ACTIVE_USER_KEY) || ''; } catch (_) { return ''; }
}
let KEY = storedActiveUserId() ? userStateKey(storedActiveUserId()) : ANONYMOUS_KEY;
function localUserId() {
  const prefix = `${LEGACY_KEY}:user:`;
  return String(KEY || '').startsWith(prefix) ? String(KEY).slice(prefix.length) : '';
}
function localScopePrefix() {
  return `matha-scope:${localUserId() ? `user:${localUserId()}` : 'anonymous'}::`;
}
function currentUserOwnsLegacyData() {
  const uid = localUserId();
  return !!uid && userStateKey(legacyOwnerId()) === KEY;
}
let S = load();
function stripLegacyAiSecrets(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const clean = { ...state };
  delete clean.aikey;
  delete clean.aikeyTs;
  return clean;
}
function freshState() {
  return {
    attempts: [], wrong: {}, drills: {}, mocks: [], corrections: [], daily: {},
    outlineAttempts: [], visionQueue: [], visionHistory: [], conceptAttempts: [], paperRuns: [], ver: 3,
  };
}
function load(key = KEY) {
  const def = freshState();
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) return stripLegacyAiSecrets({ ...def, ...p }); // 舊版曾把供應商 key 混進狀態；載入時立即剔除
      try { localStorage.setItem(KEY + '_corrupt', raw); } catch (e) {} // 合法 JSON 但形狀不對（被竄改/舊格式寫成 null/陣列/純值）：備份壞值後回乾淨預設，避免磚化且無法自癒
    }
  } catch (e) {}
  return { ...def };
}
let saveQuotaErr = false; // localStorage 與 IndexedDB 都失敗時才亮紅燈；任一持久層成功都不算資料遺失
let statePersistErr = false;
function save() {
  S._mt = Date.now();
  let localOk = true;
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { localOk = false; }
  const idbAvailable = typeof indexedDB !== 'undefined';
  if (idbAvailable) {
    stateWrite(S).then(() => {
      statePersistErr = false;
      saveQuotaErr = false;
      if (typeof syncPill === 'function') try { syncPill(); } catch (_) {}
    }).catch(() => {
      statePersistErr = true;
      saveQuotaErr = !localOk;
      if (typeof syncPill === 'function') try { syncPill(); } catch (_) {}
    });
  } else {
    statePersistErr = true;
    saveQuotaErr = !localOk;
  }
  syncQueue();
  if (typeof renderDayCounter === 'function') try { renderDayCounter(); } catch (_) {} // 作答/速訓/類題記錄後，右上角今日計數即時更新
  return localOk || idbAvailable; // IndexedDB 是主儲存；localStorage 滿了也不誤報「沒有存下來」
}
function exportData() {
  // 分家後備份也要帶內容層（__content 欄位；匯入時會還原並剔除，不會污染 S）
  // 相容舊資料：匯出永遠剔除歷史 aikey 欄位；OpenAI secret 只存在 Edge Function，不會進前端狀態。
  const { aikey, aikeyTs, ...safe } = S;
  const payload = splitOn() && Object.keys(CONTENT.packs).length ? { ...safe, __content: CONTENT.packs } : safe;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mathA13-備份-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
/* 同 id 時取 rev 較大者（rev 預設 0）——修正版題包/內容包能覆蓋舊內容，不再被「舊的贏」擋掉。
   結果統計掛在 unionById.last = {added, updated, skipped} 供匯入回報。 */
function unionById(inc, cur) {
  const out = [...(cur || [])];
  const idx = new Map(out.map((x, i) => [x && x.id, i]));
  let added = 0, updated = 0, skipped = 0;
  for (const x of inc || []) {
    if (!x || !x.id) continue;
    if (!idx.has(x.id)) { idx.set(x.id, out.length); out.push(x); added++; }
    else {
      const i = idx.get(x.id);
      if ((x.rev || 0) > (out[i].rev || 0)) { out[i] = x; updated++; }
      else skipped++;
    }
  }
  unionById.last = { added, updated, skipped };
  return out;
}
/* IndexedDB 是主儲存、localStorage 是寫入失敗時的後備；兩邊可能各自握有獨有內容包。
   不能用「整包最大 rev」二選一，否則另一邊 rev 較小但獨有的 pack 會整包消失。
   逐 pack 取較新 metadata，items 仍做聯集（同 id 由 item rev 較大者勝）。 */
function mergePackStores(primary, fallback) {
  const a = primary || {}, b = fallback || {}, out = {};
  for (const pid of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const A = a[pid], B = b[pid];
    if (!A || !B) { out[pid] = A || B; continue; }
    const newer = (B.rev || 0) > (A.rev || 0) ? B : A;
    const older = newer === A ? B : A;
    const items = Array.isArray(newer.items) && Array.isArray(older.items)
      ? unionById(older.items, newer.items)
      : (Array.isArray(newer.items) ? newer.items : older.items);
    out[pid] = { ...older, ...newer, items };
  }
  return out;
}
/* 題目 schema 驗證：壞一題就可能炸掉整個做題 session，量產內容必混壞題，入庫前逐題過檢 */
function validateQ(q) {
  if (!q || typeof q.id !== 'string' || !q.id) return 'id 缺漏';
  if (!/^[\w.:-]+$/.test(q.id)) return 'id 含不合法字元'; // id 會進 inline onclick（jsA），限字元集斷絕注入面（現有題 id 全是英數/-/_/:/. ）
  if (['__proto__', 'constructor', 'prototype'].includes(q.id)) return 'id 不可用保留字'; // S.wrong[q.id]、Map 之外的物件索引會打到原型鏈
  if (!TOPICS[q.topic]) return `topic「${q.topic}」不存在`;
  if (!['single', 'multi', 'fill'].includes(q.type)) return `type「${q.type}」不合法`;
  if (![1, 2, 3].includes(q.diff)) return `diff「${q.diff}」不合法`;
  if (!q.q || typeof q.q !== 'string') return '題目 q 缺漏';
  if (q.type === 'fill') {
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => typeof a !== 'string' && typeof a !== 'number')) return 'fill 題 ans 必須是非空字串陣列';
  } else {
    if (!Array.isArray(q.opts) || q.opts.length < 2) return '選擇題 opts 至少 2 項';
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => !Number.isInteger(a) || a < 0 || a >= q.opts.length)) return 'ans 索引超界';
  }
  return null;
}
let BANK_MAP = null; // id → 題目（extbank 破千後 find 掃描會卡，統一走 Map）
function rebuildBankMap() { BANK_MAP = new Map(BANK.map((q) => [q.id, q])); }
const BUILTIN_N = BANK.length; // bank.js 內建題數：applyExtBank 重建時的切點
/* packOff 用「墓碑＋時間戳」{off,ts} 而非刪 key：刪 key 在雲端聯集合併下會讓「重新啟用」被舊旗標吃回去。舊格式 true 視同 {off:true,ts:0}。 */
function packIsOff(src) {
  const v = S.packOff && S.packOff[src];
  return v === true || !!(v && v.off);
}

/* ═══════════ 📦 內容層（內容/狀態分家） ═══════════
   題庫/重點/公式卡是「幾乎不變的內容」，作答紀錄是「一直變的狀態」——混在一包會讓每次作答
   整包上傳好幾 MB、localStorage 撞 5MB 上限（20+ 本講義必爆）。
   分家後：內容存 IndexedDB（本地）＋ content_packs 表（雲端，匯入才上傳），S 只剩輕狀態。
   啟用條件：雲端偵測到 content_packs 表（Dashboard 跑過 schema.sql 新段）→ 自動遷移並記住；
   表還沒建 → 完全維持舊行為（內容照舊放 S），零風險降級。 */
const SPLIT_LS = 'mathA13_split_v1';
const CONTENT_LS = 'mathA13_content_v1'; // IndexedDB 不可用時的後備
const CONTENT_LEGACY_CLAIM_KEY = 'mathA13_content_legacy_claimed_v1';
let CONTENT = { packs: {} }; // pack_id → { kind:'qpack'|'notes'|'flash'|'outline', name, rev, items:[…] }
function contentLocalStorageKey() {
  return `${CONTENT_LS}:${localScopePrefix()}`;
}
function contentLegacyClaimKey() {
  return `${CONTENT_LEGACY_CLAIM_KEY}:${localUserId() || 'anonymous'}`;
}
function contentLegacyClaimFinished() {
  try { return localStorage.getItem(contentLegacyClaimKey()) === '1'; } catch (_) { return false; }
}
function contentLegacyClaimMarkFinished() {
  try { localStorage.setItem(contentLegacyClaimKey(), '1'); } catch (_) {}
}
let contentTableMissing = false;
function splitOn() { try { return localStorage.getItem(SPLIT_LS) === '1'; } catch (e) { return false; } }
function extBankArr() { return splitOn() ? contentByKind('qpack') : (S.extbank || []); }
function extOutlineArr() { return splitOn() ? contentByKind('outline') : (S.extoutlines || []); }
function contentByKind(kind) {
  const out = [];
  for (const pid of Object.keys(CONTENT.packs)) {
    const p = CONTENT.packs[pid];
    if (p && p.kind === kind && Array.isArray(p.items)) out.push(...p.items);
  }
  return out;
}
let _idb = null;
function idbOpen() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((res, rej) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; rej(new Error('IDB open 逾時')); } }, 4000); // 逾時保底：別讓 boot 因升級被舊分頁擋住而永久白畫面
    if (typeof indexedDB === 'undefined') { clearTimeout(to); rej(new Error('IndexedDB 不可用')); return; }
    const rq = indexedDB.open('mathA13Content', 5);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs');
      if (!db.objectStoreNames.contains('errshots')) db.createObjectStore('errshots');
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      const inkStore = db.objectStoreNames.contains('inkrecords')
        ? rq.transaction.objectStore('inkrecords')
        : db.createObjectStore('inkrecords', { keyPath: 'client_id' });
      if (!inkStore.indexNames.contains('qid')) inkStore.createIndex('qid', 'qid', { unique: false });
      if (!inkStore.indexNames.contains('upload_state')) inkStore.createIndex('upload_state', 'upload_state', { unique: false });
      if (!inkStore.indexNames.contains('user_id')) inkStore.createIndex('user_id', 'user_id', { unique: false });
      const cursor = inkStore.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        const row = item.value || {};
        if (!row.upload_state) item.update({ ...row, upload_state: row.uploaded ? 'uploaded' : 'pending' });
        item.continue();
      };
    };
    rq.onsuccess = () => {
      if (done) { try { rq.result.close(); } catch (_) {} return; }
      done = true; clearTimeout(to); _idb = rq.result;
      _idb.onversionchange = () => { try { _idb.close(); } catch (_) {} _idb = null; }; // 別的分頁要升級時本頁自動關連線，不擋人（避免對方 onblocked 卡死）
      res(_idb);
    };
    rq.onerror = () => { if (done) return; done = true; clearTimeout(to); rej(rq.error); };
    rq.onblocked = () => {}; // 被舊分頁擋住：交給 timeout reject，呼叫端已容忍失敗（errShot*/contentInit 皆 try/catch）
  });
}
async function idbReadAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const st = db.transaction('packs').objectStore('packs');
    const out = {}, prefix = localScopePrefix();
    const mayClaimLegacy = currentUserOwnsLegacyData() && !contentLegacyClaimFinished();
    const rq = st.openCursor();
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c) { res(out); return; }
      const key = String(c.key || '');
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = c.value;
      else if (mayClaimLegacy && !key.startsWith('matha-scope:') && !Object.hasOwn(out, key)) out[key] = c.value;
      c.continue();
    };
    rq.onerror = () => rej(rq.error);
  });
}
async function idbWriteAll(packs) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('packs', 'readwrite');
    const st = tx.objectStore('packs'), prefix = localScopePrefix(), removeLegacy = currentUserOwnsLegacyData();
    const rq = st.openCursor();
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c) {
        for (const k of Object.keys(packs)) st.put(packs[k], prefix + k);
        return;
      }
      const key = String(c.key || '');
      if (key.startsWith(prefix) || (removeLegacy && !key.startsWith('matha-scope:'))) c.delete();
      c.continue();
    };
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function stateRead() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const store = db.transaction('state').objectStore('state');
    const rq = store.get(`current:${KEY}`);
    rq.onsuccess = () => {
      if (rq.result || KEY !== LEGACY_KEY) { res(rq.result || null); return; }
      const legacy = store.get('current');
      legacy.onsuccess = () => res(legacy.result || null);
      legacy.onerror = () => rej(legacy.error);
    };
    rq.onerror = () => rej(rq.error);
  });
}
async function stateWrite(state) {
  const db = await idbOpen();
  const snapshot = { updatedAt: Number(state && state._mt) || Date.now(), state: stripLegacyAiSecrets(state) };
  return new Promise((res, rej) => {
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(snapshot, `current:${KEY}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('本機狀態寫入中止'));
  });
}
function legacyOwnerId() {
  try { return localStorage.getItem(LEGACY_OWNER_KEY) || ''; } catch (_) { return ''; }
}
function inkRecordVisibleToCurrentUser(row) {
  if (!row) return false;
  const uid = syncState && syncState.user && syncState.user.id;
  if (uid) return row.user_id === uid || (!row.user_id && legacyOwnerId() === uid);
  return !row.user_id && !legacyOwnerId();
}
async function activateUserState(user) {
  const uid = user && user.id;
  if (!uid) return false;
  const previousKey = KEY;
  const targetKey = userStateKey(uid);
  if (previousKey !== targetKey) {
    try { localStorage.setItem(previousKey, JSON.stringify(S)); } catch (_) {}
    await stateWrite(S).catch(() => {});
  }
  let owner = legacyOwnerId();
  if (!owner) {
    owner = uid;
    try { localStorage.setItem(LEGACY_OWNER_KEY, uid); } catch (_) {}
  }
  let scoped = null;
  try { scoped = localStorage.getItem(targetKey); } catch (_) {}
  if (!scoped && owner === uid) {
    const legacy = load(LEGACY_KEY);
    try { localStorage.setItem(targetKey, JSON.stringify(legacy)); } catch (_) {}
  }
  KEY = targetKey;
  try { localStorage.setItem(ACTIVE_USER_KEY, uid); } catch (_) {}
  S = load(KEY);
  await stateInit();
  await refreshInkLocalStatus();
  CONTENT = { packs: {} };
  await contentInit();
  applyExtBank();
  return true;
}
async function deactivateUserState() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
    localStorage.removeItem(ACTIVE_USER_KEY);
  } catch (_) {}
  await stateWrite(S).catch(() => {});
  KEY = ANONYMOUS_KEY;
  S = freshState();
  await refreshInkLocalStatus();
  CONTENT = { packs: {} };
  await contentInit();
  applyExtBank();
}
/* localStorage 只保留同步啟動用的鏡像；真正的本機權威副本在 IndexedDB。
   兩邊都存在時仍做聯集，並讓修改時間較新的副本決定非紀錄欄位。 */
async function stateInit() {
  try {
    const row = await stateRead();
    if (!row || !row.state || typeof row.state !== 'object') {
      await stateWrite(S);
      return;
    }
    const localMt = Number(S && S._mt) || 0;
    const idbMt = Number(row.updatedAt || row.state._mt) || 0;
    S = idbMt > localMt ? mergeState(row.state, S) : mergeState(S, row.state);
    S._mt = Math.max(localMt, idbMt, Date.now());
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {}
    await stateWrite(S);
  } catch (_) {
    statePersistErr = true;
  }
}
function inkClientId(qid, t0) {
  const rnd = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ink-${String(qid || 'unknown').replace(/[^\w.-]/g, '_')}-${Number(t0) || Date.now()}-${rnd}`;
}
async function inkRecordPut(record) {
  const db = await idbOpen();
  const row = {
    ...record,
    upload_state: record && record.uploaded ? 'uploaded' : 'pending',
    updatedAt: Date.now(),
  };
  return new Promise((res, rej) => {
    const tx = db.transaction('inkrecords', 'readwrite');
    tx.objectStore('inkrecords').put(row);
    tx.oncomplete = () => res(row);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('筆跡寫入中止'));
  });
}
async function inkRecordAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('inkrecords').objectStore('inkrecords').getAll();
    rq.onsuccess = () => res(Array.isArray(rq.result) ? rq.result : []);
    rq.onerror = () => rej(rq.error);
  });
}
async function inkRecordByQid(qid) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const store = db.transaction('inkrecords').objectStore('inkrecords');
    const request = store.indexNames.contains('qid') ? store.index('qid').getAll(qid) : store.getAll();
    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? request.result : [];
      res(rows.filter((row) => row && row.qid === qid));
    };
    request.onerror = () => rej(request.error);
  });
}
async function inkRecordPending(limit = 80) {
  try {
    const db = await idbOpen();
    const rows = await new Promise((res, rej) => {
      const store = db.transaction('inkrecords').objectStore('inkrecords');
      if (!store.indexNames.contains('upload_state')) {
        const request = store.getAll();
        request.onsuccess = () => res(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => rej(request.error);
        return;
      }
      const out = [];
      const request = store.index('upload_state').openCursor('pending');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || out.length >= Math.max(1, Number(limit) || 80)) { res(out); return; }
        if (inkRecordVisibleToCurrentUser(cursor.value)) out.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => rej(request.error);
    });
    return rows.filter((row) => inkRecordVisibleToCurrentUser(row) && !row.uploaded && row.strokes)
      .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
      .slice(0, Math.max(1, Number(limit) || 80));
  }
  catch (_) { return []; }
}
async function inkRecordMarkUploaded(clientId, sentUpdatedAt, userId) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('inkrecords', 'readwrite');
    const store = tx.objectStore('inkrecords');
    const request = store.get(clientId);
    let marked = false;
    request.onsuccess = () => {
      const current = request.result;
      if (!current || Number(current.updatedAt || 0) > Number(sentUpdatedAt || 0)) return;
      store.put({
        ...current,
        user_id: userId || current.user_id || null,
        uploaded: true,
        upload_state: 'uploaded',
        uploadedAt: Date.now(),
      });
      marked = true;
    };
    request.onerror = () => rej(request.error);
    tx.oncomplete = () => res(marked);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('筆跡同步狀態更新中止'));
  });
}
async function inkRecordStats() {
  try {
    const db = await idbOpen();
    const uid = syncState && syncState.user && syncState.user.id;
    const total = await new Promise((res, rej) => {
      const store = db.transaction('inkrecords').objectStore('inkrecords');
      const request = uid && store.indexNames.contains('user_id') ? store.index('user_id').count(uid) : store.count();
      request.onsuccess = () => res(Number(request.result) || 0);
      request.onerror = () => rej(request.error);
    });
    const pending = await new Promise((res, rej) => {
      const store = db.transaction('inkrecords').objectStore('inkrecords');
      if (!store.indexNames.contains('upload_state')) { res(0); return; }
      let count = 0;
      const request = store.index('upload_state').openCursor('pending');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { res(count); return; }
        if (inkRecordVisibleToCurrentUser(cursor.value)) count++;
        cursor.continue();
      };
      request.onerror = () => rej(request.error);
    });
    return { total, pending };
  } catch (_) { return { total: 0, pending: 0 }; }
}
let inkLocalStatus = { total: 0, pending: 0 };
async function refreshInkLocalStatus() {
  inkLocalStatus = await inkRecordStats();
  return inkLocalStatus;
}
let inkCheckpointTimer = null;
function inkCheckpoint(force) {
  if (!ink || !sessionInk[ink.qid]) return Promise.resolve(false);
  const current = ink;
  const persist = async () => {
    const st = sessionInk[current.qid];
    if (!st) return false;
    const strokes = st.s.filter((s) => s.t0 >= current.t0);
    const eras = st.e.filter((t) => t >= current.t0);
    if (!strokes.length && !eras.length) return false;
    await inkRecordPut({
      client_id: current.clientId,
      user_id: syncState.user ? syncState.user.id : null,
      qid: current.qid,
      t0: current.t0,
      proc: { draft: true },
      strokes: { s: strokes, e: eras },
      uploaded: false,
    });
    if (syncState.user) flushInkQueue();
    return true;
  };
  clearTimeout(inkCheckpointTimer);
  if (force) return persist().catch(() => { statePersistErr = true; return false; });
  inkCheckpointTimer = setTimeout(() => persist().catch(() => { statePersistErr = true; }), 250);
  return Promise.resolve(true);
}
async function contentInit() {
  if (!splitOn()) return;
  // 逐 pack 合併兩個來源：IDB 可讀但曾寫失敗時，剛匯入的內容可能只在 localStorage 後備裡。
  let idb = null, ls = null;
  try { idb = await idbReadAll(); } catch (e) {}
  try {
    const scoped = localStorage.getItem(contentLocalStorageKey());
    const legacy = currentUserOwnsLegacyData() && !contentLegacyClaimFinished() ? localStorage.getItem(CONTENT_LS) : null;
    if (scoped) ls = JSON.parse(scoped);
    if (legacy) ls = mergePackStores(ls, JSON.parse(legacy));
  } catch (e) {}
  CONTENT.packs = mergePackStores(idb, ls);
  // 第一個核准帳號接收舊版未分帳內容後，立即複製到自己的 scope 並移除全域舊副本，
  // 後續刪除／停用才不會被 legacy pack 再次復活。
  if (currentUserOwnsLegacyData() && Object.keys(CONTENT.packs).length) await persistContent();
}
function persistContent() {
  // 回傳 promise<boolean>：true=已落地（IDB 或 localStorage 後備成功），false=兩者皆失敗（空間不足/隱私模式）。
  // 匯入/停用後要「等寫完再 reload」，否則 IDB 交易還沒 commit 就重載＝內容遺失；遷移前要靠回傳值確認落地才敢刪舊副本。
  const finishLegacyClaim = () => {
    if (currentUserOwnsLegacyData()) {
      contentLegacyClaimMarkFinished();
      try { localStorage.removeItem(CONTENT_LS); } catch (_) {}
    }
    return true;
  };
  return idbWriteAll(CONTENT.packs).then(finishLegacyClaim).catch(() => {
    try {
      localStorage.setItem(contentLocalStorageKey(), JSON.stringify(CONTENT.packs));
      return finishLegacyClaim();
    }
    catch (e) { saveQuotaErr = true; try { syncPill(); } catch (_) {} return false; }
  });
}
/* 等內容確實寫入本機後再重載：寫入 → 讀回驗證 → 才 reload（IDB 非同步，reload 不能搶在 commit 前）。
   驗證失敗就再試一次；仍失敗也照樣 reload（頂多重匯入一次），不卡住使用者。 */
async function reloadAfterContent() {
  const want = Object.keys(CONTENT.packs).reduce((n, k) => n + ((CONTENT.packs[k].items || []).length), 0);
  for (let tries = 0; tries < 2; tries++) {
    await persistContent();
    try {
      const back = await idbReadAll();
      const got = Object.keys(back).reduce((n, k) => n + ((back[k].items || []).length), 0);
      if (got >= want) break;
    } catch (e) { break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  location.reload();
}
/* 匯入/遷移共用：把 items 併進（或建立）一個 pack；unionById.last 供回報 */
/* 併入（或建立）一個 pack。只有 items 真的增/改時才 bump rev＋回傳 true，
   否則保留舊 rev——避免過渡期反覆遷移同一份 extbank 時每次都製造新 rev、觸發整包重傳。 */
function upsertPack(pid, kind, name, items) {
  const old = CONTENT.packs[pid];
  const merged = unionById(items, old ? old.items : []);
  const st = unionById.last || {};
  const changed = !old || (st.added || 0) > 0 || (st.updated || 0) > 0;
  CONTENT.packs[pid] = { kind, name: name || (old && old.name) || pid, rev: changed ? Date.now() : old.rev, items: merged };
  return changed;
}
/* 舊資料遷移：S 裡的 extbank/extflash/extnotes/extoutlines 搬進內容層（跨裝置 merge 進來的舊包也走這裡） */
async function migrateContentFromS() {
  let moved = false; const changedPids = [];
  const doPack = (pid, kind, nm, items) => { if (upsertPack(pid, kind, nm, items)) changedPids.push(pid); moved = true; };
  if (Array.isArray(S.extbank) && S.extbank.length) {
    const bySrc = Object.create(null); // 同 packCard：src 不可信，"__proto__" 不得打到原型鏈
    for (const q of S.extbank) (bySrc[q.src || '未標來源'] = bySrc[q.src || '未標來源'] || []).push(q);
    for (const src of Object.keys(bySrc)) doPack('legacy-' + strHash(src), 'qpack', src, bySrc[src]);
  }
  if (Array.isArray(S.extflash) && S.extflash.length) doPack('legacy-flash', 'flash', '匯入公式卡', S.extflash);
  if (Array.isArray(S.extnotes) && S.extnotes.length) doPack('legacy-notes', 'notes', '匯入重點', S.extnotes);
  if (Array.isArray(S.extoutlines) && S.extoutlines.length) doPack('legacy-outline', 'outline', '十一單元大綱', S.extoutlines);
  if (moved) {
    if (changedPids.length) { // 先確認新副本真的落地，再刪舊的——否則 IDB 不可用又 localStorage 配額滿時會兩頭皆空
      const durable = await persistContent();
      if (!durable) { try { alert('這台裝置存不下匯入的內容（空間不足或隱私模式），已保留在原位置不清除、避免遺失。請釋放空間或換裝置後再登入。'); } catch (e) {} return moved; }
    }
    delete S.extbank; delete S.extflash; delete S.extnotes; delete S.extoutlines;
    save(); // S 瘦身上雲（此時內容已在本機內容層 durable）
    for (const pid of changedPids) pushPack(pid); // 只在內容真的變了才重傳
  }
  return moved;
}
function pushPack(pid) {
  if (!supa || !syncState.user || !splitOn()) return;
  const p = CONTENT.packs[pid];
  if (!p || p.curated) return; // 官方私有題庫由唯讀 Storage 發布，不複製進每位使用者的 content_packs
  supa.from('content_packs')
    .upsert({ user_id: syncState.user.id, pack_id: pid, kind: p.kind, name: p.name, rev: p.rev, items: p.items, updated_at: new Date().toISOString() })
    .then(({ error }) => { if (error) { syncState.msg = '內容包上傳失敗：' + error.message; syncPill(); } });
}
/* 登入後：偵測 content_packs 表 → 啟用分家＋遷移；已啟用則做內容差異同步 */
async function probeContent() {
  if (!supa || !syncState.user) return;
  if (!splitOn()) {
    const { error } = await supa.from('content_packs').select('pack_id').limit(1);
    if (error) contentTableMissing = true;
    else {
      try { localStorage.setItem(SPLIT_LS, '1'); } catch (e) { return; }
      contentTableMissing = false;
    }
  }
  if (splitOn()) {
    await migrateContentFromS();
    await pullContent();
  }
  await pullCuratedContent();
}
async function pullContent() {
  if (!supa || !syncState.user || !splitOn()) return;
  try {
    const { data, error } = await supa.from('content_packs').select('pack_id,kind,name,rev');
    if (error || !data) return;
    let changed = false;
    for (const r of data) {
      const local = CONTENT.packs[r.pack_id];
      if (local && (local.rev || 0) === (r.rev || 0)) continue; // 只有 rev 完全相同＝真同步才略過；本地較新也要拉回合併，否則另一台的離線分歧題會被此機下次回推蓋掉
      const { data: row } = await supa.from('content_packs').select('*').eq('pack_id', r.pack_id).maybeSingle();
      if (row && Array.isArray(row.items)) {
        // 聯集而非整包覆蓋：兩台各自離線塞進同名 pack 時，本地獨有題不被雲端版丟掉（跟 app 其他合併路徑一致）
        const merged = local ? unionById(row.items, local.items) : row.items;
        const localExtra = !!local && merged.length > row.items.length; // 本地有雲端沒有的題＝這是超集，rev 要 bump 才會在下面回推迴圈傳回雲端與他機，否則永困單機
        CONTENT.packs[r.pack_id] = { kind: row.kind, name: row.name, rev: localExtra ? Date.now() : Math.max(row.rev || 0, (local && local.rev) || 0), items: merged };
        changed = true;
      }
    }
    for (const pid of Object.keys(CONTENT.packs)) { // 本地較新（離線匯入過）→ 補推
      if (CONTENT.packs[pid] && CONTENT.packs[pid].curated) continue;
      const remote = data.find((r) => r.pack_id === pid);
      if (!remote || (remote.rev || 0) < (CONTENT.packs[pid].rev || 0)) pushPack(pid);
    }
    if (changed) { persistContent(); applyExtBank(); updateBadge(); }
  } catch (e) {}
}

const CURATED_BUCKET = 'matha-content';
const CURATED_MANIFEST = 'manifest.json';
const CURATED_HEALTH_LS = 'mathA13_curated_health_v1';
function loadCuratedHealth() {
  try {
    const value = JSON.parse(localStorage.getItem(CURATED_HEALTH_LS) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}
function persistCuratedHealth() {
  try { localStorage.setItem(CURATED_HEALTH_LS, JSON.stringify(curatedState)); } catch (_) {}
}
let curatedState = { status: 'idle', count: 0, error: '', ...(loadCuratedHealth() || {}) };
function curatedManifestValid(m) {
  return !!(m && m.schema === 1 && m.visibility === 'authenticated' && Array.isArray(m.packs)
    && m.packs.every((p) => p && typeof p.id === 'string' && /^curated-[\w-]+$/.test(p.id)
      && typeof p.file === 'string' && !p.file.includes('..') && !p.file.startsWith('/')
      && Number.isInteger(Number(p.count)) && Number(p.count) >= 0
      && typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256)));
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function rerenderActiveView() {
  if (sessionActive) return;
  const active = document.querySelector('nav button.active');
  const view = active && active.dataset && active.dataset.view;
  if (view && VIEWS[view]) VIEWS[view].fn();
}
/* 私有官方題庫：登入後從 Supabase Storage 唯讀下載，逐檔驗 SHA-256，再快取到 IndexedDB。
   GitHub Pages 只含載入器，不公開講義抽取內容；manifest 移除的舊包也會從本機快取撤回。 */
async function pullCuratedContent() {
  if (!supa || !syncState.user || !supa.storage) return false;
  curatedState = { ...curatedState, status: 'loading', count: curatedState.count || 0, error: '' };
  syncState.msg = '正在核對私有題庫'; syncPill();
  try {
    const bucket = supa.storage.from(CURATED_BUCKET);
    const manifestRes = await bucket.download(CURATED_MANIFEST);
    if (manifestRes.error || !manifestRes.data) throw new Error((manifestRes.error && manifestRes.error.message) || 'manifest 下載失敗');
    const manifestBytes = await manifestRes.data.arrayBuffer();
    const manifestSha = await sha256Bytes(manifestBytes);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!curatedManifestValid(manifest)) throw new Error('manifest 格式或存取層級不正確');
    const keep = new Set(manifest.packs.map((p) => p.id));
    let changed = false;
    let count = 0;
    for (const meta of manifest.packs) {
      count += Number(meta.count) || 0;
      const local = CONTENT.packs[meta.id];
      if (local && local.curated && local.sha256 === meta.sha256 && Array.isArray(local.items)) continue;
      const packRes = await bucket.download(meta.file);
      if (packRes.error || !packRes.data) throw new Error(`${meta.name || meta.file} 下載失敗`);
      const bytes = await packRes.data.arrayBuffer();
      if ((await sha256Bytes(bytes)) !== meta.sha256) throw new Error(`${meta.name || meta.file} 完整性驗證失敗`);
      const envelope = JSON.parse(new TextDecoder().decode(bytes));
      if (!envelope || envelope.kind !== 'qpack' || !Array.isArray(envelope.items)) throw new Error(`${meta.name || meta.file} 不是題包`);
      const items = envelope.items.filter((q) => !validateQ(q) && !(q.needsFigure && !q.fig) && !outOfRange(q));
      CONTENT.packs[meta.id] = { kind: 'qpack', name: meta.name || envelope.name || meta.id, rev: Date.parse(manifest.generatedAt) || 1, sha256: meta.sha256, curated: true, items };
      changed = true;
    }
    for (const pid of Object.keys(CONTENT.packs)) {
      if (CONTENT.packs[pid] && CONTENT.packs[pid].curated && !keep.has(pid)) { delete CONTENT.packs[pid]; changed = true; }
    }
    if (!splitOn()) localStorage.setItem(SPLIT_LS, '1');
    if (changed && !(await persistContent())) throw new Error('本機空間不足，私有題庫無法快取');
    applyExtBank(); updateBadge();
    curatedState = {
      status: 'ready',
      count,
      total: BUILTIN_N + count,
      packCount: manifest.packs.length,
      generatedAt: manifest.generatedAt || null,
      manifestSha,
      lastChecked: new Date().toISOString(),
      error: '',
    };
    persistCuratedHealth();
    syncState.msg = `私有題庫已載入 ${count} 題`; syncPill();
    rerenderActiveView();
    return true;
  } catch (e) {
    curatedState = { ...curatedState, status: 'error', error: (e && e.message) || String(e), lastFailure: new Date().toISOString() };
    persistCuratedHealth();
    syncState.msg = '私有題庫暫時無法載入；內建題庫仍可使用'; syncPill();
    rerenderActiveView();
    return false;
  }
}
/* 超出「學測數A」範圍的題目過濾（依教育部108數學領綱 + 大考中心命題範圍實查裁定）。
   只在此攔匯入題(含使用者另外匯入的 115數B/講義)，故已匯入雲端的舊題下次載入即自動剔除、不必重匯。
   ⚠️ 只鎖「明確、無歧義」的超範圍，避免誤殺同名的範圍內內容：
   - cot/sec/csc「直接入題」：領綱 F-11A-1 標 ※＝「建議不納入全國性考試」→ 學測只考 sin/cos/tan。
     只比對題幹(q)不比對詳解——詳解裡把 1+tan²=sec² 當中間恆等式的在範圍題(如 trig p85)要留著。
   - 十分逼近法「具名法」：屬國中 N-8-2；高一 N-10-1 只承接「無理數十進制估算」概念，學測不會用這名字命題。
   刻意不鎖的(領綱查證為範圍內，別加)：循環小數化分數(高一代數可解)、敘述統計變異數/標準差、
   古典機率期望值、條件機率/貝氏、排列組合/二項式展開、直線參數式、兩圓為配圖的正餘弦定理題。 */
const OUT_OF_RANGE_RE = [
  /\\(?:cot|sec|csc)\b/,   // 直接考餘切/正割/餘割（LaTeX 命令）＝ ※ 排除
  /(?:餘切|正割|餘割)\s*函數/, // 中文寫法（保守：要接「函數」才算，避免誤傷）
  /十分逼近法/,            // 國中具名法
];
function outOfRange(q) {
  const stem = String((q && q.q) || '');
  return OUT_OF_RANGE_RE.some((re) => re.test(stem));
}
let outRangeSkipped = 0; // 供 UI/回報顯示這輪濾掉幾題
function applyExtBank() {
  BANK.length = BUILTIN_N; // 冪等重建：內容更新（rev 覆蓋/停用切換/雲端拉回）直接重灌外部段
  const ext = extBankArr();
  const have = new Set(BANK.map((q) => q.id));
  outRangeSkipped = 0;
  for (const q of ext) {
    if (!q || !q.id || have.has(q.id)) continue;
    if (q.needsFigure && !q.fig) continue; // 需要圖才能解、圖還沒補上的題不出（避免無圖硬解）
    if (q.dup) continue; // 內容重複題（講義收錄的歷屆題等）：只出正主，不出分身
    if (q.src && packIsOff(q.src)) continue; // 使用者停用的內容包
    if (outOfRange(q)) { outRangeSkipped++; continue; } // 超出學測數A範圍（cot/sec/csc、十分逼近法…）
    if (validateQ(q)) continue; // 壞題（雲端舊資料也可能有）擋在庫外，避免炸 render
    BANK.push(q); have.add(q.id);
  }
  rebuildBankMap();
}
/* 題包匯入（qpack）：逐題驗證、rev 覆蓋、結果回報 */
function importQPack(items, name) {
  const bad = [];
  const good = items.filter((q) => {
    const err = validateQ(q);
    if (err) bad.push(`${(q && q.id) || '(無id)'}：${err}`);
    return !err;
  });
  if (!good.length) { alert(`這包題目全部沒過驗證，未匯入。\n${bad.slice(0, 10).join('\n')}${bad.length > 10 ? `\n…共 ${bad.length} 題` : ''}`); return; }
  if (!confirm(`題包${name ? '「' + name + '」' : ''}：${good.length} 題通過驗證${bad.length ? `、${bad.length} 題有問題被擋下` : ''}。併入後刷題與模擬會自動納入，確定？`)) return;
  let st;
  let splitPid = null;
  if (splitOn()) { // 內容層：進 pack、不進 S（作答同步不再揹著題庫跑）
    splitPid = 'imp-' + strHash(name || 'qpack');
    upsertPack(splitPid, 'qpack', name || '匯入題包', good);
    st = unionById.last || {};
  } else {
    S.extbank = unionById(good, S.extbank);
    st = unionById.last || {};
    if (!save()) { alert('本機儲存空間已滿，這包沒有存下來——先匯出備份或清理空間再試。'); return; }
  }
  if (bad.length) console.table(bad);
  alert(`完成：新增 ${st.added || 0} 題、更新 ${st.updated || 0} 題、略過 ${st.skipped || 0} 題（版本相同）。外部題庫共 ${extBankArr().length} 題。${bad.length ? `\n\n被擋下 ${bad.length} 題：\n${bad.slice(0, 5).join('\n')}${bad.length > 5 ? `\n…其餘見主控台` : ''}` : ''}`);
  if (splitPid) { pushPack(splitPid); reloadAfterContent(); } else location.reload(); // 等 IDB 寫完再 reload
}
function importData(input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = async () => {
    try {
      const d = JSON.parse(r.result);
      // 內容信封 v2：{kind:'qpack'|'flash'|'notes'|'outline', name, items:[…]}
      if (d && d.kind && !Array.isArray(d.items)) { alert(`內容包格式不對：items 必須是陣列（kind=${String(d.kind)}）。`); return; } // alert 是純文字對話框，escH 反而會顯示出 &lt; 實體
      if (d && d.kind && Array.isArray(d.items)) {
        if (d.kind === 'qpack') { importQPack(d.items, d.name); return; }
        if (d.kind === 'flash' || d.kind === 'notes' || d.kind === 'outline') {
          if (d.kind === 'outline') {
            const ok = d.items.filter((x) => x && /^outline-(?:[1-9]|1[01])$/.test(String(x.id || ''))
              && typeof x.title === 'string' && x.title.trim() && typeof x.reference === 'string' && x.reference.trim());
            if (ok.length !== 11) { alert('大綱包必須剛好包含 outline-1 到 outline-11，且每份都有 title 與 reference。'); return; }
            if (!confirm(`十一單元大綱包${d.name ? '「' + d.name + '」' : ''}已完整辨識。匯入後 AI 會以它作為私人對照答案，確定？`)) return;
            let st, spid = null;
            if (splitOn()) {
              spid = 'teacher-outline-11';
              upsertPack(spid, 'outline', d.name || '十一單元大綱', ok);
              st = unionById.last || {};
            } else {
              S.extoutlines = unionById(ok, S.extoutlines);
              st = unionById.last || {};
              if (!save()) { alert('本機儲存空間已滿，大綱沒有存下來。'); return; }
            }
            alert(`完成：十一張大綱新增 ${st.added || 0}、更新 ${st.updated || 0}。內容只存你的私人內容層，不會寫入公開題庫。`);
            if (spid) { pushPack(spid); reloadAfterContent(); } else location.reload();
            return;
          }
          const isF = d.kind === 'flash';
          const ok = d.items.filter((x) => isF ? (x && x.id && x.front && x.back && TOPICS[x.unit]) : (x && x.id && TOPICS[x.topic] && x.title && x.html));
          if (!ok.length) { alert(isF ? '這包公式卡格式不對（每張需 id/unit/front/back）。' : '這包重點整理格式不對（每條需 id/topic/title/html）。'); return; }
          if (!confirm(`${isF ? '公式卡包' : '重點整理包'}${d.name ? '「' + d.name + '」' : ''}：${ok.length} ${isF ? '張' : '條'}。確定匯入？`)) return;
          let st, spid = null;
          if (splitOn()) {
            spid = 'imp-' + strHash((d.name || d.kind) + ':' + d.kind);
            upsertPack(spid, d.kind, d.name || (isF ? '匯入公式卡' : '匯入重點'), ok);
            st = unionById.last || {};
          } else {
            if (isF) S.extflash = unionById(ok, S.extflash); else S.extnotes = unionById(ok, S.extnotes);
            st = unionById.last || {};
            if (!save()) { alert('本機儲存空間已滿，這包沒有存下來。'); return; }
          }
          alert(`完成：新增 ${st.added || 0}、更新 ${st.updated || 0} ${isF ? '張' : '條重點'}。`);
          if (spid) { pushPack(spid); reloadAfterContent(); } else location.reload();
          return;
        }
        alert(`不認得的內容包 kind：「${d.kind}」（支援 qpack / flash / notes / outline）。`);
        return;
      }
      if (d && Array.isArray(d.extbank) && !Array.isArray(d.attempts)) {
        // 舊版題包檔（無信封）：走同一條驗證匯入
        importQPack(d.extbank, d.name);
        return;
      }
      if (!d || !Array.isArray(d.attempts)) { alert('這不是本系統的備份檔（缺 attempts 欄位）。'); return; }
      const cur = S.attempts.length;
      if (!confirm(`備份檔含 ${d.attempts.length} 筆作答紀錄、${Object.keys(d.wrong || {}).length} 題錯題。\n匯入會覆蓋目前這個瀏覽器裡的 ${cur} 筆紀錄，確定？`)) return;
      const content = d.__content; // 分家版備份的內容層（qpack/notes/flash 包）
      delete d.__content;
      if (splitOn()) {
        // 分家裝置：內容進 IDB。備份自帶內容層就用它；否則把備份 S 裡的 legacy ext* 搬進內容層（不然分家模式讀不到）
        CONTENT.packs = content || {};
        S = d;
        if (!content) await migrateContentFromS(); // 會用 S.ext* 建 pack、確認落地後才清掉 S.ext*、save
        else { save(); }
        reloadAfterContent(); // 等 IDB 寫完＋讀回驗證再 reload
        return;
      }
      // 非分家裝置：若備份帶內容層，把它攤回 S 的 legacy 欄位，別丟失
      if (content) {
        for (const pid of Object.keys(content)) {
          const p = content[pid]; if (!p || !Array.isArray(p.items)) continue;
          const f = p.kind === 'flash' ? 'extflash' : p.kind === 'notes' ? 'extnotes' : p.kind === 'outline' ? 'extoutlines' : 'extbank';
          d[f] = unionById(p.items, d[f]);
        }
      }
      S = d; save(); location.reload();
    } catch (e) { alert('讀取失敗：' + e.message); }
  };
  r.readAsText(f);
  input.value = '';
}
function backupCard() {
  return `<div class="card"><h2>💾 資料備份與匯入</h2>
    <p class="dim">雲端同步是主備份；這裡是額外的離線副本。「匯入」也接受私人題包與十一單元大綱包（qpack / outline 格式的 .json）。</p>
    <div class="actr"><button class="btn" onclick="exportData()">匯出備份（.json）</button>
    <button class="btn" onclick="$('#impfile').click()">匯入備份 / 內容包</button>
    <button class="btn" onclick="exportInk()">匯出今日筆跡</button></div>
    <input type="file" id="impfile" accept=".json,application/json" style="display:none" onchange="importData(this)">
  </div>`;
}

/* ═══════════ ✍️ 手寫過程紀錄（平板＋觸控筆） ═══════════
   單一書寫面：整卡計算紙（#ink-cv 蓋滿題卡，題目印在底下處處可寫）。每一筆帶時間戳與顏色。
   只認觸控筆與滑鼠——手掌/手指不會畫線、也不會誤觸捲動（兩指手勢才捲動）。
   自動偵測：起筆猶豫、題中停頓（≥15s）、塗改（復原）、尾段放棄（最後一筆到送出）。
   （2026-07-12 清理：早期「題目畫記(q)/答案區(a)」雙畫布已死多時——#qink-cv/#ans-cv 從不渲染、
   st.q/st.a 恆空，所有三面分支一併移除；雲端 strokes 欄位仍相容舊格式讀取。） */
const HES_GAP = 15000;
const INK_W = 1.35; // 筆跡粗細（原本 2 的 2/3）
const INK_COLORS = { k: '#1f2937', r: '#dc2626', g: '#15803d' };
// Pointer Events 標準側鍵是 buttons=2；三星 Chrome 也會把 S Pen 側鍵回報成
// button=1 / buttons=4，因此筆尖接觸時常見的組合是 buttons=5（筆尖 1＋側鍵 4）。
const SPEN_ERASE_BUTTONS = 2 | 4 | 32 | 64;
let inkColor = 'k';
let ink = null;
let replaying = false;
const sessionInk = {}; // qid → { s:筆畫, e:塗改時間, m:批改標記 }
const inkSessionIds = new Map(); // qid|t0 → 本次作答固定 client_id，草稿與完稿用同一列冪等更新

function inkStore(qid) {
  return (sessionInk[qid] = sessionInk[qid] || { s: [], e: [] });
}
function inkToolsHTML() {
  return `<span class="ink-tools">
      <button class="btn sm inkc" id="ink-c-k" onclick="inkColorSet('k')"><span class="dot" style="background:${INK_COLORS.k}"></span>黑</button>
      <button class="btn sm inkc" id="ink-c-r" onclick="inkColorSet('r')"><span class="dot" style="background:${INK_COLORS.r}"></span>紅</button>
      <button class="btn sm inkc" id="ink-c-g" onclick="inkColorSet('g')"><span class="dot" style="background:${INK_COLORS.g}"></span>綠</button>
      <button class="btn sm" onclick="inkUndo()">↩ 復原</button>
      <button class="btn sm" onclick="inkExtend(320)">⬇ 加長</button>
      <span id="ink-s-pen-status" class="ink-s-pen-status" aria-live="polite" hidden></span>
    </span>`;
}
function inkSurface(key, cv, h) {
  // allowTouch＝手機筆記卡：手指就是筆（單指畫、第二指加入改捲動）；平板題卡維持只認筆、手掌免疫
  const sur = { key, cv, ctx: cv.getContext('2d'), h, cur: null, pointer: null, gestureMode: null, sPenButtonHeld: false, touches: new Map(), allowTouch: cv.dataset.touch === '1' };
  cv.style.pointerEvents = '';
  cv.onpointerdown = (e) => inkDown(e, sur);
  cv.onpointermove = (e) => inkMove(e, sur);
  cv.onpointerup = cv.onpointercancel = cv.onlostpointercapture = (e) => inkUp(e, sur); // lostpointercapture：系統邊緣手勢搶走已捕捉的指、不發 pointerup 時也清掉幽靈觸點，避免手機筆記卡卡在捲動模式（死指）。inkUp 冪等，正常收筆多跑一次無害
  cv.oncontextmenu = (e) => inkContextMenu(e, sur);
  return sur;
}
function inkArr() { return inkStore(ink.qid).s; }
function inkStart(qid, t0, since) {
  const cv = $('#ink-cv'); if (!cv) return;
  replaying = false; // 換題即解除回放鎖，避免上一題的回放把新題的筆鎖死
  const st = inkStore(qid);
  // 歸檔舊筆跡：同一題再次作答時不重現上次內容（模擬第二輪傳 sessT0 保留第一輪）
  const cut = since != null ? since : t0;
  for (const s of st.s) if (!s.dead && !s.arch && s.t0 < cut) s.arch = 1;
  if (st.m) for (const m of st.m) if (!m.arch && m.t < cut) m.arch = 1; // 舊批改標記一起歸檔
  let maxY = 0;
  for (const s of st.s) if (!s.dead && !s.arch) for (const p of s.pts) if (p[1] > maxY) maxY = p[1];
  const base = +cv.dataset.h || 0;
  const h = base
    ? Math.max(base, Math.ceil(maxY + 80))
    : Math.max(340, Math.round(window.innerHeight * 0.45), Math.ceil(maxY + 80));
  const sessionKey = `${qid}|${t0}`;
  const clientId = inkSessionIds.get(sessionKey) || inkClientId(qid, t0);
  inkSessionIds.set(sessionKey, clientId);
  ink = { qid, t0, clientId, penAt: 0, sur: {} };
  ink.sur.calc = inkSurface('calc', cv, h);
  if (cv.classList.contains('qink') && window.ResizeObserver) { // 整卡書寫層：卡片高度隨 KaTeX/加長/展開打字欄變動，畫布跟著重算
    ink.ro = new ResizeObserver(() => { if (ink && ink.sur.calc) inkSizeSur(ink.sur.calc); });
    ink.ro.observe(cv.parentElement);
  }
  inkSizeSur(ink.sur.calc);
  inkColorSet(inkColor);
}
function inkSizeSur(sur) {
  const dpr = window.devicePixelRatio || 1;
  let w, h;
  const wrap = sur.cv.parentElement;
  if (sur.cv.classList.contains('qink')) {
    // 整卡書寫層：畫布蓋滿整張卡（題目也能寫），尺寸跟著卡片走
    w = wrap.clientWidth; h = wrap.clientHeight;
  } else {
    w = wrap.clientWidth; h = sur.h; // 手機專區的獨立筆記卡
  }
  sur.cv.width = Math.max(1, Math.round(w * dpr));
  sur.cv.height = Math.max(1, Math.round(h * dpr));
  sur.cv.style.width = w + 'px'; sur.cv.style.height = h + 'px';
  sur.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sur.ctx.lineCap = 'round'; sur.ctx.lineJoin = 'round';
  inkRedraw(sur);
}
function inkExtend(dh) {
  if (!ink || !ink.sur.calc) return;
  const cv = ink.sur.calc.cv;
  if (cv.classList.contains('qink')) { // 整卡書寫層：加長＝把空白書寫區加高，卡片變高→ResizeObserver 自動重算畫布
    const pad = cv.parentElement.querySelector('.write-pad');
    if (pad) { const cur = parseInt(pad.style.minHeight, 10) || pad.clientHeight || 300; pad.style.minHeight = Math.min(4000, cur + dh) + 'px'; }
    return;
  }
  if (ink.sur.calc.h >= 4000) return;
  ink.sur.calc.h = Math.min(4000, ink.sur.calc.h + dh);
  inkSizeSur(ink.sur.calc);
}
function inkColorSet(c) {
  inkColor = c;
  for (const k of ['k', 'r', 'g']) {
    const b = $('#ink-c-' + k);
    if (b) b.className = 'btn sm inkc' + (k === c ? ' active' : '');
  }
}
function inkPos(e, sur) {
  const r = sur.cv.getBoundingClientRect();
  return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
}
function sPenErasePressed(e) {
  if (!e || e.pointerType !== 'pen') return false;
  const buttons = Number(e.buttons);
  if (Number.isFinite(buttons) && (buttons & SPEN_ERASE_BUTTONS)) return true;
  const button = Number(e.button);
  return e.type === 'pointerdown' && (button === 1 || button === 2 || button === 5 || button === 6);
}
function sPenSamsungHoverButton(e) {
  if (!e || e.pointerType !== 'pen' || Number(e.pressure) !== 0) return false;
  return Number(e.button) === 1 || !!(Number(e.buttons) & 4);
}
function inkPenHasContact(e) {
  if (!e || e.pointerType !== 'pen') return true;
  const pressure = Number(e.pressure);
  return Number.isFinite(pressure) ? pressure > 0 : !!(Number(e.buttons) & 1);
}
function inkModeRender(sur, temporaryErase) {
  if (!sur) return;
  sur.cv.dataset.mode = temporaryErase ? 'erase' : 'pen';
  const status = $('#ink-s-pen-status');
  if (status) {
    status.hidden = !temporaryErase;
    status.textContent = temporaryErase ? '側鍵按住：橡皮擦' : '';
  }
}
function inkSamsungHoldSet(sur, held) {
  if (!sur) return false;
  sur.sPenButtonHeld = !!held;
  if (sur.pointer == null) inkModeRender(sur, held);
  return true;
}
function inkSamsungHover(e, sur) {
  if (!sur || !e || e.pointerType !== 'pen') return false;
  if (sPenSamsungHoverButton(e)) return inkSamsungHoldSet(sur, true);
  if (Number(e.pressure) === 0) return inkSamsungHoldSet(sur, false);
  return false;
}
function inkGestureMode(e, sur) {
  return sPenErasePressed(e) || !!(sur && sur.sPenButtonHeld) ? 'erase' : 'pen';
}
function inkFinishCurrent(sur) {
  if (!sur || !sur.cur) return false;
  const cur = sur.cur; sur.cur = null;
  if (cur.pts.length <= 1) return false;
  cur.t1 = Date.now(); delete cur.tid; inkArr(sur).push(cur); inkCheckpoint(false); return true;
}
function inkPointSegmentDistance(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = px - a[0], wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}
function inkEraseAt(e, sur) {
  if (!ink || !sur) return false;
  const [x, y] = inkPos(e, sur), now = Date.now(), radius = 18;
  const st = inkStore(ink.qid); let changed = false;
  for (const stroke of st.s) {
    if (!stroke || stroke.dead || stroke.arch || !Array.isArray(stroke.pts) || !stroke.pts.length) continue;
    let hit = Math.hypot(x - stroke.pts[0][0], y - stroke.pts[0][1]) <= radius;
    for (let i = 1; !hit && i < stroke.pts.length; i++) hit = inkPointSegmentDistance(x, y, stroke.pts[i - 1], stroke.pts[i]) <= radius;
    if (hit) { stroke.dead = now; changed = true; }
  }
  if (!changed) return false;
  st.e.push(now); inkCheckpoint(false); inkRedraw(sur); return true;
}
function inkContextMenu(e, sur) {
  e.preventDefault();
  if (!sur) return false;
  inkFinishCurrent(sur);
  sur.pointer = null; sur.gestureMode = null; sur.sPenButtonHeld = false;
  inkModeRender(sur, false);
  return false;
}
function inkDown(e, sur) {
  if (!ink || replaying) return;
  if (e.pointerType === 'pen' && sPenSamsungHoverButton(e)) { e.preventDefault(); inkSamsungHover(e, sur); return; }
  e.preventDefault();
  try { sur.cv.setPointerCapture(e.pointerId); } catch (_) {}
  if (e.pointerType === 'touch') {
    if (sur.allowTouch) { // 手機筆記卡：第一指＝畫線
      if (sur.touches.size === 0 && !sur.cur) {
        sur.touches.set(e.pointerId, { y: e.clientY, x0: e.clientX, y0: e.clientY, t: Date.now() });
        const [x, y] = inkPos(e, sur);
        sur.cur = { t0: Date.now(), c: inkColor, pts: [[x, y]], tid: e.pointerId };
        return;
      }
      if (sur.cur && sur.cur.tid != null) { sur.cur = null; inkRedraw(sur); } // 第二指加入＝改捲動，作廢進行中的指畫
      sur.scroll = true; // 進入捲動手勢：一路捲到所有指離開（放開第二指剩一指仍能捲，不會變死指）
      sur.touches.set(e.pointerId, { t: Date.now() });
      return;
    }
    // 手指/手掌：永不畫線。筆活躍（正在寫、或 0.8 秒內寫過）時手掌觸點完全忽略——不殺筆、不捲動。
    if (sur.cur || Date.now() - ink.penAt < 800) return;
    sur.touches.set(e.pointerId, { t: Date.now() });
    return;
  }
  ink.penAt = Date.now();
  sur.touches.clear(); // 筆落下即作廢該面已登記的手掌觸點
  sur.pointer = e.pointerId;
  sur.gestureMode = inkGestureMode(e, sur);
  inkModeRender(sur, sur.gestureMode === 'erase');
  if (sur.gestureMode === 'erase') {
    if (inkPenHasContact(e)) inkEraseAt(e, sur);
    return;
  }
  const [x, y] = inkPos(e, sur);
  sur.cur = { t0: Date.now(), c: inkColor, pts: [[x, y]] };
}
function inkMove(e, sur) {
  if (!ink) return;
  if (e.pointerType === 'touch') {
    if (sur.allowTouch && sur.cur && sur.cur.tid === e.pointerId) { // 指畫進行中：照筆的畫法走
      e.preventDefault();
      const [x, y] = inkPos(e, sur);
      const pts = sur.cur.pts; const p = pts[pts.length - 1];
      if (Math.abs(x - p[0]) + Math.abs(y - p[1]) < 2) return;
      pts.push([x, y]);
      const c = sur.ctx;
      c.strokeStyle = INK_COLORS[sur.cur.c] || INK_COLORS.k; c.lineWidth = INK_W;
      c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(x, y); c.stroke();
      return;
    }
    if (!sur.touches.has(e.pointerId)) return;
    e.preventDefault();
    if (Date.now() - ink.penAt < 800) return; // 筆剛寫過：手掌移動不捲動
    const tp = sur.touches.get(e.pointerId);
    if (sur.scroll || sur.touches.size >= 2) { // 捲動手勢（含放開一指剩一指的續捲）
      sur.scroll = true;
      if (tp.sy == null) { tp.sy = e.clientY; return; } // 每指首幀只建基準、不捲——消除第二指加入時的暴衝
      const dy = (e.clientY - tp.sy) / Math.max(1, sur.touches.size); // 多指同時 move 會各觸發一次，除以指數避免加倍
      tp.sy = e.clientY;
      const box = sur.key === 'calc' ? sur.cv.closest('.ink-scroll') : null;
      if (box) {
        const before = box.scrollTop;
        box.scrollTop -= dy;
        const rest = dy - (before - box.scrollTop);
        if (rest) window.scrollBy(0, -rest); // 內框捲不動（或到底）時改捲頁面
      } else window.scrollBy(0, -dy);
    }
    return;
  }
  if (e.pointerType === 'pen' && sur.pointer == null) { inkSamsungHover(e, sur); return; }
  if (sur.pointer != null && sur.pointer !== e.pointerId) return;
  e.preventDefault();
  ink.penAt = Date.now();
  const nextMode = inkGestureMode(e, sur);
  if (nextMode !== sur.gestureMode) {
    inkFinishCurrent(sur);
    sur.gestureMode = nextMode;
    inkModeRender(sur, nextMode === 'erase');
    if (nextMode === 'pen' && inkPenHasContact(e)) {
      const [x, y] = inkPos(e, sur);
      sur.cur = { t0: Date.now(), c: inkColor, pts: [[x, y]] };
    }
  }
  if (sur.gestureMode === 'erase') {
    if (inkPenHasContact(e)) inkEraseAt(e, sur);
    return;
  }
  if (!sur.cur) return;
  const [x, y] = inkPos(e, sur);
  const pts = sur.cur.pts; const p = pts[pts.length - 1];
  if (Math.abs(x - p[0]) + Math.abs(y - p[1]) < 2) return;
  pts.push([x, y]);
  const c = sur.ctx;
  c.strokeStyle = INK_COLORS[sur.cur.c] || INK_COLORS.k; c.lineWidth = INK_W;
  c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(x, y); c.stroke();
  if (sur.key === 'calc' && y > sur.cv.clientHeight - 48) inkExtend(320); // 寫到接近底部自動加長（整卡層用實際畫布高度）
}
function inkUp(e, sur) {
  if (!ink) return;
  if (e.pointerType === 'touch') {
    if (sur.allowTouch && sur.cur && sur.cur.tid === e.pointerId) { // 指畫收筆
      const cur = sur.cur; sur.cur = null;
      sur.touches.delete(e.pointerId);
      if (cur.pts.length > 1) { cur.t1 = Date.now(); delete cur.tid; inkArr(sur).push(cur); inkCheckpoint(false); }
      return;
    }
    sur.touches.delete(e.pointerId);
    if (sur.touches.size === 0) sur.scroll = false; // 所有指離開才結束捲動手勢
    return; // 按鈕/選項都以 z-index 浮在畫布上層，觸點會直接落在它們身上，不需要穿透
  }
  if (sur.pointer != null && sur.pointer !== e.pointerId) return;
  inkFinishCurrent(sur); // 單點＝誤觸，不留筆畫
  sur.pointer = null; sur.gestureMode = null;
  inkModeRender(sur, !!sur.sPenButtonHeld);
}
function inkUndo() {
  if (!ink) return;
  const st = inkStore(ink.qid);
  let best = null;
  for (const s of st.s) if (!s.dead && !s.arch && (!best || s.t0 > best.t0)) best = s;
  if (!best) return;
  best.dead = Date.now();
  st.e.push(Date.now());
  inkCheckpoint(false);
  inkRedrawAll();
}
function inkDrawStroke(ctx, s, w, col) {
  ctx.strokeStyle = col || INK_COLORS[s.c] || INK_COLORS.k;
  ctx.lineWidth = w || INK_W;
  ctx.beginPath();
  ctx.moveTo(s.pts[0][0], s.pts[0][1]);
  for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0], s.pts[i][1]);
  ctx.stroke();
}
function inkWipe(cv, ctx) {
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
}
function inkRedraw(sur) {
  if (!ink || !sur) return;
  inkWipe(sur.cv, sur.ctx);
  for (const s of inkArr(sur)) if (!s.dead && !s.arch) inkDrawStroke(sur.ctx, s);
  // 進行中的筆畫也要補畫（自動加長重設 canvas 會清空 bitmap）
  if (sur.cur && sur.cur.pts && sur.cur.pts.length > 1) inkDrawStroke(sur.ctx, sur.cur);
  const st = sessionInk[ink.qid];
  if (st && st.m) for (const m of st.m) if (!m.arch) inkDrawMark(sur.ctx, m, sur.cv.clientWidth, sur.cv.clientHeight);
}
/* ═══ 批改標記：對→紅勾畫在答案旁（最後一筆處）、錯→紅叉＋正解寫在下面（像老師改考卷） ═══ */
function inkMark(qid, ok, ansText) {
  const st = sessionInk[qid]; if (!st) return;
  const arr = st.s.filter((s) => !s.dead && !s.arch);
  if (!arr.length) return;
  const last = arr.reduce((a, b) => ((b.t1 || b.t0) > (a.t1 || a.t0) ? b : a));
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of last.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
  }
  const cv = $('#ink-cv');
  if (!cv) return;
  const m = { t: Date.now(), ok: !!ok, txt: ok ? null : `正解：${ansText}`, x0, y0, x1, y1 };
  (st.m = st.m || []).push(m);
  inkDrawMark(cv.getContext('2d'), m, cv.clientWidth, cv.clientHeight);
}
/* AI 批改的框（v.marks，0~1 相對批改圖）→ 映射回畫布座標，直接畫在你原字上（不清空、對得到位置） */
function inkAiMarks(qid, marks, box) {
  const st = sessionInk[qid];
  if (!st || !box || !Array.isArray(marks)) return 0;
  st.m = (st.m || []).filter((m) => m.type !== 'box'); // 重批時先清舊 AI 框，避免疊加
  let n = 0;
  for (const mk of marks.slice(0, 3)) {
    const b = mk && mk.box;
    if (!Array.isArray(b) || b.length !== 4) continue;
    let [ux0, uy0, ux1, uy1] = b.map(Number);
    if (![ux0, uy0, ux1, uy1].every((v) => v >= 0 && v <= 1) || !(ux1 > ux0) || !(uy1 > uy0)) continue;
    const g = 0.02; ux0 = Math.max(0, ux0 - g); uy0 = Math.max(0, uy0 - g); ux1 = Math.min(1, ux1 + g); uy1 = Math.min(1, uy1 + g);
    st.m.push({ t: Date.now(), type: 'box', label: mk.label ? String(mk.label).slice(0, 12) : '',
      x0: box.x0 - box.pad + ux0 * box.w, y0: box.y0 - box.pad + uy0 * box.h,
      x1: box.x0 - box.pad + ux1 * box.w, y1: box.y0 - box.pad + uy1 * box.h });
    n++;
  }
  return n;
}
/* 批改後：把 AI 框畫在原字上、恢復畫布可書寫（新增的字不再批改）。書寫層保留＝對得到位置、能邊看邊寫。 */
function resumeWithMarks(qid, marks, box) {
  if (marks && box) inkAiMarks(qid, marks, box);
  const cv = $('#ink-cv');
  if (!cv || !sessionInk[qid]) return;
  if (!ink || ink.qid !== qid) inkStart(qid, Date.now(), 0); // 恢復書寫：since=0→既有筆跡與批改標記全部保留、不歸檔
  else inkRedrawAll();
  // qSubmit 會鎖住整張題卡的按鈕；批改完成後只該繼續鎖作答鈕，畫筆工具必須恢復可用。
  document.querySelectorAll('.sheet-tools .ink-tools button').forEach((b) => { b.disabled = false; });
}
function resumeAfterGrade(qid, marks, box) {
  // 批改會先鎖住整張題卡；不論這題有沒有真的落筆，都要重新啟動畫布與工具，
  // 才能在看詳解時補算、圈重點。只把「作答選項」留在鎖定狀態。
  setTimeout(() => {
    if (qsess && qsess.q && qsess.q.id === qid) resumeWithMarks(qid, marks || null, box || null);
  }, 50);
}
function inkDrawMark(ctx, m, cw, ch) {
  ctx.save();
  ctx.strokeStyle = INK_COLORS.r; ctx.fillStyle = INK_COLORS.r;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (m.type === 'box') { // AI 圈錯：紅橢圓框在原字上 ＋ 標籤
    ctx.lineWidth = 2.6;
    const cx = (m.x0 + m.x1) / 2, cyb = (m.y0 + m.y1) / 2, rx = Math.max(9, (m.x1 - m.x0) / 2), ry = Math.max(9, (m.y1 - m.y0) / 2);
    ctx.beginPath(); ctx.ellipse(cx, cyb, rx, ry, 0, 0, 2 * Math.PI); ctx.stroke();
    if (m.label) {
      let fs = 13; ctx.font = `600 ${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(m.label).width;
      let tx = m.x0, ty = m.y0 - 6;
      if (ty < fs + 2) ty = m.y1 + fs + 4;
      if (tx + tw + 6 > cw) tx = Math.max(4, cw - tw - 6);
      ctx.fillStyle = 'rgba(225,29,72,0.92)'; ctx.fillRect(tx - 3, ty - fs, tw + 6, fs + 5);
      ctx.fillStyle = '#fff'; ctx.fillText(m.label, tx, ty);
    }
    ctx.restore(); return;
  }
  const cy = (m.y0 + m.y1) / 2;
  const size = m.ok ? 26 : 18;
  let bx = m.x1 + 12;
  if (bx + size > cw) bx = Math.max(4, m.x0 - size - 12);
  if (m.ok) {
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(bx, cy + size * 0.05);
    ctx.lineTo(bx + size * 0.32, cy + size * 0.4);
    ctx.lineTo(bx + size, cy - size * 0.45);
    ctx.stroke();
  } else {
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, cy - size / 2); ctx.lineTo(bx + size, cy + size / 2);
    ctx.moveTo(bx + size, cy - size / 2); ctx.lineTo(bx, cy + size / 2);
    ctx.stroke();
    let fs = 20;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    let tw = ctx.measureText(m.txt).width;
    while (tw > cw - 12 && fs > 13) { fs -= 2; ctx.font = `600 ${fs}px system-ui, sans-serif`; tw = ctx.measureText(m.txt).width; }
    let tx = m.x0, ty = m.y1 + fs + 12;
    if (tx + tw > cw - 6) tx = Math.max(6, cw - 6 - tw);
    if (ty > ch - 6) ty = Math.max(fs + 6, m.y0 - 12);
    ctx.fillText(m.txt, tx, ty);
  }
  ctx.restore();
}
function inkRedrawAll() {
  if (!ink) return;
  for (const k of Object.keys(ink.sur)) inkRedraw(ink.sur[k]);
}
/* 旋轉/改變視窗大小：重算所有書寫面尺寸並重繪（否則 qink 覆蓋層會以舊尺寸蓋住按鈕） */
let inkRszTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(inkRszTimer);
  inkRszTimer = setTimeout(() => {
    if (!ink || replaying) return;
    for (const k of Object.keys(ink.sur)) inkSizeSur(ink.sur[k]);
  }, 150);
});
function inkStop() {
  if (!ink) return null;
  clearTimeout(inkCheckpointTimer); // 完稿會由 syncInk 寫同一 client_id；取消尚未執行的草稿，避免晚到草稿蓋回完稿
  const { qid, t0 } = ink;
  if (ink.ro) ink.ro.disconnect();
  for (const k of Object.keys(ink.sur)) {
    const cv = ink.sur[k].cv;
    cv.onpointerdown = cv.onpointermove = cv.onpointerup = cv.onpointercancel = cv.onlostpointercapture = cv.oncontextmenu = null;
    cv.style.pointerEvents = 'none'; // 停止書寫後畫布不再攔截點擊（批改按鈕在畫布下層）
  }
  ink = null;
  const st = inkStore(qid);
  const now = Date.now();
  const ss = st.s.filter((s) => s.t0 >= t0 && !s.sub).sort((a, b) => a.t0 - b.t0);
  const era = st.e.filter((t) => t >= t0).length;
  if (!ss.length && !era) return null;
  const sec = (x) => Math.round(x / 1000);
  const hes = [];
  for (let i = 1; i < ss.length; i++) {
    const gap = ss[i].t0 - ss[i - 1].t1;
    if (gap >= HES_GAP) hes.push([sec(ss[i - 1].t1 - t0), sec(gap)]);
  }
  return {
    fi: ss.length ? sec(ss[0].t0 - t0) : null,
    hes: hes.slice(0, 12),
    era,
    tail: ss.length ? sec(now - ss[ss.length - 1].t1) : null,
    n: ss.length,
  };
}
/* 整卡手寫輸出成裁切白底 PNG base64（AI 批改與批改面板縮圖用） */
function inkCaptureFull(qid, asDataURL) {
  const st = sessionInk[qid];
  if (!st) return null;
  const arr = st.s.filter((s) => !s.dead && !s.arch);
  if (!arr.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of arr) for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
  }
  const pad = 14, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  const scale = Math.min(2, Math.max(0.4, 1100 / w));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of arr) inkDrawStroke(ctx, s, 2.2);
  inkCaptureFull.lastW = Math.round(w); // 手寫實際 CSS 寬（給批改結果照原大小顯示，不要硬撐成一格放大）
  inkCaptureFull.lastBox = { x0, y0, pad, w, h }; // 筆跡外框（畫布 CSS 座標）：把 AI 的 0~1 框映射回原字位置，直接畫在畫布上
  const url = cv.toDataURL('image/png');
  return asDataURL ? url : url.split(',')[1];
}
/* 🧠 卡點證據圖：對每個「≥20 秒的停頓」輸出一張快照——停頓當下已寫的內容用原色、
   停頓結束後接著寫的頭幾筆用藍色。給 AI 判讀「他當時盯著什麼在卡、想通之後寫了什麼」。 */
const STUCK_GAP = 20000;
const STUCK_COL = '#2563eb';
function inkStuckPauses(qid, t0) {
  const st = sessionInk[qid];
  if (!st) return [];
  const all = (st.s || []).filter((s) => !s.dead && !s.arch && s.t0 >= t0 && s.pts && s.pts.length > 1).sort((a, b) => a.t0 - b.t0);
  if (all.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    const gap = all[i].t0 - all[i - 1].t1;
    if (gap >= STUCK_GAP) gaps.push({ i, at: all[i - 1].t1, gap });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  return { all, picks: gaps.slice(0, 3).sort((a, b) => a.at - b.at) };
}
function inkStuckShots(qid, t0) {
  const r = inkStuckPauses(qid, t0);
  if (!r.picks || !r.picks.length) return [];
  const { all, picks } = r;
  const shots = [];
  for (const p of picks) {
    const before = all.slice(0, p.i);
    const after = all.slice(p.i, p.i + 3);
    const drawn = before.concat(after);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of drawn) for (const pt of s.pts) {
      if (pt[0] < x0) x0 = pt[0]; if (pt[1] < y0) y0 = pt[1];
      if (pt[0] > x1) x1 = pt[0]; if (pt[1] > y1) y1 = pt[1];
    }
    const pad = 14, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
    const scale = Math.min(2, Math.max(0.4, 1100 / w));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of before) inkDrawStroke(ctx, s, 2.2);
    for (const s of after) inkDrawStroke(ctx, s, 2.6, STUCK_COL);
    shots.push({ sec: Math.round((p.at - t0) / 1000), dur: Math.round(p.gap / 1000), b64: cv.toDataURL('image/png').split(',')[1] });
  }
  return shots;
}
/* 🔢 書寫順序圖：把整卷手寫按「下筆先後」分組（時間停頓 或 換地方寫的空間跳躍都算新一步），
   每組起點標序號、最後一組（＝最後寫的）框成「答案」。給 AI 用來按時間順序讀懂解題流程、
   並以「最後寫的那組」為最終答案——不再靠『位置最下面』猜（考生沒空位寫到右上時就會抓錯）。
   幾何(bbox/pad/scale)刻意與 inkCaptureFull 完全一致，AI 回的 marks 座標才對得準顯示圖。 */
function inkOrderedShot(qid) {
  const st = sessionInk[qid];
  if (!st) return null;
  const arr = st.s.filter((s) => !s.dead && !s.arch && s.pts && s.pts.length);
  if (!arr.length) return null;
  arr.sort((a, b) => (a.t0 || 0) - (b.t0 || 0)); // 下筆先後
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of arr) for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
  }
  const pad = 14, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  const scale = Math.min(2, Math.max(0.4, 1100 / w));
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of arr) inkDrawStroke(ctx, s, 2.2); // 原色，數學可讀
  // 切點：時間停頓 ≥350ms 或 空間跳躍 ≥對角線 28%（＝移到別處寫）；取最強 ≤9 個 → ≤10 組
  const cands = [];
  for (let i = 1; i < arr.length; i++) {
    const gap = Math.max(0, (arr[i].t0 || 0) - (arr[i - 1].t1 || 0));
    const pe = arr[i - 1].pts[arr[i - 1].pts.length - 1], ps = arr[i].pts[0];
    const jump = Math.hypot(ps[0] - pe[0], ps[1] - pe[1]);
    if (gap >= 350 || jump >= diag * 0.28) cands.push({ i, score: gap + jump * 4 });
  }
  cands.sort((a, b) => b.score - a.score);
  const cuts = new Set(cands.slice(0, 9).map((c) => c.i));
  const chunks = []; let cur = [];
  arr.forEach((s, i) => { if (cuts.has(i) && cur.length) { chunks.push(cur); cur = []; } cur.push(s); });
  if (cur.length) chunks.push(cur);
  // 序號徽章 + 答案框：畫在裝置像素座標，尺寸固定不隨 scale 變、放在起點外側不擋字
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dev = (x, y) => [scale * (x + pad - x0), scale * (y + pad - y0)];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 14px system-ui, sans-serif';
  chunks.forEach((ch, idx) => {
    const last = idx === chunks.length - 1;
    const b = dev(ch[0].pts[0][0], ch[0].pts[0][1]);
    ctx.fillStyle = last ? 'rgba(220,38,38,0.92)' : 'rgba(234,88,12,0.85)';
    ctx.beginPath(); ctx.arc(b[0] - 13, b[1] - 13, 11, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(String(idx + 1), b[0] - 13, b[1] - 12);
    if (last) {
      let a0 = 1e9, b0 = 1e9, a1 = -1e9, b1 = -1e9;
      for (const s of ch) for (const p of s.pts) {
        if (p[0] < a0) a0 = p[0]; if (p[1] < b0) b0 = p[1];
        if (p[0] > a1) a1 = p[0]; if (p[1] > b1) b1 = p[1];
      }
      const lo = dev(a0, b0), hi = dev(a1, b1);
      ctx.strokeStyle = 'rgba(220,38,38,0.85)'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(lo[0] - 9, lo[1] - 9, (hi[0] - lo[0]) + 18, (hi[1] - lo[1]) + 18); ctx.setLineDash([]);
    }
  });
  return { b64: cv.toDataURL('image/png').split(',')[1], steps: chunks.length };
}
/* AI 回傳的 stuck 陣列 → 正規化（以我方量測的秒數為準、截長防狀態膨脹） */
function normStuck(v, shots) {
  const arr = Array.isArray(v && v.stuck) ? v.stuck : [];
  return arr.slice(0, 3).map((s, i) => {
    const o = s && typeof s === 'object' ? s : {}; // AI 湊數塞 null 也不能炸掉整筆批改
    return {
      at: shots && shots[i] ? shots[i].sec : (typeof o.at === 'number' ? o.at : null),
      dur: shots && shots[i] ? shots[i].dur : null,
      ph: String(o.phase || '').slice(0, 8),
      what: String(o.what || o.insight || '').slice(0, 80),
      fix: String(o.unstick || o.fix || '').slice(0, 60),
    };
  }).filter((s) => s.what);
}
/* 沒有 AI 時的本地啟發式：按停頓在解題時程中的位置給一個「人話標籤」＋固定建議 */
function stuckLabel(p, ms) {
  if (!p || !p.hes || !p.hes.length) return [];
  const total = Math.max(1, Math.round(ms / 1000));
  return p.hes.filter((h) => h[1] >= 20).slice(0, 3).map((h) => {
    const pos = h[0] / total;
    const kind = pos < 0.25 ? '起步卡：第一步沒路' : pos > 0.75 ? '收尾卡：不敢下筆或驗算猶豫' : '中段卡：路線走到一半斷掉';
    const fix = pos < 0.25 ? '先看快解 tip 背「第一步」' : pos > 0.75 ? '寫了再說，錯了劃掉' : '調出老師方法庫補這段路線';
    return { at: h[0], dur: h[1], ph: '', what: kind, fix };
  });
}
function stuckHTML(stuck) {
  if (!stuck || !stuck.length) return '';
  return `<div class="stuck-box"><p class="stuck-title"><b>🧠 你卡住的地方</b></p>
    ${stuck.map((s) => `<div class="stuck-row">
      <span class="stuck-at">第 ${s.at != null ? s.at : '?'} 秒<br>停 ${s.dur != null ? s.dur : '?'} 秒</span>
      <div class="stuck-body">${s.ph ? `<span class="stuck-ph">${rtAi(s.ph)}</span>` : ''}<p>${rtAi(s.what)}</p>
      ${s.fix ? `<p class="stuck-fix">💡 ${rtAi(s.fix)}</p>` : ''}</div></div>`).join('')}</div>`;
}
function mergeProc(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { fi: a.fi != null ? a.fi : b.fi, hes: a.hes.concat(b.hes).slice(0, 12), era: a.era + b.era, tail: b.tail != null ? b.tail : a.tail, n: a.n + b.n };
}
async function inkReplay(qid, t0, jumpMs) {
  const cv = $('#ink-cv'); if (!cv || replaying) return;
  const card = cv.closest('.qcard.booklet.sheet'); // 批改後整卡書寫層被 :has 收起：回放前用 .replaying 掀開，結束再收回
  if (card) { card.classList.add('replaying'); try { card.scrollIntoView({ block: 'center' }); } catch (e) {} }
  replaying = true;
  const ctx = cv.getContext('2d');
  const st = inkStore(qid);
  const all = st.s.filter((s) => s.t0 >= t0);
  const evs = all.filter((s) => !s.sub).sort((a, b) => a.t0 - b.t0);
  const deaths = all.filter((s) => s.dead).map((s) => s.dead);
  const f = $('#ink-flash') || $('#q-flash'); // 統一計算紙卡沒有 #ink-flash，退回 #q-flash
  const flash = (msg) => { if (f) { f.textContent = msg; f.style.display = 'block'; } };
  const unflash = () => { if (f) f.style.display = 'none'; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gone = () => !cv.isConnected; // 換頁/換題後舊 canvas 脫離 DOM → 中止回放
  const aliveAt = (t) => all.filter((s) => s.t0 <= t && (!s.dead || s.dead > t));
  try {
    // #14：批改後旋轉螢幕，畫布尺寸凍結在旋轉前（resize handler 因 ink=null 略過）→回放筆跡錯位/裁切。
    // 回放前依「當前」卡片尺寸重算畫布＋dpr transform（等同 inkSizeSur），對現有尺寸則是無害重設。
    const wrap = cv.parentElement;
    if (wrap) {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = cv.classList.contains('qink') ? wrap.clientHeight : (parseInt(cv.style.height, 10) || cv.clientHeight || wrap.clientHeight);
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    }
    inkWipe(cv, ctx);
    let prevEnd = null;
    if (jumpMs) { // 跳到卡點前：先一次性畫出該時刻的畫布，再從那裡開始慢放
      for (const a of aliveAt(jumpMs)) inkDrawStroke(ctx, a);
      prevEnd = jumpMs;
    }
    for (const s of evs) {
      if (jumpMs && s.t1 <= jumpMs) continue;
      if (prevEnd !== null) {
        if (deaths.some((d) => d > prevEnd && d <= s.t0)) {
          inkWipe(cv, ctx);
          for (const a of aliveAt(s.t0)) inkDrawStroke(ctx, a);
          flash('🧽 這裡塗改了'); await sleep(600); unflash();
          if (gone()) return;
        }
        const gap = s.t0 - prevEnd;
        if (gap >= HES_GAP) { flash(`⏸ 這裡停頓了 ${Math.round(gap / 1000)} 秒`); await sleep(1000); unflash(); }
        else await sleep(Math.min(250, gap / 8));
        if (gone()) return;
      }
      ctx.strokeStyle = INK_COLORS[s.c] || INK_COLORS.k; ctx.lineWidth = INK_W;
      for (let i = 1; i < s.pts.length; i++) {
        ctx.beginPath(); ctx.moveTo(s.pts[i - 1][0], s.pts[i - 1][1]); ctx.lineTo(s.pts[i][0], s.pts[i][1]); ctx.stroke();
        if (i % 6 === 0) { await sleep(8); if (gone()) return; }
      }
      prevEnd = s.t1;
    }
    inkWipe(cv, ctx);
    for (const a of aliveAt(Date.now())) inkDrawStroke(ctx, a);
    await sleep(1200); // 完整畫面停留一下再收——筆畫少的回放幾秒就播完，瞬間收合會像沒發生過
  } finally { // 任何中止點都要收乾淨：解鎖、把整卡書寫層收回、關字幕
    replaying = false;
    if (card && card.isConnected) card.classList.remove('replaying');
    unflash();
  }
}
function exportInk() {
  const qids = Object.keys(sessionInk);
  if (!qids.length) { alert('這次開啟期間還沒有任何筆跡。'); return; }
  const blob = new Blob([JSON.stringify({ d: today(), ink: sessionInk })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mathA13-筆跡-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
/* ═══════════ 共用 UI 基礎：modal、精簡模式、單次時間提醒、稱讚 ═══════════ */
function modal(html, btns) {
  modalClose();
  const div = document.createElement('div');
  div.id = 'modalov';
  div.innerHTML = `<div class="modal-card">${html}<div class="modal-btns"></div></div>`;
  document.body.appendChild(div);
  const bx = div.querySelector('.modal-btns');
  for (const [label, fn, cls] of btns) {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.onclick = () => { modalClose(); if (fn) fn(); };
    bx.appendChild(b);
  }
}
function modalClose() { const m = $('#modalov'); if (m) m.remove(); }
/* 做題中隱藏上方導覽列與同步燈，把平板螢幕留給題目與計算區 */
function sessionChrome(on) { document.body.classList.toggle('session-on', !!on); }
/* 單次時間提醒：只在「這題理想中該答完的時間點」跳一次，其他警示全部移除 */
function flashOnce(msg) {
  const f = $('#q-flash') || $('#ink-flash');
  if (f) {
    f.textContent = msg;
    f.style.display = 'block';
    setTimeout(() => { if (f) f.style.display = 'none'; }, 6000);
  }
  if (navigator.vibrate) navigator.vibrate(200);
}
/* 稱讚引擎：只講真的——難題拿下、曾錯今對、比過去快。在 recordAttempt 之前呼叫。
   historyOnly：AI 批改在場時只出「史實類」（曾錯今對/破個人最速）——這些縱向證據 AI 看不到，不能被 AI 稱讚蓋掉。 */
function praiseFor(q, ok, ms, target, historyOnly) {
  if (!ok) return '';
  const past = attemptsOf(q.id);
  const msgs = [];
  if (past.some((a) => !a.ok)) msgs.push('這題你之前錯過，這次拿下了——這就是真實的進步');
  const okPast = past.filter((a) => a.ok); const bestMs = okPast.length ? Math.min(...okPast.map((a) => a.ms)) : null; // 個人最速只算「答對」的作答，別把答錯/放棄的作答時間當成最速基準
  if (bestMs && ms < bestMs) msgs.push(`比你過去最快的一次還快（${fmtSec(ms)} vs ${fmtSec(bestMs)}）`);
  if (!historyOnly) {
    if (q.diff === 3) msgs.push('★★★ 難題，你把它算出來了');
    if (!msgs.length && ms <= target) msgs.push(`在目標時間內完成（${fmtSec(ms)} ≤ ${fmtSec(target)}）`);
  }
  if (!msgs.length) return '';
  return `<p class="praise">🎉 ${msgs.slice(0, 2).join('；')}！</p>`;
}

/* ═══════════ AI 批改（OpenAI Responses API，經 Supabase Edge Function） ═══════════
   OpenAI secret 只存在伺服器端 OPENAI_API_KEY；瀏覽器不接觸、不保存、不跨裝置同步金鑰。
   前端必須先登入 Supabase，再以使用者 JWT 呼叫 openai-proxy。 */
const LEGACY_AI_LS = 'mathA13_aikey';
const LEGACY_AI_MODEL_LS = 'mathA13_aimodel';
const AI_FUNCTION = 'openai-proxy';
const AI_FUNCTION_URL = 'https://rrihysbxhsbxjteqmtdu.supabase.co/functions/v1/' + AI_FUNCTION;
function aiEnabled() { return !!(supa && syncState.user); }
function aiCredentialCleanup() {
  try {
    localStorage.removeItem(LEGACY_AI_LS);
    localStorage.removeItem(LEGACY_AI_MODEL_LS);
    for (const key of new Set([KEY, LEGACY_KEY])) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const stored = JSON.parse(raw);
      if (stored && typeof stored === 'object' && ('aikey' in stored || 'aikeyTs' in stored)) {
        localStorage.setItem(key, JSON.stringify(stripLegacyAiSecrets(stored)));
      }
    }
  } catch (e) {}
}
function aiCard() {
  if (!supa) return `<div class="card"><h2>AI 批改</h2><p class="dim">這個環境無法連到安全的 OpenAI 代理；本機作答與自評仍可正常使用。</p></div>`;
  if (!syncState.user) return `<div class="card"><h2>AI 批改</h2>
    <p class="dim">OpenAI 已由伺服器端安全代理提供。登入雲端同步後，手寫大綱比對、觀念語意檢查與模考手寫批改才會啟用。</p></div>`;
  return `<div class="card"><h2>AI 批改</h2>
    <p class="dim">使用 OpenAI Responses API；金鑰只保存在 Supabase Edge Function，不會送到瀏覽器、localStorage、備份或 app_state。</p>
    <p id="aitest-msg" class="dim"></p>
    <div class="actr"><button class="btn primary" onclick="aiTest()">測試 OpenAI 連線</button></div></div>`;
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escH(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// 放進 inline onclick 單引號字串裡的 id（extbank 題 id 來源不可控，要跳脫）
function jsA(s) { return String(s).replace(/&/g, '&amp;').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
// AI 可能回非布林（字串 "false"、"no"…）；!!"false" 會變 true。嚴格判定：只有真正的 true / "true" / 1 才算對。
function aiCorrect(v) { const c = v && v.correct; return c === true || c === 1 || String(c).trim().toLowerCase() === 'true'; }
// 難度星星：clamp 到 0..3，避免髒資料 diff（如 4 或 undefined）讓 '☆'.repeat(3-diff) 丟 RangeError 把整個 render 打爆
function stars(d) { d = Math.max(0, Math.min(3, d | 0)); return '★'.repeat(d) + '☆'.repeat(3 - d); }
async function aiGradeCall(q, correctTxt, calcB64, shots, steps) {
  const content = [];
  if (calcB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: calcB64 } });
  const teach = S.teach && S.teach[q.id];
  const hasShots = Array.isArray(shots) && shots.length > 0;
  content.push({
    type: 'text',
    text: `你是嚴謹但溫暖的數學閱卷老師。以下是一位學測考生的完整手寫計算過程（單張圖）。${steps > 0 ? '\n⚠️ 這張圖已標「書寫順序」：橘色①②③…圓圈序號＝他下筆的先後（不是位置！），紅色虛線框住、序號最大的那一組是他「最後寫的」。請先照序號順序看懂他的解題流程，再判分。' : ''}
題目：${stripTags(q.q)}
正確答案：${correctTxt}
${q.sol ? `參考詳解：${stripTags(q.sol)}` : ''}
${teach && teach.sol ? `他補習班老師教這題的方法（指出錯誤或建議路線時優先對照這個教法）：${stripTags(teach.sol)}${teach.tip ? '｜老師口訣：' + stripTags(teach.tip) : ''}` : ''}
任務：
0. ⚠️最重要：一律以「他自己寫的數字與算法」判讀，不要硬把他的算式對到參考詳解的數字或縮放。他用等價但不同的做法（不同係數縮放、先把分母乘開、機率×總數改用頭數…）是對的，別因為跟詳解長得不一樣就說他錯。要說某步「算錯／方向反了」之前，先用他實際寫的數字在心裡重算一次核對；除法方向只看他真正寫的「被除數(上)÷除數(下)」，絕不拿參考解的數字去推定他算反。核不出具體錯就別硬指——寧可 firstError 填 null、marks 空，也不要編一個他其實沒犯的錯。
1. 辨識最終答案：${steps > 0 ? '以**紅框（他最後寫的那一組、序號最大）**為最終答案——那才是他的答案，不管它在畫面哪個角落（他常因為下面沒空位而把答案寫到右上或旁邊）。**絕對不要**用「位置最下面」來猜答案。' : '考生會把答案寫在計算的末尾（可能圈起來或另起一行）；有多個候選時以最末、被圈選者為準。'}
2. 判定對錯：所有等價形式都算對——多根/多解順序不同（如「5,-1」vs「-1,5」）、分數/小數、未化簡但數值相等、有沒有寫 x= 都算對。但**座標/有序數對（如 (3,4)）順序不可交換**，題目明確要求特定形式時依題目。
3. praise（稱讚，一定要給、不管對錯）：具體指出他這次做得好的地方——對的步驟、清楚的排版、正確的起手方向、分類完整…。他是動筆寫完的人，先肯定；答錯時尤其要先講他哪裡做對，別只挑錯。
4. nextTime（下次這樣做）：給一句最簡單、最明確、他現在就能理解並記住的關鍵路徑，讓他下次同型題能答對或更快。要具體可記（例：「先同取 6 次方再比大小」「先畫數線標出區間」），不要長、不要照抄整篇詳解。
5. 答錯時：firstError 指出「從哪一步開始出錯」（引用他寫的式子），一句話講清楚；marks 在圖上框住寫錯那段（box=[左,上,右,下] 四個 0~1 小數、原點左上，label ≤8 字如「6-2 應為 4」，最多 2 個、務必對準）。答對時 firstError 為 null、marks 為 []。
${hasShots ? `6. stuck：後面附了 ${shots.length} 張「停頓快照」——他解題中停筆很久的時刻。對每張快照推斷他當時腦袋卡在哪個決策或概念（他盯著原色內容在想什麼？藍色是他想通後接著寫的）。phase 從「讀題/選方法/想公式/卡計算/驗算收尾」擇一；what 講人話、≤40字、可引用他寫的式子（例：「想不起換底公式」「在猶豫要不要展開括號」）；unstick 給下次秒過這個卡點的一句具體動作（≤30字）。按快照順序回、數量與快照一致。` : ''}
只回傳 JSON（不要其他文字）：{"read":"辨識出的答案","correct":true或false,"firstError":"哪一步開始錯（答對時 null）","errKind":"這次錯在哪種機制、用一個詞（答對填 null；從『正負號、公式套錯、化簡約分、移項、代入計算、審題看錯、範圍邊界、方法選錯、沒寫完』擇一最貼切，方便日後統整趨勢）","praise":"他做得好的地方（必填，答錯也要有）","nextTime":"一句可記住的下次這樣做","marks":[{"box":[0.10,0.42,0.55,0.52],"label":"6-2 應為 4"}],"stuck":${hasShots ? '[{"phase":"想公式","what":"他卡在什麼","unstick":"下次怎麼解卡"}]' : '[]'}}`,
  });
  if (hasShots) for (let i = 0; i < shots.length; i++) {
    content.push({ type: 'text', text: `【停頓快照 ${i + 1}】他寫到第 ${shots[i].sec} 秒時停筆思考了 ${shots[i].dur} 秒。圖中原色＝停頓當下已寫的；藍色＝停頓結束後他接著寫的頭幾筆。` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shots[i].b64 } });
  }
  return aiJSON(content, 'grade');
}
function aiHttpError(status, payload) {
  const detail = payload && (payload.message || (payload.error && payload.error.message));
  if (status === 401) return '登入已過期，請重新登入後再試';
  if (status === 403) return detail || '這個帳號或網址未獲准使用 OpenAI';
  if (status === 404) return 'OpenAI 代理尚未部署';
  if (status === 429) return 'OpenAI 額度不足或請求過於頻繁' + (detail ? '（' + detail + '）' : '');
  return detail || ('OpenAI 代理錯誤（HTTP ' + status + '）');
}
async function openAiInvoke(body, timeoutMs) {
  if (!aiEnabled()) throw new Error('請先登入雲端同步，再使用 AI 功能');
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
  try {
    const auth = await supa.auth.getSession();
    const session = auth && auth.data && auth.data.session;
    if (!session || !session.access_token) throw new Error('登入已過期，請重新登入後再試');
    const res = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(aiHttpError(res.status, payload));
    if (!payload || typeof payload !== 'object') throw new Error('OpenAI 代理沒有回傳有效資料');
    return payload;
  } catch (e) {
    throw (e && e.name === 'AbortError') ? new Error('OpenAI 逾時（90 秒沒回應）') : e;
  } finally { clearTimeout(tmr); }
}
/* 共用：以 Responses API Structured Outputs 取得符合 schema 的批改 JSON。 */
async function aiJSON(content, responseType) {
  const payload = await openAiInvoke({ responseType, messages: [{ role: 'user', content }] });
  if (!payload.json || typeof payload.json !== 'object') throw new Error('OpenAI 沒有回傳有效的批改 JSON');
  return payload.json;
}
/* 選擇題/打字題的過程分析：答案對錯已判定，AI 只看手寫過程（非同步，不擋下一題） */
async function aiProcCall(q, ok, correctTxt, calcB64, shots, steps) {
  const teach = S.teach && S.teach[q.id];
  const hasShots = Array.isArray(shots) && shots.length > 0;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: calcB64 } },
    { type: 'text', text: `你是嚴謹但溫暖的數學閱卷老師。圖＝一位學測考生此題的完整手寫計算過程。${steps > 0 ? '圖上橘色①②③…圓圈＝他下筆的先後順序（不是位置），紅框＝他最後寫的；請照序號順序看懂他的解題流程再點評、找卡點。' : ''}
題目：${stripTags(q.q)}
正確答案：${correctTxt}；此題已判定考生「${ok ? '答對' : '答錯'}」。
${q.sol ? `參考詳解：${stripTags(q.sol)}` : ''}
${teach && teach.sol ? `他補習班老師教這題的方法（點評時優先對照這個教法）：${stripTags(teach.sol)}${teach.tip ? '｜老師口訣：' + stripTags(teach.tip) : ''}` : ''}
任務：
0. ⚠️最重要：一律以「他自己寫的數字與算法」判讀，不要硬把他的算式對到參考詳解的數字或縮放。他用等價但不同的做法（不同係數縮放、先把分母乘開、機率×總數改用頭數…）是對的，別因為跟詳解長得不一樣就說他錯。要說某步「算錯／方向反了」之前，先用他實際寫的數字重算一次核對；除法方向只看他真正寫的「被除數(上)÷除數(下)」，絕不拿參考解的數字推定他算反。核不出具體錯就別硬指——寧可 firstError 填 null，也不要編一個他其實沒犯的錯。
1. praise（一定要給、不管對錯）：他是動筆寫完的人，先具體肯定他做得好的地方——對的步驟、清楚排版、正確起手、分類完整…。答錯也要先講他哪裡做對。
2. nextTime（下次這樣做）：一句最簡單明確、他現在就能理解記住的關鍵路徑，讓他下次同型題答對或更快。具體可記、不要長。
3. firstError：${ok ? '答對但過程若有算錯/僥倖對，指出從哪開始；否則 null。' : '對照過程指出「從哪一步開始出錯」（引用他寫的式子），一句話講清楚。'}
4. marks：過程裡有具體寫錯的地方就框出來（box=[左,上,右,下] 0~1 小數、原點左上，label ≤8 字，最多 2 個），沒有就 []。
${hasShots ? `5. stuck：後面附了 ${shots.length} 張「停頓快照」——他停筆很久的時刻。對每張推斷他當時卡在哪個決策或概念（原色＝停頓當下已寫、藍色＝想通後接著寫的）。phase 從「讀題/選方法/想公式/卡計算/驗算收尾」擇一；what ≤40字講人話、可引用他寫的式子；unstick ≤30字給下次解卡動作。按快照順序、數量一致。` : ''}
只回傳 JSON（不要其他文字）：{"firstError":"哪步開始錯（沒有就 null）","errKind":"錯在哪種機制、用一個詞（沒錯填 null；從『正負號、公式套錯、化簡約分、移項、代入計算、審題看錯、範圍邊界、方法選錯、沒寫完』擇一，方便日後統整趨勢）","praise":"他做得好的地方（必填）","nextTime":"一句可記住的下次這樣做","marks":[],"stuck":${hasShots ? '[{"phase":"想公式","what":"他卡在什麼","unstick":"下次怎麼解卡"}]' : '[]'}}` },
  ];
  if (hasShots) for (let i = 0; i < shots.length; i++) {
    content.push({ type: 'text', text: `【停頓快照 ${i + 1}】第 ${shots[i].sec} 秒起停了 ${shots[i].dur} 秒。原色＝停頓當下已寫；藍色＝之後接著寫的頭幾筆。` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shots[i].b64 } });
  }
  return aiJSON(content, 'process');
}
function qProcReview(ok) {
  const sess = qsess;
  const q = sess.q;
  const calcB64 = inkCaptureFull(q.id); // 題卡＋計算區整卷一起分析
  if (!calcB64) { const el = document.getElementById('ai-proc'); if (el) el.innerHTML = ''; return; }
  sess.markBox = inkCaptureFull.lastBox; // 筆跡外框：把 AI 框映射回畫布、畫在原字上
  const correctTxt = q.type === 'fill' ? q.ans[0] : q.ans.map((a) => `(${a + 1})`).join('');
  const shots = inkStuckShots(q.id, sess.t0); // 停頓證據圖：讓 AI 講出「他當時卡在哪」
  // 結果存在 session 上（sess.aiProcHTML），不靠 qsess 物件比對：類題支線把 qsess 換掉後，回原題（sideReturn）能重新貼上，不會卡在「正在看…」
  const paint = (html) => {
    sess.aiProcHTML = html;
    if (qsess === sess) { const el = document.getElementById('ai-proc'); if (el) el.innerHTML = html; }
  };
  const _pord = inkOrderedShot(q.id); // 給 AI 標書寫順序版；顯示/紅圈仍用上面乾淨 calcB64
  aiProcCall(q, ok, correctTxt, (_pord && _pord.b64) || calcB64, shots, _pord ? _pord.steps : 0)
    .then((v) => {
      sess.procV = v; // 存起來供「追問這題」對話引用你剛給的點評
      // 持久化：建議與卡點跟著紀錄走（這回應是非同步的——紀錄可能已寫入，rec.p 與 sess.proc 是同一物件參照）
      const adv = advFrom(v);
      const stuck = normStuck(v, shots);
      if (adv) {
        sess.advPending = adv;
        // AI 後到（qFinish 已跑）→ 直接寫進本場那筆 rec；AI 先到 → 留給 qFinish 消費 advPending。
        // 精準參照，不掃 attempts 猜（掃法會在 30 分鐘內誤中上一場同題紀錄）。
        if (sess.rec && !sess.rec.ai) sess.rec.ai = adv;
        if (!ok && S.wrong[q.id] && !S.wrong[q.id].grad) { S.wrong[q.id].adv = adv; S.wrong[q.id].mt = Date.now(); }
      }
      if (stuck.length && sess.proc) sess.proc.stuck = stuck;
      if (adv || (stuck.length && sess.proc)) save();
      // 手算改畫在「原本的書寫層」上（AI 紅框對得到位置、還能繼續加寫）——不再另貼截圖
      paint(`<div class="ai-fb"><p><b>🤖 AI 看你的手寫過程：</b></p>
        ${v.praise ? `<p class="praise">🎉 你做得好：${rtAi(v.praise)}</p>` : ''}
        ${v.firstError ? `<p class="badc"><b>你這裡跑掉了：</b>${rtAi(v.firstError)}</p>` : ''}
        ${stuckHTML(stuck)}
        ${v.nextTime ? `<div class="next-step"><b>🎯 下次這樣做：</b>${rtAi(v.nextTime)}</div>` : ''}
        ${!v.praise && !v.firstError && !v.nextTime && !stuck.length ? '<p class="dim">過程乾淨，沒什麼好挑的——這題你穩。</p>' : ''}</div>`);
      if (qsess === sess) resumeWithMarks(q.id, v.marks, sess.markBox); // 把 AI 框畫在原字上、恢復書寫層可繼續加寫
    })
    .catch((e) => { paint(`<p class="dim">（AI 過程分析失敗：${escH((e && e.message) || e)}）</p>`); });
}
/* ═══════════ 💬 追問這題（多輪、有 context 記憶的對話） ═══════════
   位置：批改結果「AI 看手寫過程」下方。帶入題目/正解/對錯/詳解/剛才 AI 點評＋手寫圖為脈絡，
   之後每輪只追加問答；每次送完整 messages（第一則 user 夾手寫圖），故 AI 記得整段對話。 */
async function aiChatCall(system, messages) {
  const payload = await openAiInvoke({ responseType: 'text', instructions: system, messages });
  return String(payload.text || '').trim();
}
function chatCtx(sess) {
  const q = sess.q;
  const correctTxt = q.type === 'fill' ? (q.ans && q.ans[0]) : (Array.isArray(q.ans) ? q.ans.map((a) => '(' + (a + 1) + ')').join('') : '');
  const v = sess.ai || sess.procV; // 之前的 AI 批改/過程點評（有就帶進脈絡）
  let prior = '';
  if (v) {
    const bits = [];
    if (v.praise) bits.push('稱讚：' + v.praise);
    if (v.firstError) bits.push('指出的錯：' + v.firstError);
    if (v.nextTime) bits.push('建議：' + v.nextTime);
    if (bits.length) prior = '你剛才給他的點評——' + bits.join('；') + '。';
  }
  const system = '你是這位學測數學考生的一對一家教，正跟他討論「他剛做的這一題」。用繁體中文、口語、簡短好懂地回答他的追問；要寫算式時一律用 \\(…\\) 把數學包起來、每個 \\( 都要有 \\) 收尾（介面用 KaTeX 渲染），不要用 markdown 粗體/標題語法。斷言任何數值或答案前先自己重算驗證（log/根號/正負號/比大小易錯），沒把握寧可說不確定，別給錯答案誤導他。只聚焦這一題與相關概念，別扯遠、別長篇大論。\n\n【這一題】\n題目：' + stripTags(q.q) + '\n正確答案：' + (correctTxt || '（未提供）') + '\n他這次' + (sess.lastOk ? '答對' : '答錯') + '了。\n' + (q.sol ? '參考詳解：' + stripTags(q.sol) + '\n' : '') + prior + (sess.calcImg ? '\n（第一則訊息附了他的手寫過程圖，請對照他實際寫法回答。）' : '');
  const imgB64 = sess.calcImg ? sess.calcImg.replace(/^data:image\/[a-z]+;base64,/, '') : null;
  return { system, imgB64 };
}
function mountChat(sess) {
  const el = document.getElementById('ai-chat');
  if (!el) return;
  if (!aiEnabled()) { el.innerHTML = ''; return; } // 未登入安全代理＝不顯示追問
  const turns = (sess.chat && sess.chat.turns) || [];
  const log = turns.map((t) => t.role === 'user'
    ? '<div class="cm cm-u">' + escH(t.text) + '</div>'
    : '<div class="cm cm-a">' + rtAi(t.text) + '</div>').join('')
    + (sess.chatBusy ? '<div class="cm cm-a dim">🤖 想一下…</div>' : '');
  el.innerHTML = '<div class="ai-chat"><p class="chat-head">💬 <b>追問這題</b> <span class="dim">（可連續問，AI 記得前面的對話）</span></p>'
    + '<div class="chat-log">' + log + '</div>'
    + '<div class="chat-in"><textarea id="chatq" rows="1" placeholder="打字問這題任何問題…例如「第二步為什麼可以這樣約分？」"' + (sess.chatBusy ? ' disabled' : '') + '></textarea>'
    + '<button class="btn primary" onclick="chatSend()"' + (sess.chatBusy ? ' disabled' : '') + '>送出</button></div></div>';
  el.querySelectorAll('.cm-a').forEach((n) => { try { renderMathInElement(n, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }], throwOnError: false }); } catch (e) {} });
  const ta = el.querySelector('#chatq');
  if (ta) {
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); } }); // Enter 送出、Shift+Enter 換行
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
  }
  const logEl = el.querySelector('.chat-log'); if (logEl) logEl.scrollTop = logEl.scrollHeight;
  if (turns.length && ta && !sess.chatBusy) ta.focus();
}
async function chatSend() {
  const sess = qsess;
  if (!sess || sess.chatBusy || !aiEnabled()) return;
  const ta = document.getElementById('chatq');
  const question = ta ? ta.value.trim() : '';
  if (!question) return;
  if (!sess.chat) sess.chat = { turns: [] };
  sess.chat.turns.push({ role: 'user', text: question });
  sess.chatBusy = true;
  mountChat(sess);
  try {
    const { system, imgB64 } = chatCtx(sess);
    const msgs = sess.chat.turns.map((t, i) => (t.role === 'user' && i === 0 && imgB64)
      ? { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } }, { type: 'text', text: t.text }] }
      : { role: t.role, content: t.text });
    const reply = await aiChatCall(system, msgs);
    sess.chat.turns.push({ role: 'assistant', text: reply || '（沒有回應）' });
  } catch (e) {
    sess.chat.turns.push({ role: 'assistant', text: '（追問失敗：' + ((e && e.message) || e) + '）' });
  } finally {
    sess.chatBusy = false;
    if (qsess === sess) mountChat(sess);
  }
}
async function aiTest() {
  const el = $('#aitest-msg');
  if (!aiEnabled()) { if (el) el.textContent = '請先登入雲端同步。'; return; }
  if (el) el.textContent = '測試中…';
  try {
    const payload = await openAiInvoke({ responseType: 'test' }, 30000);
    const model = payload.model ? '（' + payload.model + '）' : '';
    if (el) el.innerHTML = '<span class="okc">連線成功' + escH(model) + '——AI 批改可以使用</span>';
  } catch (e) {
    if (el) el.innerHTML = `<span class="badc">連不到 OpenAI：${escH(e.message || e)}</span>`;
  }
}
function aiFeedbackHTML(v) {
  if (!v) return '';
  return `<div class="ai-fb"><p><b>🤖 AI 批改：</b>讀到你的答案「<b>${v.read != null ? escH(v.read) : '—'}</b>」→ 判定 ${aiCorrect(v) ? '<span class="okc">答對 ✔</span>' : '<span class="badc">答錯 ✘</span>'}</p>
    ${v.firstError ? `<p class="badc"><b>從這裡開始錯：</b>${rtAi(v.firstError)}</p>` : ''}
    ${v.praise ? `<p class="praise">🎉 ${rtAi(v.praise)}</p>` : ''}
    ${v.nextTime ? `<div class="next-step"><b>🎯 下次這樣做：</b>${rtAi(v.nextTime)}</div>` : ''}</div>`;
}

/* ═══════════ 🧑‍🏫 老師方法庫（1662 條，Supabase teacher_methods 表） ═══════════
   概念洞 UI：答錯看詳解時、或錯題本頁，一鍵調出該單元老師的所有方法與口訣。
   雲端載一次後快取到本機（localStorage），之後離線也能看。 */
let METHODLIB = null, MLIB_ERR = null;
const MLIB_LS = 'mathA13_mlib_v1';
async function loadMethodLib() {
  if (METHODLIB) return METHODLIB;
  MLIB_ERR = null;
  try {
    const c = localStorage.getItem(MLIB_LS);
    if (c) {
      const p = JSON.parse(c);
      if (p && typeof p === 'object' && Object.keys(p).length) { METHODLIB = p; return p; }
      localStorage.removeItem(MLIB_LS); // 壞快取（空物件/null）直接清掉，改抓雲端
    }
  } catch (e) {}
  if (!supa || !syncState.user) return null;
  try {
    const rows = [];
    for (let page = 0; page < 5; page++) { // 分頁抓（PostgREST 單次上限 1000）
      const { data, error } = await supa.from('teacher_methods')
        .select('unit,lec,concept,method,mnemonic,black,ex')
        .order('id').range(page * 1000, page * 1000 + 999);
      if (error) { MLIB_ERR = error.message || '查詢失敗'; break; }
      if (!data || !data.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    if (!rows.length) return null;
    const lib = {};
    for (const m of rows) (lib[m.unit] = lib[m.unit] || []).push(m);
    METHODLIB = lib;
    try { localStorage.setItem(MLIB_LS, JSON.stringify(lib)); } catch (e) {}
    return lib;
  } catch (e) { MLIB_ERR = (e && e.message) || '連線失敗'; return null; }
}
function mlibEmptyMsg() {
  if (!supa) return '離線版無法載入方法庫——請用正式站 uqrqmmw.github.io/matha。';
  if (!syncState.user) return '登入雲端同步後，才能載入老師方法庫。';
  if (MLIB_ERR) return `雲端連線暫時失敗（${MLIB_ERR}）——通常是網路不穩，按重試就好。`;
  return '這次查回來是空的——1662 條資料確定在雲端，多半是暫時性網路問題，按重試就好。';
}
/* 根號 → KaTeX 正式根式（√ 上有橫線蓋住被開方數）。殘留的 √ 原字轉成 \(\sqrt{}\) 島。
   已是 \sqrt 的（工作流轉好的內容）不含 √ 字元，不會被重複處理。 */
// 裸分數 → \(\frac{}{}\) 島（保守版；在 rtTxt 的 √ 解析「之前」跑，所以 √2/2 會整包成 \frac{\sqrt{2}}{2}）。
// 分子/分母各為：〔可選 +/-/−〕＋〔一串數字 | 單一拉丁字母 | √數字 | 簡單括號群〕。用島切割保護既有 \(...\) 島與 √(...) 群，不碰既有 \frac、比例 2:3、日期、URL、多斜線、小數、上標/希臘字母運算元。
function fracInner(t) {
  return t.replace(/−/g, '-').replace(/√(\d+)/g, '\\sqrt{$1}').replace(/^\(([A-Za-z0-9+\-]+)\)$/, '$1');
}
const FRAC_RE = (function () {
  const SIGN = '[+\\-−]?';
  const OPD = '(?:\\([A-Za-z0-9]+(?:[+\\-−][A-Za-z0-9]+)*\\)|√\\d+|\\d+|[A-Za-z])';
  return new RegExp('(^|[^A-Za-z0-9√\\\\/.])(' + SIGN + OPD + ')/(' + SIGN + OPD + ')(?![A-Za-z0-9√/]|\\.\\d)', 'g');
})();
function fracTxt(s) {
  const parts = String(s).split(/(\\\([\s\S]*?\\\)|√\([^()]*\))/); // 偶數格＝散文可轉；奇數格＝受保護（既有島／√群）
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\blog_([A-Za-z0-9]+)/g, '\\(\\log_{$1}\\)') // 純文字下標 log_a → \(\log_{a}\)（只動島外，不碰既有 \log_a 島）
      .replace(FRAC_RE, (m, pre, num, den) => pre + '\\(\\frac{' + fracInner(num) + '}{' + fracInner(den) + '}\\)');
  }
  return parts.join('');
}
// 把純文字根號（√數字、係數√數字、√(算式)）轉成 KaTeX \(\sqrt{...}\)。用小 parser 取代舊 regex：
// 舊版遇到「巢狀根號」√(a+√b) 會拆成島中島＋\sqrt 裡塞 \( 而爆掉；parser 版遞迴處理內層、只包一層島。
/* ═══ 匯入內容 XSS 防護（白名單清洗） ═══
   rtTxt 處理的內容字串（q/sol/opts/stem/tip/notes/flash）可能來自匯入的他人題包，直接進 innerHTML＝儲存型 XSS。
   原則：切出 \(…\) 島原封留給 KaTeX（島內 &、< 是數學語法不可動），只對「島外散文」做白名單標籤＋剝屬性。
   實測全庫散文只用 <br>/<b>、零屬性，故此清洗對現有內容零副作用。fig/solFig 原始 SVG 走 sanitizeSVG。 */
const SAN_PROSE_OK = { BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, SUP: 1, SUB: 1 };
const SAN_SVG_OK = { SVG: 1, G: 1, PATH: 1, CIRCLE: 1, ELLIPSE: 1, LINE: 1, POLYLINE: 1, POLYGON: 1, RECT: 1, TEXT: 1, TSPAN: 1, DEFS: 1, MARKER: 1, LINEARGRADIENT: 1, RADIALGRADIENT: 1, STOP: 1, CLIPPATH: 1, PATTERN: 1, TITLE: 1, DESC: 1 };
const SAN_DANGER = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, IMG: 1, SVG: 1, MATH: 1, LINK: 1, META: 1, BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, CANVAS: 1, FOREIGNOBJECT: 1, A: 1 };
function domSanitize(html, ok, unwrap) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  const walk = (parent) => {
    Array.prototype.slice.call(parent.childNodes).forEach((n) => {
      if (n.nodeType !== 1) return; // 文字/其他節點原樣保留
      const tag = n.tagName.toUpperCase();
      if (!ok[tag]) {
        if (unwrap && !SAN_DANGER[tag]) { walk(n); n.replaceWith.apply(n, Array.prototype.slice.call(n.childNodes)); } // 良性未知標籤：拆殼保留文字
        else n.remove(); // 危險標籤，或 SVG 模式的非白名單：整棵丟
        return;
      }
      Array.prototype.slice.call(n.attributes).forEach((a) => {
        const name = a.name.toLowerCase();
        if (unwrap || /^on/.test(name) || name === 'href' || name === 'xlink:href' || name === 'src' || name === 'style' || name === 'formaction') n.removeAttribute(a.name);
      });
      walk(n);
    });
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
function sanitizeProse(s) { return domSanitize(s, SAN_PROSE_OK, true); }
function sanitizeSVG(s) { return domSanitize(s, SAN_SVG_OK, false); }
/* 島內容 HTML-escape（entity-aware：既有 &lt;/&gt;/&amp; 不重複逸出、裸 <>& 逸出）。
   目的：島內容之後會塞進 innerHTML——裸 < 會被瀏覽器當標籤（\(<img onerror=…>\) 會執行＝XSS、\(0<x<1\) 的 <x 被吃掉）。
   逸出後進 innerHTML 安全，瀏覽器把 &lt; 還原成「文字節點的 <」，KaTeX auto-render 讀文字節點照樣拿到 < > &、正常渲染。 */
function escIsland(s) { return String(s).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function sanitizeContent(s) {
  const parts = String(s).split(/(\\\([\s\S]*?\\\))/);
  for (let i = 0; i < parts.length; i++) parts[i] = i % 2 ? escIsland(parts[i]) : sanitizeProse(parts[i]);
  return parts.join('');
}
/* literal Unicode 數學符號救援：匯入的官方試題常把「向量、上下標」寫成純字元
   （v→、AB→ 應是 \overrightarrow；x₁ 應是 x_1；10ⁿ 應是 10^n），字型沒該字就變方框/或顯示成字母後一個箭頭。
   這裡在 render 前一律轉成正規渲染，任何來源的內容都救得到（不用改內容檔）。 */
const U_SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')' };
const U_SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
  // 上標大寫字母（Phonetic Ext）：轉置 (1,1)ᵀ 的 ᵀ=U+1D40 就在這批——CJK 字型幾乎都沒 glyph → 豆腐方框。全補齊，別再漏。
  'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J', 'ᴷ': 'K', 'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N', 'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T', 'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W',
  // 上標小寫字母（含 Spacing Modifier U+02B0 系）：補齊整組
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z' };
const U_SUB_RE = new RegExp('[' + Object.keys(U_SUB).join('') + ']+', 'g');
const U_SUP_RE = new RegExp('[' + Object.keys(U_SUP).join('') + ']+', 'g');
const U_VEC_RE = /([A-Za-z]{1,3})→(?![A-Za-z0-9])/g; // 字母緊貼 →、且 → 後面不是英數＝向量（排除 A→D 路徑、x→0 極限、有空白的 leads-to）
// 島外散文裡「CJK 字型多半沒 glyph → 豆腐方框」的數學符號：整批包進 \(…\) 交給 KaTeX（實測 KaTeX 全渲得出）。
// 刻意「不」收：→(另處理向量/方向)、√(另有裸根號邏輯)、×÷°−、①②③圈碼、✓✗勾叉、○●圈、…刪節號、·點、Ⅰ Ⅱ 羅馬數字、⚡、□△ 幾何/佔位——這些 CJK/emoji 字型幾乎必有，包島反而多餘且傷效能。
const U_WRAP = 'αβγδεζηθικλμνξοπρςστυφχψωϑϕφϖϵ' + 'ΓΔΘΛΞΠΣΦΨΩ'
  + '≤≥≠≈≅≡≦≧≲≳≪≫≺≻∼≒≐⩽⩾±∓'
  + '∈∉∋∌⊂⊃⊆⊇⊄⊅⊊⊋∩∪∅∖∧∨¬∀∃∴∵'
  + '⇒⇔⟹⟺⇐⇑⇓⇕↔↕↦⟶⟵←↑↓↗↘↙↖'
  + '∠∡∟⊾⊿⊥∥∦∣▱⌒'
  + '∑∏∫∬∭∮∂∇∆∞∝∘⊕⊗⊙⊘⊚⋅⋆⋯⋮⋰⋱'
  + '′″‴‵⁗'
  + '½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅐⅑⅒⅟↉'
  + 'ℝℤℚℕℂℍℙℓℵ℘ℑℜℏⅆⅇⅈℋℒ'
  + 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧϱϰϒµ'                 // 拉丁形大寫希臘＋變體＋micro（只吃真希臘/micro 碼點，不動拉丁 A）
  + '∛∜‖∎∙∗⨯∤∕⁄⌊⌋⌈⌉⟨⟩‰‱≔∊∍⊈⊉⋃⋂∁⊻∄⟸⋀⋁⊤⊢⊨'
  + '≃≑≓∶∷≼≽⋚⋛≮≯≰≱≨≩≢≁≇≉≜≝≟'
  + '∐∯∰⨌⊖⊛⊞⊠⨁⨂⨀'
  + '⇏⇎⇍↛↚↮⟷⟼↺↻↪↩⇄'
  + '∢⦜⟂▭◊⌢⏜∽≌⌀⬠⬡'
  + '⟦⟧ℱℬℰℳⅉ⏢⎧⎨⎩⎡⎣⎛⎝';                  // 白括號/花體字母/梯形/大括號延伸片段（PDF 抓取匯入可能出現）
const U_WRAP_RE = new RegExp('[' + U_WRAP + ']+', 'g');
// 組合附加符號（x̄ 平均、x⃗ 向量、x̂ 帽…）：CJK 字型多半不會把 mark 疊到 base 上 → 位移/豆腐；轉成 KaTeX \bar{x} 等。
const U_COMB = { '̄': 'bar', '̅': 'bar', '̂': 'hat', '̃': 'tilde', '̇': 'dot', '̈': 'ddot', '̊': 'mathring', '̆': 'breve', '⃗': 'vec', '⃖': 'overleftarrow', '⃡': 'overleftrightarrow', '⃛': 'dddot', '́': 'acute', '̀': 'grave' };
const U_COMB_RE = /([A-Za-z0-9Α-ωϑϕϖϵ])([̀-ͯ⃐-⃿])/g; // base 含拉丁/數字/希臘（σ̂ 這種 Greek+mark 也要成 \hat{σ}）
function _mapU(m, tbl) { let o = ''; for (const c of m) o += (tbl[c] || c); return o; }
function normUnicodeMath(s) {
  const parts = String(s).split(/(\\\([\s\S]*?\\\))/); // 奇數格＝島
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { // 島內：literal 上下標/組合符 → _{}/^{}。※不要在這裡把 &lt;→< 還原：島內容之後會進 innerHTML，
      // 裸 < 會被瀏覽器當標籤(XSS/吃掉無空格不等式)。保持逸出，交給 sanitizeContent escIsland 統一逸出、瀏覽器再還原成文字給 KaTeX auto-render。
      parts[i] = parts[i]
        .replace(U_COMB_RE, (m, b, mk) => U_COMB[mk] ? '\\' + U_COMB[mk] + '{' + b + '}' : m)
        .replace(U_SUB_RE, (m) => '_{' + _mapU(m, U_SUB) + '}').replace(U_SUP_RE, (m) => '^{' + _mapU(m, U_SUP) + '}');
    } else { // 島外散文：組合符/向量成島、上下標成 <sub>/<sup>、其餘易豆腐數學符號整批包島交 KaTeX
      const p = parts[i]
        .replace(U_COMB_RE, (m, b, mk) => U_COMB[mk] ? '\\(\\' + U_COMB[mk] + '{' + b + '}\\)' : m)
        .replace(U_VEC_RE, (m, g) => '\\(\\overrightarrow{' + g + '}\\)')
        .replace(U_SUB_RE, (m) => '<sub>' + _mapU(m, U_SUB) + '</sub>')
        .replace(U_SUP_RE, (m) => '<sup>' + _mapU(m, U_SUP) + '</sup>');
      // WRAP 只作用在「非島」段：避免把剛由組合符/向量產生的島內 WRAP 字元（如 \hat{σ} 的 σ）再包一次而套疊島
      parts[i] = p.split(/(\\\([\s\S]*?\\\))/).map((seg, k) => k % 2 ? seg : seg.replace(U_WRAP_RE, (m) => '\\(' + m + '\\)')).join('');
    }
  }
  return parts.join('');
}
/* 立體矩陣：把散文裡「[[a,b],[c,d],…]」這種壓扁成一行的矩陣/向量寫法，轉成真 2D 的 KaTeX bmatrix。
   救匯入內容（如 114數B）不必改檔。島感知（不動既有 \(…\) 內），要求每列元素個數一致才轉（否則不是矩陣、放過）。 */
const MAT_RE = /\[\s*(\[[^\[\]\n]+\](?:\s*,\s*\[[^\[\]\n]+\])+)\s*\]/g;
function matTxt(s) {
  return String(s).split(/(\\\([\s\S]*?\\\))/).map((seg, i) => i % 2 ? seg : seg.replace(MAT_RE, (whole, inner) => {
    const rows = inner.match(/\[[^\[\]]*\]/g);
    if (!rows || rows.length < 2) return whole; // 至少 2 列才當矩陣
    const cells = rows.map((r) => r.slice(1, -1).split(',').map((x) => x.trim()));
    const w = cells[0].length;
    if (!w || !cells.every((row) => row.length === w)) return whole; // 各列元素數不一致＝不是矩陣，原樣放過
    return '\\(\\begin{bmatrix}' + cells.map((row) => row.join(' & ')).join(' \\\\ ') + '\\end{bmatrix}\\)';
  })).join('');
}
/* AI 生成文字的數學界定符修復。模型常做兩件會炸渲染的事：
   (1) 混用 $…$ 與 \(…\)，甚至開 \( 用 $ 收（\(AM$）；(2) 被 max_tokens 截斷，留下沒收尾的島（\(=A\cdot）。
   這種不成對/不平衡的島直接進 KaTeX auto-render → 整段渲不出來，畫面就冒出生的 \( $ \cdot＝使用者看到的「亂碼」。
   解法：單一 toggle 掃過全文，把所有界定符正規化成「成對、平衡」的 \(…\)——
   \( 進數學、\) 出數學、$/$$/\[ \] 都當數學開關、島內再遇 \( 忽略（模型漏收）、島外落單的 \) 當普通右括號、收尾若還在島內就補 \)。
   只動界定符與 markdown 記號，不解 entity、不引入 < → 後面 rtTxt 的 sanitize/escIsland 仍照常擋 XSS。 */
function fixAiMath(s) {
  s = String(s == null ? '' : s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1'); // 模型偶爾漏的 markdown 粗體/行內碼記號
  let out = '', inMath = false, i = 0; const n = s.length;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '\\' && d === '\\') { out += '\\\\'; i += 2; continue; } // LaTeX 換行 \\、列距 \\[6pt] 原樣過（別把第二個 \ 當島界定符起手）
    if (c === '\\' && d === '$') { out += '$'; i += 2; continue; }     // 跳脫貨幣 \$ → 字面 $，不開假島
    if (c === '\\' && (d === '(' || d === '[')) { if (!inMath) { out += '\\('; inMath = true; } i += 2; continue; }
    if (c === '\\' && (d === ')' || d === ']')) { if (inMath) { out += '\\)'; inMath = false; } else { out += d; } i += 2; continue; }
    if (c === '$' && d === '$') { // $$ 顯示界定
      if (inMath) { out += '\\)'; inMath = false; i += 2; continue; }               // 島內遇 $$＝收島（含 \(…$$ 混用）
      if (s.indexOf('$$', i + 2) !== -1) { out += '\\('; inMath = true; i += 2; continue; } // 後面有配對才開島
      out += '$$'; i += 2; continue;                                                // 落單 $$ → 字面
    }
    if (c === '$') { // 單一 $
      if (inMath) { out += '\\)'; inMath = false; i += 1; continue; }               // 島內遇 $＝收島（修「開 \( 卻用 $ 收」的 \(AM$）
      if (s.indexOf('$', i + 1) !== -1) { out += '\\('; inMath = true; i += 1; continue; } // 後面有配對 $ 才開島
      out += '$'; i += 1; continue;                                                 // 落單 $（貨幣/截斷）→ 字面，不吞後面散文（避免回歸）
    }
    out += c; i += 1;
  }
  if (inMath) out += '\\)'; // 收尾未關的島（多半是被 max_tokens 截斷）→ 補上，讓 KaTeX 至少渲得出、不外露生 LaTeX
  return out;
}
function rtAi(s) { return rtTxt(fixAiMath(s)); } // AI 產出的文字一律走這條：先修界定符再照常渲染
function rtTxt(s) {
  s = matTxt(String(s)); // 壓扁的 [[…],[…]] 矩陣 → 立體 bmatrix 島（要在 normUnicodeMath/sanitize 前，之後照島處理）
  s = normUnicodeMath(s); // literal 向量箭頭/上下標 → 正規渲染（救匯入內容的方框/箭頭跑位）
  s = sanitizeContent(s); // 島外散文白名單清洗（擋匯入他人題包的 <img onerror> 等儲存型 XSS）；\(…\) 島原封交給 KaTeX
  s = fracTxt(s); // 先把裸分數轉成 \frac 島（必須在下面 √ 逐字解析之前）
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c >= '0' && c <= '9') { // 可能是「係數√數字」（√(...) 不吃係數，跟舊 regex 一致）
      let j = i; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      if (s[j] === '√' && s[j + 1] !== '(') { const r = rtRoot(s, j); if (r) { out += '\\(' + s.slice(i, j) + r.tex + '\\)'; i = r.next; continue; } }
      out += s.slice(i, j); i = j; continue;
    }
    if (c === '√') { const r = rtRoot(s, i); if (r) { out += '\\(' + r.tex + '\\)'; i = r.next; continue; } }
    out += c; i++;
  }
  return out;
}
function rtRoot(s, i) { // s[i]==='√'；回傳 {tex:'\\sqrt{...}', next} 或 null（後面不是可轉內容→當文字）
  i++;
  if (s[i] === '(') { // √(算式)：內層不得含括號/<>（跟舊 regex [^()<>] 一致，避免把含中文標記的複雜式硬塞進 KaTeX）；內層的 √ 仍遞迴轉→支援 √(8+√2)
    let j = i + 1;
    for (; j < s.length; j++) { const ch = s[j]; if (ch === ')') break; if (ch === '(' || ch === '<' || ch === '>') return null; }
    if (j >= s.length || j === i + 1) return null; // 沒有右括號或空括號
    return { tex: '\\sqrt{' + rtInner(s.slice(i + 1, j)) + '}', next: j + 1 };
  }
  let j = i; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++; // √數字（可含一個小數點）
  if (s[j] === '.' && s[j + 1] >= '0' && s[j + 1] <= '9') { j++; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++; }
  if (j === i) return null;
  return { tex: '\\sqrt{' + s.slice(i, j) + '}', next: j };
}
function rtInner(s) { // 括號內容：只把 √ 遞迴轉成 \sqrt{}，不再包島
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '√') { const r = rtRoot(s, i); if (r) { out += r.tex; i = r.next; continue; } }
    out += s[i]; i++;
  }
  return out;
}
/* 方法庫等純文字內的分數轉直式＋根號蓋線（保守：只轉 a/b、√a/b 形式） */
function mathTxt(s) {
  return rtTxt(escH(s).replace(/(√?\d{1,3})\/(√?\d{1,3})(?![\d/])/g, (m, a, b) => fracH(a, b)));
}
async function showMethods(unit, noScroll) {
  const box = $('#mlib-box');
  if (!box) return;
  box.innerHTML = '<p class="dim">🧑‍🏫 載入老師方法庫…</p>';
  const lib = await loadMethodLib();
  const cur = $('#mlib-box');
  if (!cur) return; // 載入期間已換頁
  if (!lib) {
    cur.innerHTML = `<p class="dim">${mlibEmptyMsg()}</p>${supa && syncState.user
      ? `<div class="actr"><button class="btn sm" onclick="showMethods('${unit}')">🔄 重試</button></div>` : ''}`;
    return;
  }
  const ms = lib[unit] || [];
  if (!ms.length) { cur.innerHTML = `<p class="dim">「${TOPICS[unit]}」沒有對應的老師方法（課程未涵蓋這單元）。</p>`; return; }
  cur.innerHTML = `<div class="mlib">
    <p><b>🧑‍🏫 ${TOPICS[unit]}</b>｜老師方法 <b>${ms.length}</b> 條（42 堂課逐字稿蒸餾）——點開概念看他怎麼教：</p>
    ${ms.map((m) => `<details><summary>${mathTxt(m.concept)}${m.ex ? ` <span class="dim">（${mathTxt(m.ex)}）</span>` : ''}</summary>
      <p>${mathTxt(m.method)}</p>
      ${m.mnemonic ? `<p class="teach-tip">🔑 ${mathTxt(m.mnemonic)}</p>` : ''}
      ${m.black ? `<p class="dim">黑板答案：${mathTxt(m.black)}</p>` : ''}</details>`).join('')}
  </div>`;
  if (!noScroll) cur.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); } // 台灣本地日（UTC+8）：日界＝台灣午夜，不是 UTC 午夜（在台灣是早上 8 點）
/* 純日期加減。一定要全程 UTC：舊版「本地 parse＋UTC 輸出」在台灣（UTC+8）會少一天——
   addDays(x,1) 回傳 x 本身，錯題到期日全部提前、連續天數隔天跳算。 */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysUntil(dateStr, fromDate) {
  const parse = (value) => {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const end = parse(dateStr), start = parse(fromDate || today());
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, Math.round((end - start) / 86400000)) : 0;
}

const ERR_TYPES = ['概念不熟', '計算失誤', '看錯題意', '用猜的', '超時'];
const EXAM_DATE = '2027-01-22'; // 116 學年度學測（暫定）
const SCORE_GOAL = { baseline: 9, target: 13, targetAcc: 0.72, mockQuestions: 20, mockPass: 72 };
const MOCK_SPEC = {
  minutes: 100,
  total: 20,
  sections: [
    { key: 'single', label: '單選題', count: 6, points: [5, 5, 5, 5, 5, 5] },
    { key: 'multi', label: '多選題', count: 6, points: [5, 5, 5, 5, 5, 5] },
    { key: 'fill', label: '選填題', count: 5, points: [5, 5, 5, 5, 5] },
    { key: 'mixed', label: '混合題／非選擇題', count: 3, points: [3, 4, 8] },
  ],
};
/* 正式卷末段不是三道互不相干的填充題，而是共享情境、逐步深入的混合／非選擇題組。
   每回抽一整組，三小題固定 3／4／8 分；解答保留完整推導，隔日訂正才解鎖。 */
const MOCK_MIXED_GROUPS = [
  {
    id: 'mixed-coordinate-park',
    title: '座標與向量題組',
    stem: '在坐標平面上，三角形 \(ABC\) 的三個頂點為 \(A(0,0)\)、\(B(6,0)\)、\(C(2,4)\)。點 \(P\) 在線段 \(AB\) 上，且 \(AP:PB=1:2\)。回答下列三小題，並在計算區留下推導。',
    items: [
      { id: 'mixed-coordinate-park-1', topic: 'vec', type: 'fill', diff: 2, q: '求點 \(P\) 的 \(x\) 坐標。', ans: ['2'], sol: '內分點把 \(AB\) 分成 \(1:2\)，所以 \(P=A+\frac13(B-A)=(2,0)\)，答案為 \(2\)。' },
      { id: 'mixed-coordinate-park-2', topic: 'vec', type: 'fill', diff: 2, q: '求三角形 \(PBC\) 的面積。', ans: ['8'], sol: '\(PB=4\)，而 \(C\) 到 \(AB\) 的高為 \(4\)，所以面積為 \(\frac12\times4\times4=8\)。' },
      { id: 'mixed-coordinate-park-3', topic: 'vec', type: 'fill', diff: 3, q: '點 \(D\) 在射線 \(PC\) 上且位於 \(C\) 的外側。若三角形 \(BCD\) 的面積是三角形 \(BCP\) 的兩倍，求 \(PD\)。', ans: ['12'], sol: '令 \(D=(2,d)\)，其中 \(d>4\)。直線 \(PC\) 到 \(B\) 的水平距離為 \(4\)，故 \([BCD]=\frac12(d-4)\times4=2(d-4)\)。又 \([BCP]=8\)，所以 \(2(d-4)=16\)，得 \(d=12\)。因 \(P=(2,0)\)，故 \(PD=12\)。' },
    ],
  },
  {
    id: 'mixed-probability-box',
    title: '條件機率題組',
    stem: '袋中有 3 顆紅球與 2 顆藍球，球除顏色外無差別。從袋中不放回地依序抽出 2 顆球。回答下列三小題，機率請化成最簡分數。',
    items: [
      { id: 'mixed-probability-box-1', topic: 'prob', type: 'fill', diff: 2, q: '兩顆都是紅球的機率為何？', ans: ['3/10'], sol: '\(\frac35\times\frac24=\frac3{10}\)。' },
      { id: 'mixed-probability-box-2', topic: 'prob', type: 'fill', diff: 2, q: '兩顆顏色不同的機率為何？', ans: ['3/5'], sol: '紅藍或藍紅，機率為 \(\frac35\frac24+\frac25\frac34=\frac35\)。' },
      { id: 'mixed-probability-box-3', topic: 'prob', type: 'fill', diff: 3, q: '已知抽出的兩顆球中至少有一顆紅球，求兩顆都是紅球的條件機率。', ans: ['1/3'], sol: '至少一紅的機率為 \(1-P(\text{兩藍})=1-\frac25\frac14=\frac9{10}\)。所以條件機率為 \(\frac{3/10}{9/10}=\frac13\)。' },
    ],
  },
  {
    id: 'mixed-sequence-growth',
    title: '數列遞迴題組',
    stem: '數列 \(\{a_n\}\) 滿足 \(a_1=2\)，且對所有正整數 \(n\)，\(a_{n+1}=a_n+2n\)。回答下列三小題。',
    items: [
      { id: 'mixed-sequence-growth-1', topic: 'seq', type: 'fill', diff: 2, q: '求 \(a_2\)。', ans: ['4'], sol: '\(a_2=a_1+2=4\)。' },
      { id: 'mixed-sequence-growth-2', topic: 'seq', type: 'fill', diff: 2, q: '求 \(a_4\)。', ans: ['14'], sol: '\(a_2=4\)、\(a_3=8\)、\(a_4=14\)。' },
      { id: 'mixed-sequence-growth-3', topic: 'seq', type: 'fill', diff: 3, q: '求使 \(a_n>100\) 的最小正整數 \(n\)。', ans: ['11'], sol: '\(a_n=2+2(1+2+\cdots+n-1)=n^2-n+2\)。\(a_{10}=92\le100\)，\(a_{11}=112>100\)，所以最小的 \(n\) 為 \(11\)。' },
    ],
  },
];
const MOCK_MIXED_MAP = new Map(MOCK_MIXED_GROUPS.flatMap((group) => group.items.map((q, index) => [q.id, {
  ...q,
  grp: group.id,
  groupId: group.id,
  groupTitle: group.title,
  stem: `${index === 0 ? '【共享題幹】' : '【同一題組，題幹重列】'}${group.stem}`,
  responseType: 'written',
}])));

/* 2026-07-17 依使用者提供的 12 頁「數11單元大綱」逐頁人工複核。
   reference 是語意核對基準，不複製原書版面；保留章節樹、定義、公式與關係，讓默寫可離線使用。 */
const OUTLINE_DEFAULTS = [
  { id: 'outline-1', title: '集合、邏輯與實數系', reference: `
集合：集合、元素、子集、空集合、宇集、餘集；能用列舉法與描述法表示。有限集合會用容斥原理計數：n(A∪B)=n(A)+n(B)-n(A∩B)，三集合時加單集、減兩兩交集、再加三者交集；也要辨認無限集合。
邏輯：命題 p→q 的原命題、逆命題 q→p、否命題 ¬p→¬q、逆否命題 ¬q→¬p；原命題與逆否命題等價。分清充分條件、必要條件、充要條件，以及 p⇔q。
實數系：有理數包含整數、有限小數與循環小數；無理數是不循環無限小數。會做根式化簡與乘法不等式；a,b≥0 時 (a+b)/2≥√(ab)，等號在 a=b。
運算公式：(a±b)²、(a+b)(a-b)、(a±b)³、a³±b³ 的展開與因式分解。
數線幾何：|a| 是 a 到 0 的距離，|a-b| 是 a、b 的距離；能把絕對值方程、不等式與區間符號互換。`.trim() },
  { id: 'outline-2', title: '直角坐標系中直線、半平面與圓', reference: `
平面直角坐標：兩點距離與中點公式。
斜率：m=(y₂-y₁)/(x₂-x₁)；平行線斜率相等，垂直線斜率乘積為 -1（斜率存在時）。
直線：點斜式 y-y₀=m(x-x₀)、一般式 ax+by+c=0；b=0 是 x=-c/a，b≠0 時斜率 -a/b。點到直線距離為 |ax₀+by₀+c|/√(a²+b²)。
二元一次聯立方程：一組解代表兩線交一點、無解代表平行、無限多解代表重合。二元一次不等式 ax+by+c>0 或 <0 表示直線一側的半平面，可代測試點判別。
圓：標準式 (x-h)²+(y-k)²=r²；一般式 x²+y²+Dx+Ey+F=0，圓心 (-D/2,-E/2)，半徑 √(D²+E²-4F)/2。
直線與圓：可聯立後看判別式 D>0、=0、<0 判相割、相切、相離，或比較圓心到直線距離 d 與半徑 r。`.trim() },
  { id: 'outline-3', title: '函數與多項式函數', reference: `
函數：以集合定義函數，知道自變數、應變數、定義域、值域；實函數及其圖形是 {(x,f(x))}。
多項式：會做加、減、乘、除；除法定理 f(x)=g(x)q(x)+r(x)，且 r 的次數小於 g；餘式定理 f(x) 除以 x-c 的餘式為 f(c)，因式定理 f(c)=0⇔x-c 是因式。
多項式圖形：一次函數的斜率與截距；二次函數 f(x)=a(x-h)²+k 的開口、對稱軸、頂點；三次函數平移後的中心對稱特徵。
方程式：n 次方程式與根；a 是 f(x)=0 的根等價於 x-a 為因式。
不等式：一次不等式直接整理；二次不等式先由判別式與根分析符號；高次不等式可因式分解或代數方法解。`.trim() },
  { id: 'outline-4', title: '三角比與三角函數', reference: `
角：六十分制、弧度制；弧長 l=rθ、扇形面積=(1/2)r²θ（θ 用弧度）。
三角比：sin²θ+cos²θ=1、sin(90°-θ)=cosθ、cos(90°-θ)=sinθ、tanθ=sinθ/cosθ；熟悉負角、180°±θ 與象限正負；極坐標 x=r cosθ、y=r sinθ。
解三角形：面積=(1/2)bc sinA；正弦定理 a/sinA=b/sinB=c/sinC=2R；餘弦定理 a²=b²+c²-2bc cosA。
公式：和角公式、倍角公式、半角公式，並注意半角根號的正負由 θ/2 的象限決定。
三角函數：y=sinx、cosx、tanx 的基本圖形；a sinx+b cosx 可合成 √(a²+b²)sin(x+φ)；y=a sin(ωx+φ)+b 的振幅 |a|、週期 2π/|ω| 與平移；能解含三角函數的方程式與不等式。`.trim() },
  { id: 'outline-5', title: '有限數列與有限級數', reference: `
數列：等差數列 aₙ=a₁+(n-1)d；a,b,c 成等差時 b=(a+c)/2。等比數列 aₙ=a₁rⁿ⁻¹；a,b,c 成等比時 b²=ac，實數情況可能有正負兩個中項。
遞迴：能由初值與遞迴關係決定等差、等比或其他數列。
數學歸納法：先證 n=1（或起始值），再假設 n=k 成立並推出 n=k+1 成立。
級數：等差和 Sₙ=n[2a₁+(n-1)d]/2=n(a₁+aₙ)/2；等比和 r≠1 時 Sₙ=a₁(1-rⁿ)/(1-r)，r=1 時 Sₙ=na₁。
常用和：1+…+n=n(n+1)/2；1²+…+n²=n(n+1)(2n+1)/6；1³+…+n³=[n(n+1)/2]²。`.trim() },
  { id: 'outline-6', title: '數據分析', reference: `
代表值：算術平均、加權平均、幾何平均、眾數、中位數、百分位數。
離散程度：全距、變異數 Var(X)=平均的 (xᵢ-μ)²、標準差 σ=√Var(X)。資料標準化 z=(x-μ)/σ，標準化後平均 0、標準差 1。
資料轉換：Y=aX+b 時 μY=aμX+b、σY=|a|σX。
二維資料：由散布圖辨認正相關、零相關、負相關。相關係數可由標準化資料乘積的平均求得，範圍 -1≤r≤1；r=±1 時點落在一直線上。
線性轉換後的相關係數：正比例不改符號、負比例會反號。最適直線（迴歸直線）通過 (μx,μy)，斜率為 r·σy/σx，方程 y-μy=r(σy/σx)(x-μx)。`.trim() },
  { id: 'outline-7', title: '排列組合與機率', reference: `
計數原理：樹狀圖、一對一原理、加法原理、乘法原理、取捨原理。
排列：n 個相異物全排列 n!；取 k 個排列 n!/(n-k)!；有相同物的排列需除以各類重複階乘；重複排列 nʳ（或從 m 個可重複取 n 次為 mⁿ）。
組合：C(n,m) 可視為選 m 個或選掉 n-m 個；巴斯卡公式 C(n-1,m-1)+C(n-1,m)=C(n,m)；二項式定理展開 (x+y)ⁿ。
機率類別：古典機率、長期相對頻率形成的客觀機率、依經驗判斷的主觀機率。
機率性質：0≤P(A)≤1、P(Aᶜ)=1-P(A)、聯集容斥；期望值 E=Σmᵢpᵢ。
條件機率 P(A|B)=P(A∩B)/P(B)；貝氏定理以分割事件重算後驗機率。獨立事件滿足 P(A∩B)=P(A)P(B)，多事件獨立需同時檢查各交集條件。`.trim() },
  { id: 'outline-8', title: '指數與對數', reference: `
指數：實數指數需底數 a>0；熟悉 aᵐaⁿ=aᵐ⁺ⁿ、(aᵐ)ⁿ=aᵐⁿ、(ab)ⁿ=aⁿbⁿ，以及 a>1 與 0<a<1 時大小關係的方向。能解指數方程與不等式。
對數：a>0、a≠1、b>0 時 aˣ=b⇔x=logₐb；logₐ(MN)=logₐM+logₐN、logₐ(M/N)=logₐM-logₐN、logₐ(Mʳ)=rlogₐM、換底公式 logₐb=log_cb/log_ca。能解對數方程。
圖形：y=aˣ 與 y=logₐx 互為反函數、關於 y=x 對稱；都經過 (0,1) 或 (1,0)。a>1 遞增，0<a<1 遞減。
應用：單利與複利；科學記號、首數與尾數判斷位數；成長與衰退模型；視星等、地震等對數尺度。`.trim() },
  { id: 'outline-9', title: '平面向量、線性組合與二階行列式', reference: `
平面向量：向量坐標、加減、實數倍、分點公式。
內積：a·b=|a||b|cosθ=a₁b₁+a₂b₂；向量長度與夾角；b 在 a 方向的正射影為 (a·b/|a|²)a。柯西不等式 |a·b|≤|a||b|，並理解三角不等式 |a+b|≤|a|+|b|。
線性組合：c=xa+yb；三點共線可由位置向量的係數和為 1 判斷。
二階行列式：|a₁ b₁; a₂ b₂| 的絕對值給平行四邊形面積；三點面積可用兩個位移向量的行列式；二元一次聯立方程可用克拉瑪公式判一解、無限多解或無解。`.trim() },
  { id: 'outline-10', title: '空間中的向量與直線、平面方程式', reference: `
空間坐標與向量：空間兩點、向量加減、實數倍、分點；內積 a·b=a₁b₁+a₂b₂+a₃b₃、夾角、正射影、柯西不等式。
外積與體積：|a×b|=|a||b|sinθ 是平行四邊形面積；(a×b)·c 的絕對值是平行六面體體積。
平面：法向量 (a,b,c)；點法式 a(x-x₀)+b(y-y₀)+c(z-z₀)=0、一般式 ax+by+cz+d=0；兩平面夾角由法向量，點到平面距離為 |ax₀+by₀+cz₀+d|/√(a²+b²+c²)，平行平面距離同理。
直線：參數式、對稱比例式，或兩平面聯立；由方向向量判兩直線平行、相交、重合或歪斜，也能判直線與平面的一解、無限多解、無解。
n 元一次聯立方程：代入消去、加減消去與高斯消去；以增廣矩陣做基本列運算（交換兩列、整列乘非零常數、某列加另一列倍數），化為階梯形後回代；線性方程組可寫成 AX=b。`.trim() },
  { id: 'outline-11', title: '矩陣與線性變換及其應用', reference: `
矩陣：行、列、元、階數；加減與係數乘按對應位置計算，矩陣乘法依列乘行，通常不可交換。
反方陣：AB=BA=I；存在條件 det(A)≠0；二階反矩陣 A⁻¹=(1/detA)[d -b; -c a]。
轉移矩陣：各元素非負且每欄（依本書約定）和為 1；穩定狀態 X 滿足 AX=X。
線性變換：f(x,y)=(ax+by,cx+dy)，以矩陣 [a b; c d] 表示；變換後面積為 |detA| 倍。
基本變換：旋轉、鏡射、推移（剪切）、伸縮；知道各自的 2×2 矩陣，以及複合變換的矩陣乘法順序。`.trim() },
];

/* 使用者提供的原版紙本模考只以私有 Storage 掃描頁呈現，不把受版權保護的題目圖片提交到公開 repo。
   2026-07-17 已逐頁核對題本與正式答案本：第一次、第三次各 20 題，第二次實際只有 19 題。
   key 只保存批分所需的最終答案，不把整張答案／詳解頁提早暴露。選項索引採 0 起算。 */
const PAPER_SOURCE_BUCKET = 'matha-papers';
const PAPER_SOURCES = [
  { id: 'paper-mock-1', title: '第一次模考', questions: 20, minutes: 100, pages: 6,
    key: [
      { type: 'single', ans: [4], points: 5 }, { type: 'single', ans: [4], points: 5 },
      { type: 'single', ans: [2], points: 5 }, { type: 'single', ans: [3], points: 5 },
      { type: 'single', ans: [3], points: 5 }, { type: 'single', ans: [3], points: 5 },
      { type: 'single', ans: [2], points: 5 }, { type: 'multi', ans: [0, 3], points: 5 },
      { type: 'multi', ans: [0, 3, 4], points: 5 }, { type: 'multi', ans: [1, 2, 4], points: 5 },
      { type: 'multi', ans: [3, 4], points: 5 }, { type: 'multi', ans: [0, 3, 4], points: 5 },
      { type: 'multi', ans: [2, 3, 4], points: 5 },
      { type: 'fill', ans: ['50/269'], display: '50/269', points: 5 },
      { type: 'fill', ans: ['0'], display: '0', points: 5 },
      { type: 'fill', ans: ['10/3'], display: '10/3', points: 5 },
      { type: 'fill', ans: ['728/27'], display: '728/27', points: 5 },
      { type: 'single', ans: [3], points: 3 },
      { type: 'fill', ans: ['-1'], display: '-1', points: 6 },
      { type: 'fill', ans: ['9/26'], display: '9/26', points: 6 },
    ],
    scans: [
      { file: 'mock-1-page-1-2.png', label: '題本第 1 頁', side: 'left' },
      { file: 'mock-1-page-1-2.png', label: '題本第 2 頁', side: 'right' },
      { file: 'mock-1-page-3-4.png', label: '題本第 3 頁', side: 'left' },
      { file: 'mock-1-page-3-4.png', label: '題本第 4 頁', side: 'right' },
      { file: 'mock-1-page-5-6.png', label: '題本第 5 頁', side: 'left' },
      { file: 'mock-1-page-5-6.png', label: '題本第 6 頁', side: 'right' },
    ] },
  { id: 'paper-mock-2', title: '第二次模考', questions: 19, minutes: 100, pages: 6,
    calibrationEligible: false, practiceReason: '原始題本只有 19 題，不符合正式學測 20 題結構',
    key: [
      { type: 'single', ans: [1], points: 5 }, { type: 'single', ans: [0], points: 5 },
      { type: 'single', ans: [2], points: 5 }, { type: 'single', ans: [1], points: 5 },
      { type: 'single', ans: [2], points: 5 }, { type: 'single', ans: [1], points: 5 },
      { type: 'single', ans: [4], points: 5 }, { type: 'multi', ans: [1, 2, 3], points: 5 },
      { type: 'multi', ans: [0, 1, 2, 3, 4], points: 5 }, { type: 'multi', ans: [0, 4], points: 5 },
      { type: 'multi', ans: [1, 3], points: 5 }, { type: 'multi', ans: [1, 4], points: 5 },
      { type: 'multi', ans: [1, 3, 4], points: 5 },
      { type: 'fill', ans: ['26'], display: '26', points: 5 },
      { type: 'fill', ans: ['√(131/14)', 'sqrt(131/14)', '√131/√14'], display: '√(131/14)', points: 5 },
      { type: 'fill', ans: ['365/51'], display: '365/51', points: 5 },
      { type: 'fill', ans: ['5'], display: '5', points: 5 },
      { type: 'single', ans: [1], points: 5 },
      { type: 'fill', ans: ['0.488', '61/125'], display: '0.488', points: 10 },
    ],
    scans: [
      { file: 'mock-2-page-1-2.png', label: '題本第 1 頁', side: 'left' },
      { file: 'mock-2-page-1-2.png', label: '題本第 2 頁', side: 'right' },
      { file: 'mock-2-page-3-4.png', label: '題本第 3 頁', side: 'left' },
      { file: 'mock-2-page-3-4.png', label: '題本第 4 頁', side: 'right' },
      { file: 'mock-2-page-5-6.png', label: '題本第 5 頁', side: 'left' },
      { file: 'mock-2-page-5-6.png', label: '題本第 6 頁', side: 'right' },
    ] },
  { id: 'paper-mock-3', title: '第三次模考', questions: 20, minutes: 100, pages: 4,
    key: [
      { type: 'single', ans: [3], points: 5 }, { type: 'single', ans: [2], points: 5 },
      { type: 'single', ans: [1], points: 5 }, { type: 'single', ans: [1], points: 5 },
      { type: 'single', ans: [0], points: 5 }, { type: 'single', ans: [1], points: 5 },
      { type: 'single', ans: [3], points: 5 }, { type: 'multi', ans: [0, 1, 2, 3, 4], points: 5 },
      { type: 'multi', ans: [1, 3, 4], points: 5 }, { type: 'multi', ans: [0, 1, 3, 4], points: 5 },
      { type: 'multi', ans: [0, 2], points: 5 }, { type: 'multi', ans: [1, 4], points: 5 },
      { type: 'multi', ans: [0, 3, 4], points: 5 },
      { type: 'fill', ans: ['∛2', '2^(1/3)', 'cbrt(2)'], display: '∛2', points: 5 },
      { type: 'fill', ans: ['13/6'], display: '13/6', points: 5 },
      { type: 'fill', ans: ['2√7', '2sqrt(7)', '2*sqrt(7)'], display: '2√7', points: 5 },
      { type: 'fill', ans: ['15'], display: '15', points: 5 },
      { type: 'single', ans: [2], points: 3 },
      { type: 'fill', ans: ['72'], display: '72', points: 8 },
      { type: 'fill', ans: ['-4/3'], display: '-4/3', points: 4 },
    ],
    scans: [
      { file: 'mock-3-page-1-2.png', label: '題本第 1 頁', side: 'left' },
      { file: 'mock-3-page-1-2.png', label: '題本第 2 頁', side: 'right' },
      { file: 'mock-3-page-3-4.png', label: '題本第 3 頁', side: 'left' },
      { file: 'mock-3-page-3-4.png', label: '題本第 4 頁', side: 'right' },
    ] },
];
const PAPER_ERROR_KINDS = [
  '看不出第一個切入點',
  '單元／工具判斷錯誤',
  '條件翻譯不完整',
  '定義或公式不熟',
  '建式方向錯誤',
  '推理中間有缺口',
  '計算或符號失誤',
  '圖形／空間想像卡住',
  '答案表達或收尾錯誤',
];
function paperErrorKindOptions(selected) {
  return `<option value="">選一個最接近的卡點</option>${PAPER_ERROR_KINDS.map((kind) =>
    `<option value="${escH(kind)}"${selected === kind ? ' selected' : ''}>${escH(kind)}</option>`).join('')}`;
}

/* 定義卡只存數學概念本身，不要求逐字背誦。reference 是 AI 判斷語意是否完整的準繩，
   prompt 則刻意要求「自己的話＋例子／反例」，避免只背課本句子。 */
const CONCEPT_CARDS = [
  { id: 'concept-function', unit: 'num', title: '函數', prompt: '不用背課本句子：什麼情況才叫函數？請用自己的話說，並舉一個「不是函數」的例子。', reference: '函數是從定義域每一個輸入，恰好指定到一個輸出的對應。不同輸入可以有相同輸出，但同一輸入不能同時對到兩個不同輸出。' },
  { id: 'concept-necessary-sufficient', unit: 'num', title: '充分條件與必要條件', prompt: '用自己的話解釋「P 是 Q 的充分條件」和「P 是 Q 的必要條件」，最好各給一例。', reference: 'P 充分於 Q 表示 P 發生就保證 Q 發生，即 P 推出 Q；P 必要於 Q 表示 Q 要成立不能缺 P，即 Q 推出 P。兩個方向不可混用。' },
  { id: 'concept-absolute', unit: 'num', title: '絕對值', prompt: '絕對值真正代表什麼？為什麼 |x-a| 可以拿來描述一段區間？', reference: '絕對值代表數線上的距離，所以永遠非負。|x-a| 是 x 與 a 的距離；限制它小於某數是在限制 x 落在以 a 為中心的一段範圍。' },
  { id: 'concept-log', unit: 'exp', title: '對數', prompt: '不要只寫公式：log_a b 到底在問什麼？底數與真數為什麼有限制？', reference: 'log_a b 是「a 的幾次方等於 b」的指數。實數範圍要有 a>0、a≠1、b>0，因為正底數的實數次方為正，底數 1 又無法用指數區分結果。' },
  { id: 'concept-sequence', unit: 'seq', title: '數列與遞迴', prompt: '數列是什麼？遞迴式提供了什麼資訊，又還缺什麼才真正決定整個數列？', reference: '數列可視為以正整數索引的函數。遞迴式描述相鄰或先前各項如何產生下一項，通常還需要足夠的初始值才能唯一決定整個數列。' },
  { id: 'concept-conditional', unit: 'prob', title: '條件機率', prompt: '用自己的話說明 P(A|B) 的分母為什麼變成 P(B)，它和 P(A∩B) 差在哪裡。', reference: '已知 B 發生後，樣本空間縮小為 B；其中同時屬於 A 的部分是 A∩B，所以 P(A|B)=P(A∩B)/P(B)，前提是 P(B)>0。' },
  { id: 'concept-independent', unit: 'prob', title: '獨立事件', prompt: '兩事件「獨立」真正表示什麼？它和「互斥」為什麼不是同一件事？', reference: '獨立表示知道其中一事件是否發生，不改變另一事件的機率，等價於 P(A∩B)=P(A)P(B)。互斥表示不能同時發生；兩個機率皆正的互斥事件反而不獨立。' },
  { id: 'concept-expectation', unit: 'prob', title: '期望值', prompt: '期望值為什麼不是「最可能出現的值」？請用長期重複試驗的角度解釋。', reference: '期望值是各可能值以其機率加權的平均，代表大量重複試驗時平均結果趨近的中心，不必是任何一次能取到的值，也不一定是機率最大的值。' },
  { id: 'concept-sd', unit: 'data', title: '標準差', prompt: '標準差在量什麼？全部資料同加一個常數、或同乘一個常數時會怎麼變？為什麼？', reference: '標準差量資料相對平均數的典型散布程度。全部同加常數只平移所以不變；同乘 c，距平均數的差也乘 c，因此標準差乘 |c|。' },
  { id: 'concept-dot', unit: 'vec', title: '向量內積', prompt: '內積的幾何意義是什麼？為什麼能用它判斷夾角、垂直與投影？', reference: '內積 a·b=|a||b|cosθ，衡量兩向量同方向成分的程度。內積為零（且向量非零）代表垂直；除以一向量長度可得到另一向量在該方向的純量投影。' },
  { id: 'concept-normal', unit: 'splane', title: '法向量', prompt: '法向量和直線／平面是什麼關係？為什麼方程式的係數會直接給法向量？', reference: '法向量是與直線（平面中）或平面（空間中）垂直的非零向量。方程式中變數係數形成的向量，與同一圖形上任兩點的方向向量內積為零，因此是法向量。' },
  { id: 'concept-matrix', unit: 'mat', title: '矩陣與線性變換', prompt: '矩陣除了「一排數字」之外代表什麼？矩陣乘法的先後順序為什麼通常不能交換？', reference: '矩陣可表示把向量送到另一向量的線性變換；每一欄可看成基底向量變換後的位置。矩陣相乘代表依序做變換，先後順序改變通常會得到不同結果，所以通常不可交換。' },
];

/* ═══════════ 工具 ═══════════ */
const $ = (sel) => document.querySelector(sel);
const app = () => $('#app');
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
/* ═══ 全站自製圖示與 emoji 清理 ═══
   舊介面把 emoji 當 icon，跨平台會出現不同彩色圖案、破壞低彩度視覺。現在所有可見 emoji 會在 paint 前
   換成 index.html 內自繪的單色 SVG；無對應的高位 emoji 直接拿掉。數學符號與一般箭頭不在 fallback 範圍。 */
function uiIcon(name, cls) {
  return `<svg class="ui-icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#ui-${name}"></use></svg>`;
}
const UI_ICON_MAP = {
  '🧑‍🏫': ['tutor'], '🏫': ['tutor'], '🎯': ['target'], '✅': ['check', 'ui-icon-ok'], '✔': ['check', 'ui-icon-ok'],
  '✓': ['check', 'ui-icon-ok'], '❌': ['x', 'ui-icon-bad'], '✘': ['x', 'ui-icon-bad'], '✗': ['x', 'ui-icon-bad'], '✕': ['x'],
  '⚠️': ['alert', 'ui-icon-warn'], '⚠': ['alert', 'ui-icon-warn'], '⚡': ['bolt'], '🤖': ['spark'], '🎉': ['spark'],
  '📊': ['chart'], '📈': ['trend'], '💡': ['bulb'], '🧠': ['brain'], '★': ['spark'], '☆': ['spark', 'ui-icon-muted'],
  '📓': ['book'], '📖': ['book'], '📚': ['book'], '🍅': ['clock'], '▶': ['play'], '⏸': ['pause'],
  '🎓': ['award'], '🏆': ['award'], '🏅': ['award'], '📱': ['phone'], '✍️': ['pencil'], '✍': ['pencil'],
  '📝': ['pencil'], '🖍': ['pencil'], '⏱️': ['clock'], '⏱': ['clock'], '⏰': ['clock'], '🔥': ['flame'],
  '↩': ['undo'], '↪': ['undo'], '☁️': ['cloud'], '☁': ['cloud'], '🃏': ['cards'], '📦': ['package'],
  '🔴': ['dot', 'ui-icon-bad'], '🟡': ['dot', 'ui-icon-warn'], '🟢': ['dot', 'ui-icon-ok'], '⚫': ['dot'],
  '🔑': ['key'], '🔎': ['search'], '📅': ['calendar'], '🗓️': ['calendar'], '🗓': ['calendar'], '🗺️': ['map'], '🗺': ['map'],
  '💬': ['message'], '🏁': ['flag'], '🏳️': ['flag'], '🏳': ['flag'], '🔒': ['lock'], '📐': ['ruler'], '⬜': ['square'],
  '⬆': ['arrow-up'], '⬇': ['arrow-down'], '📋': ['clipboard'], '🔄': ['sync'], '🔢': ['numbers'], '💾': ['save'],
  '↕': ['expand'], '↔': ['expand'], '↙': ['expand'], '↘': ['expand'], '↗': ['expand'], '↖': ['expand'], '🧽': ['erase'],
};
const UI_ICON_KEYS = Object.keys(UI_ICON_MAP).sort((a, b) => b.length - a.length);
const UI_ICON_TOKEN_RE = new RegExp('(' + UI_ICON_KEYS.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
const UI_HIGH_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\uFE0F\u200D]/gu;
const UI_HIGH_EMOJI_TEST_RE = /[\u{1F000}-\u{1FAFF}\uFE0F\u200D]/u;
function uiTextOnly(value) {
  let s = String(value == null ? '' : value);
  for (const token of UI_ICON_KEYS) s = s.split(token).join('');
  return s.replace(UI_HIGH_EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim();
}
function uiIconNode(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ui-icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#ui-' + name);
  svg.appendChild(use);
  return svg;
}
function decorateUi(root) {
  if (!root || !document.createTreeWalker) return;
  const scope = root.nodeType === 1 ? root : root.parentElement;
  if (!scope) return;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,svg,math,textarea,option,.katex')) return NodeFilter.FILTER_REJECT;
      return UI_ICON_KEYS.some((key) => n.nodeValue.includes(key)) || UI_HIGH_EMOJI_TEST_RE.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = []; let node; while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of textNode.nodeValue.split(UI_ICON_TOKEN_RE)) {
      const mapped = UI_ICON_MAP[part];
      if (mapped) frag.appendChild(uiIconNode(mapped[0], mapped[1]));
      else {
        const clean = part.replace(UI_HIGH_EMOJI_RE, '');
        if (clean) frag.appendChild(document.createTextNode(clean));
      }
    }
    textNode.replaceWith(frag);
  }
  scope.querySelectorAll('[title],[aria-label],[placeholder]').forEach((el) => {
    for (const attr of ['title', 'aria-label', 'placeholder']) if (el.hasAttribute(attr)) el.setAttribute(attr, uiTextOnly(el.getAttribute(attr)));
  });
}
let uiDecorateQueued = false;
function initUiObserver() {
  if (!window.MutationObserver) return;
  const mo = new MutationObserver(() => {
    if (uiDecorateQueued) return;
    uiDecorateQueued = true;
    queueMicrotask(() => { uiDecorateQueued = false; decorateUi(document.body); });
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}
function installUiDialogCleaners() {
  const nativeAlert = window.alert.bind(window), nativeConfirm = window.confirm.bind(window), nativePrompt = window.prompt.bind(window);
  window.alert = (message) => nativeAlert(uiTextOnly(message));
  window.confirm = (message) => nativeConfirm(uiTextOnly(message));
  window.prompt = (message, value) => nativePrompt(uiTextOnly(message), value);
}
function fmtSec(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 答案字串正規化：全形→半形、去空白、統一負號與括號
function norm(s) {
  return String(s).trim()
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[，]/g, ',').replace(/[．]/g, '.')
    .replace(/[−–—]/g, '-').replace(/\s+/g, '')
    .toLowerCase()
    .replace(/^[a-z]=/, ''); // 「x=5」與「5」視為相同
}
function parseFrac(s) {
  s = norm(s);
  const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)'; // 接受 5 / +5 / -5 / .5 / 5. / 5.5（含正號與省略整數位的小數）
  const m = s.match(new RegExp('^(' + NUM + ')\\/(' + NUM + ')$'));
  if (m) return parseFloat(m[1]) / parseFloat(m[2]);
  const n = parseFloat(s);
  return new RegExp('^' + NUM + '$').test(s) ? n : NaN;
}
/* 學測多選給分（全 app 唯一實作）：全對滿分、錯 1 個選項 3/5、錯 2 個 1/5、錯 3 個以上或空白（未作答）0 分。
   optionIndexes＝該題全部選項的索引宇集（系統模考 0-based、掃描卷 1-based），逐一比對「該勾沒勾／不該勾卻勾」。 */
function multiPartialPoints(points, chosenArr, correctArr, optionIndexes) {
  const chosen = new Set(chosenArr || []);
  if (!chosen.size) return 0; // 空白＝未作答：不給部分分（與跳過同分，堵住「亂送空白反而拿分」）
  const correct = new Set(correctArr || []);
  const errors = optionIndexes.filter((i) => chosen.has(i) !== correct.has(i)).length;
  return errors === 0 ? points : errors === 1 ? points * .6 : errors === 2 ? points * .2 : 0;
}
function checkFill(input, accepted) {
  const ni = norm(input);
  if (accepted.some((a) => norm(a) === ni)) return true;
  // 逗號分隔的多值答案（如兩根「-1,5」）：順序不拘，逐值比對。
  // 只有「所有」接受形式都無括號才啟用——座標題常提供 '(7,0)' 與 '7,0' 兩種別名，屬有序對，不可交換。
  const bare = (s) => !/[()]/.test(norm(s));
  if (ni.includes(',') && bare(input) && accepted.every((a) => bare(a))) {
    const toKey = (s) => norm(s).split(',').filter(Boolean)
      .map((t) => { const v = parseFrac(t); return isNaN(v) ? t : String(v); })
      .sort().join('|');
    const ki = toKey(input);
    if (accepted.some((a) => norm(a).includes(',') && bare(a) && toKey(a) === ki)) return true;
  }
  const vi = parseFrac(input);
  if (!isNaN(vi)) {
    return accepted.some((a) => {
      const va = parseFrac(a);
      return !isNaN(va) && Math.abs(va - vi) < 1e-9;
    });
  }
  return false;
}
function qTarget(q) { return (q.target || DIFF_TARGET[q.diff]) * 1000; }
function gradeOf(acc) {
  return GRADE_TABLE.find((g) => acc >= g.min).label;
}
/* 小樣本不能只報一個漂亮百分比。Wilson 區間讓 12 題模擬的「不確定」也看得見。 */
function wilsonBounds(ok, n, z) {
  if (!n) return [0, 1];
  z = z || 1.96;
  const p = ok / n, z2 = z * z, den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
/* 級分只由完整系統模擬校準。弱項刷題是刻意抽難點，不能拿它直接預測級分。 */
function mockCalibration() {
  const external = (S.extMocks || []).filter((m) =>
    m && m.total > 0 && Number.isFinite(Number(m.score)) &&
    extMockCalibrationEligible(m))
    .slice().sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')) || Number(a.ts || 0) - Number(b.ts || 0)).slice(-3)
    .map((m) => ({ d: m.d, ok: Number(m.score), n: Number(m.total), acc: Number(m.score) / Number(m.total), name: m.name }));
  const system = (S.mocks || []).filter((m) => m && m.n > 0 && Number.isFinite(Number(m.acc))).slice(-3);
  const source = external.length ? 'external' : 'system';
  const recent = external.length ? external : system;
  if (!recent.length) return { count: 0, recent: [], source: null, stable: false, passes: 0, staleDays: Infinity };
  const ok = recent.reduce((s, m) => s + Number(m.ok || Math.round(m.acc * m.n)), 0);
  const n = recent.reduce((s, m) => s + Number(m.n || 0), 0);
  const acc = n ? ok / n : 0;
  const range = source === 'external'
    ? [Math.min(...recent.map((m) => Number(m.acc))), Math.max(...recent.map((m) => Number(m.acc)))]
    : wilsonBounds(ok, n);
  const [low, high] = range;
  const last = recent[recent.length - 1];
  const staleDays = Math.max(0, Math.round((new Date(today() + 'T00:00:00Z') - new Date(last.d + 'T00:00:00Z')) / 86400000));
  const passes = recent.filter((m) => Number(m.acc) >= SCORE_GOAL.targetAcc).length;
  return { count: recent.length, recent, source, ok, n, acc, low, high, grade: gradeOf(acc), passes, stable: recent.length === 3 && passes === 3, staleDays };
}
function extMockCalibrationEligible(record) {
  if (!record || record.calibrationEligible === false) return false;
  let sourceId = String(record.sourceId || '');
  if (!sourceId && record.paperRunId) {
    const run = (S.paperRuns || []).find((item) => item && item.id === record.paperRunId);
    sourceId = String(run && run.sourceId || '');
  }
  const source = PAPER_SOURCES.find((item) => item.id === sourceId);
  if (source && (source.questions !== 20 || source.calibrationEligible === false)) return false;
  return record.questions == null || Number(record.questions) === 20;
}
function pendingCorrections() {
  return (S.corrections || []).filter((batch) => batch && Array.isArray(batch.entries) && batch.entries.some((x) => !x.done));
}
function dueCorrections() {
  return pendingCorrections().filter((batch) => String(batch.due || '') <= today());
}
function outlineUnits() {
  const byId = new Map(OUTLINE_DEFAULTS.map((x) => [x.id, { ...x }]));
  for (const x of extOutlineArr()) {
    if (!x || !byId.has(x.id)) continue;
    byId.set(x.id, { ...byId.get(x.id), ...x });
  }
  return OUTLINE_DEFAULTS.map((x) => byId.get(x.id));
}
function outlineLast(unitId) {
  return (S.outlineAttempts || []).filter((x) => x.unitId === unitId)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0] || null;
}
function outlineDueUnits() {
  return outlineUnits().filter((unit) => {
    if (!unit.reference) return false;
    const last = outlineLast(unit.id);
    return !last || String(last.due || '') <= today();
  });
}
function conceptLast(conceptId) {
  return (S.conceptAttempts || []).filter((x) => x.conceptId === conceptId)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0] || null;
}
function conceptDueCards() {
  return CONCEPT_CARDS.filter((card) => {
    const last = conceptLast(card.id);
    return !last || String(last.due || '') <= today();
  });
}
function visionDueEntries() {
  return (S.visionQueue || []).filter((x) => !x.done && x.stage === 'waiting' && String(x.due || '') <= today());
}
function severeWeakTopics() {
  const recent = (S.attempts || []).filter((a) => a.mode === 'mixed' || a.mode === 'mock').slice(-60);
  const by = {};
  for (const a of recent) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (by[q.topic] = by[q.topic] || { n: 0, ok: 0, tail: [] });
    t.n++; t.ok += a.ok ? 1 : 0; t.tail.push(!!a.ok); t.tail = t.tail.slice(-4);
  }
  return Object.keys(by).filter((k) => {
    const t = by[k];
    return (t.n >= 6 && t.ok / t.n <= 0.35) || (t.tail.length === 4 && t.tail.every((ok) => !ok));
  }).map((k) => ({ k, n: by[k].n, ok: by[k].ok, acc: by[k].ok / by[k].n }));
}
function nextBestAction() {
  const due = dueCorrections();
  const dueN = due.reduce((sum, batch) => sum + batch.entries.filter((x) => !x.done).length, 0);
  if (dueN) return {
    kind: 'correction', title: `先完成 ${dueN} 題隔日盲訂正`, why: '今天只看最終答案，重新找方向；先留下自己的嘗試，仍無收穫才解鎖詳解。', time: `約 ${Math.max(10, dueN * 5)} 分鐘`, onclick: "nav('correct')", button: '開始訂正',
  };
  const outlineDue = outlineDueUnits();
  if (outlineDue.length) return {
    kind: 'outline', title: `重測 ${outlineDue[0].title}`, why: `上次默寫已滿兩天。先從空白頁把子標題與內容重新叫回來，再對照大綱。`, time: '約 15 分鐘', onclick: `startOutlineRecall('${outlineDue[0].id}')`, button: '開始空白默寫',
  };
  const visionDue = visionDueEntries();
  if (visionDue.length) return {
    kind: 'vision', title: `再給 ${visionDue.length} 題一次機會`, why: '昨天想不到方向的題，今天再只看題目找一次切入點；仍沒有方向才看詳解。', time: `約 ${Math.max(5, visionDue.length * 4)} 分鐘`, onclick: `startVisionScan('${visionDue[0].id}')`, button: '第二天再想',
  };
  const cal = mockCalibration();
  if (!cal.count) return {
    kind: 'mock', title: '建立一回全真基準', why: '用正式的 20 題、100 分鐘完成一整回；今天只批分，明天才訂正。', time: '100 分鐘', onclick: "nav('mock')", button: '查看模考說明',
  };
  if (cal.staleDays >= 7) return {
    kind: 'mock', title: '更新本週校準', why: `距上次完整模擬已 ${cal.staleDays} 天；用完整一回確認混合情境下能否取回分數。`, time: '100 分鐘', onclick: "nav('mock')", button: '查看模考說明',
  };
  const severe = severeWeakTopics()[0];
  if (severe) {
    return { kind: 'topic', title: `「${TOPICS[severe.k]}」需要短期補洞`, why: `混合／模考近 ${severe.n} 題只答對 ${severe.ok} 題，已達到才例外分章介入的門檻。`, time: '約 20 分鐘', onclick: `startTopicIntervention('${severe.k}')`, button: '補洞 6 題' };
  }
  const concept = conceptDueCards()[0];
  if (concept) return { kind: 'concept', title: `用自己的話說明「${concept.title}」`, why: '不背字句；說清楚真正意思、限制與一個例子，AI 再檢查語意缺口。', time: '約 5 分鐘', onclick: `startConceptCheck('${concept.id}')`, button: '開始說明' };
  return { kind: 'vision', title: '用眼睛刷一整回', why: '依學測 20 題完整結構逐題找破題方向，不展開計算；卡住的題保留到明天再想。', time: '約 40 分鐘', onclick: 'startVisionScan()', button: '開始 20 題找方向' };
}
function nextActionCard() {
  const a = nextBestAction();
  return `<div class="card next-action"><div class="next-action-copy"><span class="eyebrow">現在只做這件事</span><h2>${escH(a.title)}</h2><p>${escH(a.why)}</p><span class="dim fs13">預估 ${escH(a.time)}</span></div>
    <button class="btn primary big" onclick="${a.onclick}">${escH(a.button)}</button></div>`;
}
function bankById(id) {
  if (BANK_MAP && BANK_MAP.has(id)) return BANK_MAP.get(id);
  return MOCK_MIXED_MAP.get(id) || BANK.find((q) => q.id === id);
}
/* 每題作答次數表：一次掃 attempts 建表，取代排序比較子裡的 attemptsOf 全表掃描（O(題×紀錄)→O(紀錄)） */
function attCountMap() {
  const m = new Map();
  for (const a of S.attempts) m.set(a.qid, (m.get(a.qid) || 0) + 1);
  return m;
}
function teachBlock(qid) {
  const t = S.teach && S.teach[qid];
  if (!t || !t.sol) return '';
  return `<div class="teach">
    <p><b>🧑‍🏫 老師這樣教：</b>${rtTxt(t.sol)}</p>
    ${t.tip ? `<p class="teach-tip">🔑 ${rtTxt(t.tip)}</p>` : ''}
    ${t.ba ? `<p class="dim">（黑板答案：${rtTxt(t.ba)}）</p>` : ''}
  </div>`;
}

/* ═══════════ 計時器 ═══════════ */
let ticker = null;
let lastTickerFn = null;
function startTicker(fn) { stopTicker(); lastTickerFn = fn; ticker = setInterval(fn, 250); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
/* 計時器可見性：預設隱藏（初期以「寫完」為主，時間照樣幕後記錄）。開關在數據頁。 */
function timerOn() { return S.hideTimer === false; }

/* ═══════════ 紀錄 ═══════════ */
/* AI 批改回傳 → 可持久化的建議物件（純文字截長，絕不存圖）。錯題本要能重看「人話建議」全靠這個。 */
function advFrom(v) {
  if (!v || (!v.firstError && !v.nextTime)) return null; // 只有 errKind 不足以覆蓋錯題本既有的 fe/nt 建議（答對重測時 AI 若亂填 errKind 會把上次卡點洗掉）
  const a = {};
  if (v.firstError) a.fe = String(v.firstError).slice(0, 160);
  if (v.nextTime) a.nt = String(v.nextTime).slice(0, 160);
  if (v.errKind && !/^null$/i.test(String(v.errKind).trim())) a.k = String(v.errKind).slice(0, 20); // 錯法機制分類：統整趨勢用
  a.d = today();
  return a;
}
function recordAttempt(q, ok, ms, err, mode, proc, ai, opts) {
  const rec = { qid: q.id, ok, ms, err: err || null, d: today(), mode, ts: Date.now() };
  if (ok && err === '用猜的') rec.confidence = 'guess'; // 猜中不是已掌握：留下可分析的顯性訊號
  if (proc) rec.p = proc;
  const adv = advFrom(ai);
  if (adv) rec.ai = adv;
  S.attempts.push(rec);
  if ((!ok || err === '超時' || err === '用猜的') && !(opts && opts.skipWrong)) {
    const w = S.wrong[q.id] || { fails: 0, wins: 0, itv: 0 };
    if (w.grad) { delete w.grad; } // 畢業生回鍋：前科保留、重新入本
    w.fails += ok ? 0 : 1;
    w.err = err || w.err || '概念不熟';
    w.itv = 1;
    w.due = addDays(today(), 1);
    if (adv) w.adv = adv;
    w.mt = Date.now(); // 修改時間戳：mergeState 靠它分辨「畢業後回鍋（較新）」與「落後裝置的畢業殘影」
    S.wrong[q.id] = w;
  } else if (adv && S.wrong[q.id] && !S.wrong[q.id].grad) {
    S.wrong[q.id].adv = adv; // 複習/重做時的最新建議也更新到錯題卡
    S.wrong[q.id].mt = Date.now();
  }
  save();
  return rec; // 呼叫端（qFinish）要能把遲到的 AI 建議精準補進「本場這筆」
}



/* ═══════════ 📈 每日投入統計（鼓勵機制） ═══════════ */
function dayAgg() {
  const days = {};
  const add = (d, n, ok, ms, pts) => {
    if (!d) return;
    const x = (days[d] = days[d] || { n: 0, ok: 0, ms: 0, pts: 0 });
    x.n += n; x.ok += ok; x.ms += ms; x.pts += pts || 0; // 防呆：pts 沒傳也不要污染成 NaN
  };
  const W = { 1: 1, 2: 2, 3: 4 }; // 難度加權：sin30 一秒 vs 難題十分鐘，只算題數不合理
  for (const a of S.attempts) {
    const q = bankById(a.qid);
    add(a.d, 1, a.ok ? 1 : 0, a.ms || 0, W[(q && q.diff) || 2]);
  }
  for (const k of Object.keys(S.drills)) {
    for (const h of S.drills[k]) { const n = h.n || 12; add(h.d, n, Math.round(n * (h.acc || 0) / 100), (h.med || 0) * n, 3); } // 速訓一輪=3點；n＝該輪實際題數（舊資料無 n 當 12，同 dayCounts）
  }
  if (S.phone && S.phone.days) {
    for (const d of Object.keys(S.phone.days)) { const p = S.phone.days[d]; add(d, p.n || 0, p.ok || 0, p.ms || 0, p.n || 0); } // 手機專區每題算 1 點；全欄位 NaN-proof（防外部污染的 localStorage/雲端列）
  }
  return days;
}
/* ═══════════ 📊 今日計數表（右上角常駐；速度特訓＋易/中/難，含類題） ═══════════
   標準：速訓 20、易/中/難各 15，不限章節。速訓＝今日各速訓輪題數加總；易中難＝今日
   主題刷/錯題複習(S.attempts)＋類題(S.sidePractice) 按題目難度分桶（速訓題非 BANK→天然不入難度桶）。 */
const DAY_STD = { drill: 20, e: 15, m: 15, h: 15 };
function dayCounts() {
  const t = today();
  const c = { drill: 0, e: 0, m: 0, h: 0 };
  for (const k in S.drills) for (const r of (S.drills[k] || [])) if (r.d === t) c.drill += (r.n || 12); // 速訓：今日各輪題數（舊資料無 n 當 12）
  const bump = (qid) => { const q = bankById(qid); if (!q) return; if (q.diff === 1) c.e++; else if (q.diff === 2) c.m++; else if (q.diff === 3) c.h++; };
  for (const a of S.attempts) if (a.d === t) bump(a.qid);            // 主題刷／錯題複習（drill 不入 attempts，不重複計）
  for (const s of (S.sidePractice || [])) if (s.d === t) bump(s.qid); // 做錯後練的類題也算進去
  return c;
}
function renderDayCounter() {
  const el = document.getElementById('day-counter');
  if (!el) return;
  const c = dayCounts();
  const rows = [['速訓', c.drill, DAY_STD.drill], ['易', c.e, DAY_STD.e], ['中', c.m, DAY_STD.m], ['難', c.h, DAY_STD.h]];
  // 首次使用預設收合，避免桌機右上角與手機底部同時出現過多浮動資訊；
  // 使用者主動展開後才記住展開狀態（'0'）。
  let collapsedPref = null; // Safari 無痕等儲存被拒的環境不能讓 boot 內的計數表把整個啟動炸掉
  try { collapsedPref = localStorage.getItem('mathA13_dayctr_collapsed'); } catch (_) {}
  if (collapsedPref !== '0') {
    const done = rows.filter((r) => r[1] >= r[2]).length;
    el.className = 'dayctr collapsed';
    el.innerHTML = '<button class="dc-toggle" onclick="dayCounterToggle()" title="展開今日計數表">📊 ' + done + '/4</button>';
    return;
  }
  el.className = 'dayctr';
  el.innerHTML = '<div class="dc-head"><span>📊 今日</span><button class="dc-toggle" onclick="dayCounterToggle()" title="收起">▸</button></div>'
    + rows.map((r) => '<div class="dc-row' + (r[1] >= r[2] ? ' done' : '') + '"><span class="dc-lab">' + r[0] + '</span><span class="dc-num">' + r[1] + '<i>/' + r[2] + '</i></span></div>').join('');
}
function dayCounterToggle() {
  try {
    const cur = localStorage.getItem('mathA13_dayctr_collapsed') !== '0';
    localStorage.setItem('mathA13_dayctr_collapsed', cur ? '0' : '1');
  } catch (_) {}
  renderDayCounter();
}
const DAY_GOAL = 30; // 每日題數目標（速訓12＋錯題＋刷題8＋手機零碎 ≈ 30）
/* 跨過每日目標線的那一刻要有事件（一天只觸發一次；goalHit 放 daily 內天然搭雲端合併與回滾） */
function goalCrossBanner() {
  const t = today();
  const d = dayAgg()[t];
  const tn = d ? Math.round(d.pts) : 0;
  if (tn < DAY_GOAL) return '';
  S.daily[t] = S.daily[t] || {};
  if (S.daily[t].goalHit) return '';
  S.daily[t].goalHit = true;
  save();
  return `<div class="card good">📈 <b>今日 ${DAY_GOAL} 點達標</b>——目標量完成，之後都是加碼。</div>`;
}
/* 📚 單元重點 modal：匯入的參考書重點 + 該單元必背卡 + 老師方法庫入口 */
function typesetIn(el) {
  if (el && window.renderMathInElement) {
    try {
      renderMathInElement(el, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }], throwOnError: false });
    } catch (e) {}
  }
}

/* ═══════════ 導覽 ═══════════ */
const VIEWS = {
  home:    { label: '今日', icon: 'clipboard', fn: renderHome },
  outline: { label: '大綱默寫', icon: 'pencil', fn: renderOutlineRecall },
  mock:    { label: '模考與破題', icon: 'target', fn: renderMockIntro },
  correct: { label: '隔日訂正', icon: 'book', fn: renderCorrections },
  concept: { label: '觀念理解', icon: 'brain', fn: renderConcepts },
};
// 主導覽只保留老師新版流程；stats 僅供同步燈開啟新版進度與帳號設定。
const LEGACY_VIEWS = {
  stats: { label: '進度與設定', icon: 'chart', fn: renderStats },
};
let sessionActive = false;
let sessionMode = null; // 'prac' | 'mock' | 'judging' | 'correction' | 'outline' | 'vision' | 'concept' | 'paper-source' | 'paper-grade' | 'paper-review'
let sessSnap = null;    // 進場快照，用於「不保留紀錄」離開時復原
function snapSession() { sessSnap = { att: S.attempts.length, wrong: JSON.stringify(S.wrong), drills: JSON.stringify(S.drills || {}), daily: JSON.stringify(S.daily || {}) }; }
function rollbackSession() {
  if (!sessSnap) return;
  S.attempts.length = Math.min(S.attempts.length, sessSnap.att);
  S.wrong = JSON.parse(sessSnap.wrong);
  if (sessSnap.drills) S.drills = JSON.parse(sessSnap.drills); // 「全部作廢」也要還原本輪中途賺到的速訓輪與每日點數（如番茄鐘裡）
  if (sessSnap.daily) S.daily = JSON.parse(sessSnap.daily);
  save();
}
function endSession() {
  sessionActive = false;
  sessionMode = null;
  stopTicker();
  lastTickerFn = null; // session 終結＝碼錶 fn 作廢；否則之後按「繼續」會把殭屍碼錶叫回來對 null qsess 拋錯
  if (ink) inkStop();
  qsess = null; // 讓遲到的 AI 批改回呼認得出「這一題已經結束了」
  outlineSess = null;
  conceptSess = null;
  vision = null;
  paperReview = null;
  paperSourceRelease();
  sessionChrome(false);
  modalClose();
}
/* 中途退出：讓飼主自己選「已作答的要不要留紀錄」，不預設丟掉 */
function exitFlow(view) {
  // 誤觸離開後回到出發的入口頁，不要一律丟回首頁（想馬上重來一輪不用重新導航）
  const backTo = { prac: 'home', correction: 'correct', outline: 'outline', concept: 'concept', vision: 'mock', 'paper-source': 'mock', 'paper-grade': 'mock', 'paper-review': 'correct' };
  const goto = view || backTo[sessionMode] || 'home';
  if (!sessionActive) { nav(goto); return; }
  // 開著確認框的時間不算作答時間：按「繼續」時把計時起點往後平移
  const pausedAt = Date.now();
  // 開著確認框時凍結計時：碼錶 ticker 停（否則時間警示會在框後面亂閃）
  stopTicker();
  const resume = () => {
    const d = Date.now() - pausedAt;
    if (sessionMode === 'mock' && mock) { mock.t0 += d; mock.tEnd += d; }
    else if (qsess) qsess.t0 += d;
    if (ink) ink.t0 += d; // 書寫時間軸一起平移：否則暫停後 fi/停頓/卡點秒數會跟耗時對不上
    if (lastTickerFn) startTicker(lastTickerFn); // 恢復碼錶顯示
  };
  if (sessionMode === 'paper-source' && paperSourceSession) {
    paperSourcePause();
    const { source, run } = paperSourceSession;
    const paperResume = () => {
      run.status = 'active'; run.resumeAt = Date.now(); run.mt = Date.now(); save();
      sessionMode = 'paper-source'; renderPaperSource();
    };
    modal(`<h2>要暫停這回原版模考嗎？</h2><p>${escH(source.title)}還有 <b>${fmtClock(run.remainingMs)}</b>。可保留計時進度，下次從同一回繼續；也可以捨棄這次未交卷的紀錄。</p>`, [
      ['繼續作答', paperResume, 'primary'],
      ['保留進度，離開', () => { endSession(); nav(goto); }],
      ['捨棄本回', () => { paperSourceDiscard(run.id); endSession(); nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'paper-grade' && paperSourceSession) {
    const { source, run } = paperSourceSession;
    modal(`<h2>AI 還在看這一整回</h2><p>${escH(source.title)}正在依題本上的筆跡批改。現在離開不會刪除筆跡；下次開啟會重新檢查尚未完成的批改。</p>`, [
      ['留在這裡等批改', null, 'primary'],
      ['先離開，稍後再試', () => { run.status = 'grading'; run.mt = Date.now(); save(); endSession(); nav(goto); }],
      ['捨棄本回', () => { paperSourceDiscard(run.id); endSession(); nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'paper-review' && paperReview && paperSourceSession) {
    modal('<h2>要暫停隔日訂正嗎？</h2><p>卷面上的訂正筆跡會先保存到平板，再背景同步雲端；下次會回到同一題與同一頁。</p>', [
      ['繼續訂正', resume, 'primary'],
      ['保存並離開', () => paperReviewBack()],
    ]);
    return;
  }
  if (sessionMode === 'judging') {
    modal('<h2>批改還沒完成</h2><p>現在離開會丟掉這一場模擬的結算與作答紀錄（已上傳的筆跡仍保存）。</p>', [
      ['回去批改', null, 'primary'],
      ['放棄本場結算，離開', () => { endSession(); nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'mock') {
    const nAns = Object.keys(mock.answers).length;
    modal(`<h2>要中途離開模擬嗎？</h2><p>已作答 <b>${nAns}</b> 題。可以把已作答的題結算並留下紀錄（不列入模擬成績走勢），或整場不保留。</p>`, [
      ['繼續作答', resume, 'primary'],
      [`保留已作答的 ${nAns} 題，結算離開`, () => { if (Object.keys(mock.answers).length) { mockGrade('中途結束（保留已作答）', true); } else { endSession(); nav(goto); } }],
      ['不保留，直接離開', () => { endSession(); nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'correction') {
    modal('<h2>要暫停隔日訂正嗎？</h2><p>已完成與已留下的嘗試都會保留；目前這張尚未送出的手寫不會算一次努力紀錄。</p>', [
      ['繼續訂正', resume, 'primary'],
      ['保留進度，離開', () => { endSession(); correction = null; nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'outline' || sessionMode === 'concept') {
    const label = sessionMode === 'outline' ? '這張空白默寫' : '這張觀念自述';
    modal(`<h2>要離開嗎？</h2><p>${label}尚未送出；離開會捨棄目前未送出的內容。</p>`, [
      ['繼續', resume, 'primary'],
      ['捨棄未送出內容，離開', () => { endSession(); nav(goto); }],
    ]);
    return;
  }
  if (sessionMode === 'vision') {
    if (vision && vision.paperRun) {
      const doneN = vision.paperEntries.filter((x) => x.paperSeen).length;
      modal(`<h2>要暫停這一整回嗎？</h2><p>本回已完成 <b>${doneN}/20</b> 題；進度會保留，下次從目前這題繼續。尚未送出的文字不會算一次紀錄。</p>`, [
        ['繼續本回', resume, 'primary'],
        ['保留進度，離開', () => { save(); endSession(); vision = null; nav(goto); }],
      ]);
    } else {
      modal('<h2>要暫停這題嗎？</h2><p>尚未完成的方向不算一次訓練；已送出的第一天紀錄仍會保留。</p>', [
        ['繼續', resume, 'primary'],
        ['暫停並離開', () => {
          if (vision && vision.entry && !(vision.entry.attempts || []).length) S.visionQueue = (S.visionQueue || []).filter((x) => x.id !== vision.entry.id);
          else if (vision && vision.entry && !vision.entry.done) { vision.entry.stage = 'waiting'; vision.entry.due = today(); vision.entry.mt = Date.now(); }
          save(); endSession(); vision = null; nav(goto);
        }],
      ]);
    }
    return;
  }
  if (sessionMode === 'prac') { // correction 在上面已 return，不會走到這裡
    const nDone = S.attempts.length - (sessSnap ? sessSnap.att : S.attempts.length);
    modal(`<h2>要中途離開嗎？</h2><p>這一輪已完成 <b>${Math.max(0, nDone)}</b> 題（已記錄），進行中的這題不會保留。</p>`, [
      ['繼續作答', resume, 'primary'],
      ['保留已作答紀錄，離開', () => { endSession(); nav(goto); }],
      ['不保留（這輪全部作廢），離開', () => { rollbackSession(); endSession(); nav(goto); }],
    ]);
    return;
  }
  modal('<h2>要中途離開嗎？</h2><p>這一輪還沒結束，離開不會保留本輪成績。</p>', [
    ['繼續', resume, 'primary'],
    ['離開', () => { endSession(); nav(goto); }],
  ]);
}
/* ═══ 跳出 App 保護：平板返回鍵/手勢、關分頁——一律先確認，不讓誤觸吃掉作答 ═══ */
let leavingApp = false;
window.addEventListener('beforeunload', (e) => {
  if (sessionActive && !leavingApp) { e.preventDefault(); e.returnValue = ''; }
});
// 真正離開／重載時才落盤；beforeunload 可能被使用者取消，不能在那裡把仍在畫面的倒數永久凍住。
window.addEventListener('pagehide', () => {
  if (sessionMode === 'paper-source' && paperSourceSession) paperSourcePause();
  else if (sessionMode === 'paper-grade' && paperSourceSession) {
    paperSourceSession.run.status = 'grading';
    paperSourceSession.run.resumeAt = null;
    paperSourceSession.run.mt = Date.now();
    save();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || sessionMode !== 'paper-source' || !paperSourceSession) return;
  paperInkCommitCurrent();
  paperInkPersist(true);
  paperRecoveryWrite(true);
});
document.addEventListener('freeze', () => {
  if (sessionMode !== 'paper-source' || !paperSourceSession) return;
  paperInkCommitCurrent();
  paperInkPersist(true);
  paperRecoveryWrite(true);
});
try { history.pushState({ guard: 1 }, ''); } catch (e) {}
window.addEventListener('popstate', () => {
  if (leavingApp) return;
  try { history.pushState({ guard: 1 }, ''); } catch (e) {} // 先把守門狀態補回去
  if (sessionActive) { exitFlow(); return; } // 作答中：走原本的「要保留紀錄嗎」流程
  modal('<h2>要離開數A特訓嗎？</h2><p>進度都已自動存雲端，隨時可以回來。</p>', [
    ['留下', null, 'primary'],
    ['離開 App', () => { leavingApp = true; history.go(-2); }],
  ]);
});
function nav(view) {
  if (sessionActive) { exitFlow(view); return; }
  sessionMode = null;
  stopTicker();
  if (ink) inkStop();
  sessionChrome(false);
  document.body.dataset.view = view; // 讓各主頁可套用平板專屬資訊密度；作答流程仍由 session-on 接管全螢幕
  document.querySelectorAll('nav button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.scrollIntoView({ inline: 'center', block: 'nearest' }); // 手機 8 分頁橫捲時，切到右側分頁把當前分頁捲進可視範圍，別讓高亮落在畫面外
  });
  const target = VIEWS[view] || LEGACY_VIEWS[view];
  if (!target) return nav('home');
  target.fn();
  updateBadge();
}
function updateBadge() {
  const n = dueCorrections().reduce((sum, batch) => sum + batch.entries.filter((x) => !x.done).length, 0);
  const b = $('nav button[data-view="correct"]');
  if (b) b.innerHTML = `${uiIcon('book')}<span>${VIEWS.correct.label}</span>` + (n ? ` <span class="badge">${n}</span>` : '');
}

/* ═══════════ 首頁：老師新版流程 ═══════════ */
function renderHome() {
  const days = daysUntil(EXAM_DATE);
  const outlineReady = outlineUnits().filter((x) => x.reference).length;
  const outlineDue = outlineDueUnits().length;
  const visionDue = visionDueEntries().length;
  const visionPaper = visionActivePaperEntries();
  const visionPaperDone = visionPaper ? visionPaper.filter((x) => x.paperSeen).length : 0;
  const conceptDue = conceptDueCards().length;
  app().innerHTML = `
  <div class="hero">
    <h1>數A特訓 <span class="dim" style="font-size:12px">${APP_VER}</span></h1>
    <p>距離 116 學測還有 <b class="accent">${days} 天</b>｜主練破題方向，不用速度製造假進度</p>
  </div>
  ${nextActionCard()}
  <div class="task-strip">
    <button onclick="nav('outline')"><span>大綱默寫</span><b>${outlineReady ? `${outlineDue} 份到期` : '等待 11 份大綱'}</b></button>
    <button onclick="nav('mock')"><span>模考與破題</span><b>${visionDue ? `${visionDue} 題第二天` : visionPaper ? `眼睛刷題 ${visionPaperDone}/20` : '眼睛刷題 20 題'}</b></button>
    <button onclick="nav('concept')"><span>觀念理解</span><b>${conceptDue} 張待說明</b></button>
    <button onclick="nav('stats')"><span>進度與設定</span><b>同步、AI 與備份</b></button>
  </div>
  <div class="card training-rules"><h2>現在的訓練規則</h2>
    <ol>
      <li>十一單元從空白默寫子標題與內容；對答案後隔兩天再測。</li>
      <li>平時只做混合題。只有數據確認某章嚴重斷裂，才短期分章補洞。</li>
      <li>全真模考固定 20 題、100 分鐘；當天只批分，隔天才訂正。</li>
      <li>訂正每題分三級：直接會寫、只看答案能算出、必須看詳解。</li>
      <li>眼睛刷題只找破題方向、不計算；沒方向的題隔天再想一次，仍沒有才看詳解。</li>
      <li>基本定義用自己的話說清楚意思、限制與例子，不背逐字句子。</li>
    </ol>
  </div>`;
}

/* ═══════════ 任務一：十一單元空白默寫 ═══════════ */
let outlineSess = null;
function renderOutlineRecall() {
  const units = outlineUnits();
  const ready = units.filter((x) => x.reference).length;
  const tiles = units.map((unit, i) => {
    const last = outlineLast(unit.id);
    const due = unit.reference && (!last || String(last.due || '') <= today());
    const state = !unit.reference ? '等待大綱' : !last ? '尚未測' : due ? '今天重測' : `下次 ${last.due}`;
    const score = last && last.coverage != null && Number.isFinite(Number(last.coverage)) ? `${Number(last.coverage)}%` : (last ? '尚未批改' : '空白頁');
    return `<button class="recall-tile${due ? ' due' : ''}" onclick="startOutlineRecall('${unit.id}')">
      <span class="recall-no">${String(i + 1).padStart(2, '0')}</span><strong>${escH(unit.title)}</strong>
      <span>${escH(state)}</span><b>${score}</b></button>`;
  }).join('');
  app().innerHTML = `<div class="hero compact"><h1>十一單元大綱默寫</h1>
    <p>看章節名稱，把想得到的子標題、定義、公式與彼此關係全部寫出來。寫完才看正確大綱；每次完成後隔兩天重測。</p></div>
    ${ready < 11 ? `<div class="card notice"><b>目前已建立 ${ready} / 11 份私人對照大綱。</b><p>十一張空白頁已可先寫；你把老師給的十一份大綱拍給我後，我會辨識標題與內容、人工複核，再匯入私人內容層。未匯入前 AI 不會假裝知道正確答案。</p></div>` : ''}
    <div class="recall-grid">${tiles}</div>
    <details class="card"><summary>這個任務怎麼做</summary><ol><li>只看最上方單元名稱，先努力默寫。</li><li>送出後 AI 依語意對照大綱，不要求逐字相同。</li><li>當場看完整正確大綱，理解漏掉的結構。</li><li>系統固定排在兩天後重測，不因一次高分取消。</li></ol></details>`;
}
function startOutlineRecall(unitId) {
  const unit = outlineUnits().find((x) => x.id === unitId);
  if (!unit) return;
  outlineSess = { unit, t0: Date.now(), inkId: `outline:${unit.id}:${Date.now()}` };
  sessionActive = true; sessionMode = 'outline';
  renderOutlineSheet();
}
function renderOutlineSheet() {
  const unit = outlineSess.unit;
  app().innerHTML = `<div class="session-head"><span>大綱默寫｜${escH(unit.title)}</span>
    <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></div>
    <div class="card qcard booklet sheet recall-sheet">
      <div class="recall-paper-head"><span>單元名稱</span><h1>${escH(unit.title)}</h1><p>不要先看答案。默寫子標題、重要內容、公式與它們的關係。</p></div>
      <div class="sheet-tools"><b>整張空白處都能寫</b>${inkToolsHTML()}</div>
      <div class="write-pad"></div>
      <div class="ansarea recall-submit">
        <details><summary>補一段可搜尋的文字摘要（選用）</summary><textarea id="outline-typed" rows="3" placeholder="例如：我記得這單元先分成……"></textarea></details>
        <button class="btn primary big" id="outline-submit" onclick="finishOutlineRecall()">寫完，對照大綱</button>
        <p id="outline-msg" class="dim"></p>
      </div>
      <canvas id="ink-cv" class="qink"></canvas>
    </div>`;
  sessionChrome(true); scrollQuestionTop();
  inkStart(outlineSess.inkId, outlineSess.t0);
}
async function outlineGradeCall(unit, calcB64, typed) {
  const content = [];
  if (calcB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: calcB64 } });
  content.push({ type: 'text', text: `你是學測數A複習教練。請比較學生從空白默寫的內容與老師的大綱。判斷概念語意，不要求逐字相同，也不要因字醜扣分；看不清的地方不要猜。
單元：${unit.title}
老師大綱：\n${unit.reference}
學生另附文字摘要：${typed || '無'}
請回報實際覆蓋到的重點、漏掉的重點、明顯不精確之處，以及下一次只需優先記住的一個結構。coverage 是老師大綱核心點的語意覆蓋百分比。` });
  return aiJSON(content, 'outline');
}
async function finishOutlineRecall() {
  if (!outlineSess) return;
  const sess = outlineSess, typed = (($('#outline-typed') || {}).value || '').trim();
  const img = inkCaptureFull(sess.inkId);
  const proc = inkStop();
  if (!(proc && proc.n) && typed.length < 10) {
    alert('這張還是空白的。先努力寫出你記得的子標題或內容，再對答案。');
    inkStart(sess.inkId, sess.t0, sess.t0);
    return;
  }
  syncInk(sess.inkId, sess.t0, Object.assign({ mode: 'outline', unitId: sess.unit.id }, proc || {}));
  const btn = $('#outline-submit'), msg = $('#outline-msg');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = sess.unit.reference ? (aiEnabled() ? 'AI 正在依大綱逐點比對…' : '未登入，這次先保存並顯示正確大綱。') : '這份對照大綱尚未匯入，先保存這次默寫。';
  let grade = null, error = '';
  if (sess.unit.reference && aiEnabled()) {
    try { grade = await outlineGradeCall(sess.unit, img, typed); }
    catch (e) { error = (e && e.message) || String(e); }
  }
  if (outlineSess !== sess) return;
  const attempt = {
    id: `outline-attempt-${Date.now()}`, unitId: sess.unit.id, title: sess.unit.title,
    d: today(), ts: Date.now(), due: sess.unit.reference ? addDays(today(), 2) : null,
    coverage: grade && Number.isFinite(Number(grade.coverage)) ? Number(grade.coverage) : null,
    grade, typed: typed.slice(0, 1000), strokes: proc ? proc.n || 0 : 0, aiError: error || null,
  };
  S.outlineAttempts = S.outlineAttempts || []; S.outlineAttempts.push(attempt); save();
  sessionActive = false; sessionMode = null; sessionChrome(false); outlineSess = null;
  renderOutlineResult(sess.unit, attempt);
}
function outlineList(items, empty) {
  return Array.isArray(items) && items.length ? `<ul>${items.map((x) => `<li>${escH(x)}</li>`).join('')}</ul>` : `<p class="dim">${empty}</p>`;
}
function renderOutlineResult(unit, attempt) {
  const g = attempt.grade;
  app().innerHTML = `<h1>${escH(unit.title)}｜本次對照</h1>
    ${!unit.reference ? `<div class="card notice"><h2>這次已保存，但還不能可靠判對</h2><p>這份老師大綱尚未匯入。等你提供照片後，這一頁會有完整正確答案與 AI 語意比對。</p></div>` : ''}
    ${unit.reference ? `<div class="result-score"><span>大綱語意覆蓋</span><b>${g ? `${g.coverage}%` : '未取得 AI 判讀'}</b><small>不要求逐字相同；固定兩天後再測</small></div>` : ''}
    ${g ? `<div class="feedback-grid">
      <section class="card"><h2>已寫到</h2>${outlineList(g.covered, '尚未辨識到明確覆蓋點')}</section>
      <section class="card"><h2>這次漏掉</h2>${outlineList(g.missing, '沒有明顯漏項')}</section>
      <section class="card"><h2>需要修正</h2>${outlineList(g.inaccurate, '沒有明顯錯誤')}</section>
      <section class="card"><h2>兩天後先想這個</h2><p>${escH(g.nextFocus || '先想整體架構，再補細節。')}</p></section>
    </div>` : attempt.aiError ? `<div class="card warn"><p>AI 比對暫時失敗：${escH(attempt.aiError)}。默寫與重測日期仍已保存。</p></div>` : ''}
    ${unit.reference ? `<details class="card answer-outline" open><summary>老師的完整正確大綱</summary><div>${escH(unit.reference)}</div></details>
      <div class="card good"><b>下次重測：${attempt.due}</b><p>到期時仍從空白頁開始，不先看這份答案。</p></div>` : ''}
    <div class="actr"><button class="btn" onclick="nav('outline')">回十一單元</button><button class="btn primary" onclick="nav('home')">回今日</button></div>`;
}

/* ═══════════ 任務三：重要定義用自己的話說 ═══════════ */
let conceptSess = null;
function renderConcepts() {
  const cards = CONCEPT_CARDS.map((card) => {
    const last = conceptLast(card.id), due = !last || String(last.due || '') <= today();
    const status = !last ? '尚未說明' : due ? '今天複述' : `下次 ${last.due}`;
    const understood = last && last.understood;
    return `<button class="concept-tile${due ? ' due' : ''}" onclick="startConceptCheck('${card.id}')"><span>${escH(TOPICS[card.unit] || '')}</span><strong>${escH(card.title)}</strong><small>${status}</small>${last ? `<b>${understood ? '意思完整' : '仍有缺口'}</b>` : ''}</button>`;
  }).join('');
  app().innerHTML = `<div class="hero compact"><h1>重要觀念的真正意思</h1><p>不背課本字句。請用自己的話說明「它是什麼、限制在哪裡、能排除哪個常見誤解」，最好再給一個例子或反例。</p></div>
    <div class="concept-grid">${cards}</div>
    <div class="card"><h2>判定標準</h2><p>AI 只檢查語意是否準確完整，不會因為你沒照標準定義逐字背而扣分。理解仍有缺口的卡兩天後再說；已說清楚的卡七天後再確認。</p></div>`;
}
function startConceptCheck(conceptId) {
  const card = CONCEPT_CARDS.find((x) => x.id === conceptId); if (!card) return;
  conceptSess = { card, t0: Date.now() };
  sessionActive = true; sessionMode = 'concept';
  app().innerHTML = `<div class="session-head"><span>觀念理解｜${escH(card.title)}</span><button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></div>
    <div class="card concept-prompt"><span class="eyebrow">${escH(TOPICS[card.unit] || '')}</span><h1>${escH(card.title)}</h1><p>${escH(card.prompt)}</p>
      <label>用自己的話說<textarea id="concept-answer" rows="8" autofocus placeholder="我認為它真正的意思是……；例如……；它和……不同，因為……"></textarea></label>
      <p id="concept-msg" class="dim"></p><div class="actr"><button class="btn primary big" id="concept-submit" onclick="finishConceptCheck()">送出語意檢查</button></div></div>`;
  sessionChrome(true); scrollQuestionTop();
}
async function conceptGradeCall(card, answer) {
  return aiJSON([{ type: 'text', text: `你是嚴謹的學測數A概念教練。學生必須真正理解定義，但不必逐字背誦。請比較他的自述與參考語意，判斷是否能用自己的話準確說明；不要因措辭不同扣分。
概念：${card.title}
提問：${card.prompt}
參考語意：${card.reference}
學生自述：${answer}
understood 只有在核心意思與限制都沒有實質誤解時才為 true；clearerVersion 用學生聽得懂的口吻補成更完整版本；nextPrompt 給下一次可自問的一個問題。` }], 'concept');
}
async function finishConceptCheck() {
  if (!conceptSess) return;
  const sess = conceptSess, answer = (($('#concept-answer') || {}).value || '').trim();
  if (answer.length < 18) { alert('再多說一點：至少要讓人看得出「它是什麼」以及一個限制、例子或反例。'); return; }
  const btn = $('#concept-submit'), msg = $('#concept-msg'); if (btn) btn.disabled = true;
  if (msg) msg.textContent = aiEnabled() ? 'AI 正在檢查語意，不比對逐字句子…' : '未登入，這次先保存並顯示參考語意。';
  let grade = null, error = '';
  if (aiEnabled()) { try { grade = await conceptGradeCall(sess.card, answer); } catch (e) { error = (e && e.message) || String(e); } }
  if (conceptSess !== sess) return;
  const understood = !!(grade && grade.understood);
  const attempt = { id: `concept-attempt-${Date.now()}`, conceptId: sess.card.id, d: today(), ts: Date.now(), answer: answer.slice(0, 1400),
    understood, grade, due: addDays(today(), understood ? 7 : 2), aiError: error || null };
  S.conceptAttempts = S.conceptAttempts || []; S.conceptAttempts.push(attempt); save();
  sessionActive = false; sessionMode = null; sessionChrome(false); conceptSess = null;
  renderConceptResult(sess.card, attempt);
}
function renderConceptResult(card, attempt) {
  const g = attempt.grade;
  app().innerHTML = `<h1>${escH(card.title)}｜語意檢查</h1>
    <div class="result-score"><span>目前判定</span><b>${g ? (g.understood ? '已說清楚' : '仍有缺口') : '已保存'}</b><small>下次複述：${attempt.due}</small></div>
    ${g ? `<div class="feedback-grid"><section class="card"><h2>你已理解</h2>${outlineList(g.accurate, '尚未辨識到完整重點')}</section>
      <section class="card"><h2>還要補上</h2>${outlineList(g.missing, '沒有明顯缺漏')}</section>
      <section class="card"><h2>需要修正的誤解</h2><p>${g.misconception ? escH(g.misconception) : '沒有明顯誤解'}</p></section>
      <section class="card"><h2>下一次自問</h2><p>${escH(g.nextPrompt || '')}</p></section></div>
      <div class="card answer-outline"><h2>把你的說法補完整</h2><p>${escH(g.clearerVersion || card.reference)}</p></div>` : `<div class="card answer-outline"><h2>參考語意</h2><p>${escH(card.reference)}</p>${attempt.aiError ? `<p class="warnc">AI 檢查暫時失敗：${escH(attempt.aiError)}</p>` : ''}</div>`}
    <div class="actr"><button class="btn" onclick="nav('concept')">回觀念卡</button><button class="btn primary" onclick="nav('home')">回今日</button></div>`;
}


/* ═══ KaTeX 數學排版 helper（全部產生 \(…\) 島，交給 KaTeX 排成二維正式數學） ═══ */
function T(body) { return '\\(' + body + '\\)'; }
/* 純值字串（√k、a/b、數字、座標）→ LaTeX 內文（無界定符） */
function texBody(s) {
  s = String(s).trim();
  s = s.replace(/√\(([^()]*)\)/g, '\\sqrt{$1}').replace(/√(\d+)/g, '\\sqrt{$1}');
  s = s.replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/≠/g, '\\ne ').replace(/×/g, '\\times ').replace(/·/g, '\\cdot ').replace(/±/g, '\\pm ');
  const m = s.match(/^(-?[^\/,]+)\/([^\/,]+)$/); // 整串就是一個分數（無逗號）
  if (m) return '\\frac{' + m[1] + '}{' + m[2] + '}';
  return s;
}
// 島內容一律過 escIsland：fill 題 ans 可能來自匯入題包（不可信），裸 < 進 innerHTML＝儲存型 XSS
function texVal(s) { return T(escIsland(texBody(s))); }
function fracH(n, d) { return T('\\frac{' + texBody(String(n)) + '}{' + texBody(String(d)) + '}'); }
/* 選項/正解字串 → LaTeX 島（給程式產生的選項與答案；DB 內容已是 LaTeX，不要再過這裡） */
function mDispOpt(s) { return typeof s === 'string' ? texVal(s) : s; }


/* ═══════════ 主題刷題 ═══════════ */
function attemptsOf(qid) { return S.attempts.filter((a) => a.qid === qid); }
/* 一輪隊列裡同一題組的小題只取一題（共用題幹連著出會像「一直重複」）；不夠再補回 */
// 「去數字後同骨架」＝只改數字的近重複題（如兩題排列組合只換了 8→7）：同一輪最多出一題，其餘留待補位。
function qSkeleton(q) { return String(q.q).replace(/<[^>]+>/g, '').replace(/\d+/g, '#').replace(/\s+/g, '').toLowerCase(); }
function dedupeStems(list, cnt) {
  const seen = new Set(), skel = new Set(), out = [];
  for (const q of list) {
    const isGroup = String(q.q).includes('題為題組');
    const k = q.grp || (isGroup ? (q.src || '') + '|' + String(q.q).replace(/<[^>]+>/g, '').slice(0, 24) : q.id); // schema v2 的題組 id 優先，舊字串嗅探當 fallback
    const sk = qSkeleton(q);
    if (seen.has(k) || (sk.length >= 12 && skel.has(sk))) continue; // 題組/同 id 去重 ＋ 去數字後同骨架（近重複）去重
    seen.add(k); skel.add(sk);
    out.push(q);
    if (out.length >= cnt) return out;
  }
  for (const q of list) { // 題庫變體太少、湊不滿一輪時才放寬近重複補位
    if (out.includes(q)) continue;
    out.push(q);
    if (out.length >= cnt) break;
  }
  return out;
}
let prac = null;
function pracNext() {
  if (prac.i >= prac.queue.length) return pracDone();
  renderQuestion(prac.queue[prac.i], {
    head: `第 ${prac.i + 1} / ${prac.queue.length} 題`,
    hideTopic: prac.mode === 'mixed',
    noTimer: prac.mode === 'mixed',
    onDone(res) {
      prac.results.push(res);
      prac.i++;
      pracNext();
    },
  });
}
function pracDone() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  const all = prac.results;
  const r = all.filter((x) => !x.excluded);
  const okN = r.filter((x) => x.ok).length;
  const showSpeed = prac.mode !== 'mixed' && timerOn();
  const slowOk = showSpeed ? r.filter((x) => x.ok && x.ms > x.target * 1.5).length : 0;
  const hardWins = all.filter((x, i) => !x.excluded && x.ok && prac.queue[i].diff === 3).length;
  const rows = all.map((x, i) => {
    const q = prac.queue[i];
    if (x.excluded) return `<tr><td>${TOPICS[q.topic]}</td><td colspan="${showSpeed ? 3 : 2}" class="dim">（中途離開，未列入紀錄）</td></tr>`;
    return `<tr><td>${TOPICS[q.topic]}</td><td>${x.ok ? '✔' : '✘'}</td>
      ${showSpeed ? `<td class="${x.ms > x.target ? 'badc' : 'okc'}">${fmtSec(x.ms)} / ${fmtSec(x.target)}</td>` : ''}
      <td>${x.err || '—'}</td></tr>`;
  }).join('');
  const cheer = r.length && okN === r.length ? '整輪全對——這種穩定度就是考場要的！'
    : hardWins ? `其中 ${hardWins} 題是★★★難題你也拿下了，難題手感正在長出來。`
    : r.length && okN >= Math.ceil(r.length * 0.7) ? '大部分都拿下了，把錯的釘進錯題本，這輪就值回票價。' : '';
  // 單元進步對照：本輪 vs 過去（樣本 ≥5 才比；只在進步時講——誠實原則）
  const beforeAtt = sessSnap ? S.attempts.slice(0, sessSnap.att) : [];
  const roundTopics = {};
  all.forEach((x, i) => {
    if (x.excluded) return;
    const k = prac.queue[i].topic;
    const t = (roundTopics[k] = roundTopics[k] || { n: 0, ok: 0 });
    t.n++; t.ok += x.ok ? 1 : 0;
  });
  const progress = Object.keys(roundTopics).map((k) => {
    const past = beforeAtt.filter((a) => { const q = bankById(a.qid); return q && q.topic === k; });
    if (past.length < 5) return '';
    const pAcc = past.filter((a) => a.ok).length / past.length;
    const rr = roundTopics[k];
    if (rr.ok / rr.n <= pAcc) return '';
    const strong = pAcc < 0.6 && rr.ok === rr.n;
    return `<p class="${strong ? 'praise' : 'okc'}">📈 ${TOPICS[k]}：過去 ${(pAcc * 100).toFixed(0)}%（${past.length} 題）→ 本輪 ${rr.ok}/${rr.n}${strong ? '——弱單元整輪全對，這個洞正在補起來！' : ''}</p>`;
  }).filter(Boolean).join('');
  // 本輪卡點回顧：刷完當下最想知道「我都卡在哪」，不必跑數據頁
  const roundStuck = [];
  for (const a of S.attempts.slice(sessSnap ? sessSnap.att : 0)) {
    if (a.p && Array.isArray(a.p.stuck)) for (const s of a.p.stuck) roundStuck.push({ topic: (bankById(a.qid) || {}).topic, ...s });
  }
  const stuckRecap = roundStuck.length ? `<div class="stuck-box"><p class="stuck-title"><b>🧠 本輪卡點</b></p>
    ${roundStuck.slice(0, 4).map((s) => `<p style="margin:3px 0">${s.topic ? TOPICS[s.topic] + '：' : ''}${rtAi(s.what || '')}${s.dur ? `（停 ${s.dur}s）` : ''}${s.fix ? ` <span class="okc">💡 ${rtAi(s.fix)}</span>` : ''}</p>`).join('')}</div>` : '';
  app().innerHTML = `
    <h1>刷題結果</h1>
    ${goalCrossBanner()}
    <div class="card">
      ${prac.picked && prac.picked.length ? `<p class="dim fs13">🔒 本輪鎖定：${prac.picked.map((p) => `${TOPICS[p.k]}（${p.reason}）`).join('、')}</p>` : ''}
      <p class="big">答對 <b>${okN} / ${r.length}</b>${slowOk ? `，其中 <b class="warnc">${slowOk} 題「對但超時」</b>（考場上等於失分，已加入錯題本重練速度）` : ''}</p>
      ${cheer ? `<p class="praise">🎉 ${cheer}</p>` : ''}
      ${progress}
      ${stuckRecap}
      <table class="tbl"><tr><th>單元</th><th>結果</th>${showSpeed ? '<th>耗時/目標</th>' : ''}<th>錯因</th></tr>${rows}</table>
      <div class="actr"><button class="btn" onclick="nav('stats')">看數據</button>
      ${prac.topics && prac.topics.length ? `<button class="btn primary" onclick="startPracTopics([${prac.topics.map((t) => `'${t}'`).join(',')}], ${prac.cnt || 6})">再刷一輪</button>` : ''}</div>
    </div>`;
}

/* ═══════════ 單題渲染（刷題與錯題重測共用） ═══════════ */
/* ═══ 學測題本樣式：段落標頭＋題號外突＋(1)(2) 直排選項，讀寫都像真考卷 ═══ */
function sectionLabel(q) {
  if (q.examSection === 'mixed') return '混合題／非選擇題';
  return q.type === 'single' ? '單選題' : q.type === 'multi' ? '多選題' : '選填／非選題';
}
function bkNum(head) { const m = String(head || '').match(/(\d+)/); return m ? m[1] + '.' : '※'; }
/* 選項印在題目正下方（像考卷），tap 仍作答；submitFn：single→'qSubmit'|'mockAns'（帶索引），multi→送出鈕 */
function bkOpts(q, submitFn) {
  if (q.type === 'single') {
    // 模擬＝正式考：點選項先「劃卡」，再按送出確認（手滑點錯不會直接鎖定）；平時刷題維持點了就走的節奏
    const click = submitFn === 'mockAns' ? (i) => `mockPick(${i},this)` : (i) => `${submitFn}(${i})`;
    return `<div class="bk-opts">${q.opts.map((o, i) =>
      `<button type="button" class="bk-opt" aria-label="選項 ${i + 1}：${escH(stripTags(o))}" onclick="${click(i)}"><span class="bk-check" aria-hidden="true"></span><span class="bk-op" aria-hidden="true">(${i + 1})</span><span>${rtTxt(o)}</span></button>`).join('')}</div>`;
  }
  if (q.type === 'multi') {
    return `<div class="bk-opts">${q.opts.map((o, i) =>
      `<label class="bk-opt"><input type="checkbox" value="${i}" hidden><span class="bk-check"></span><span class="bk-op">(${i + 1})</span><span>${rtTxt(o)}</span></label>`).join('')}</div>`;
  }
  return '';
}
/* 統一計算紙卡：題目印在最上 → 批改結果槽（就在題目正下方）→ 計算紙工具 → 一大張書寫畫布 → 按鈕沉底。
   一整張連續的紙、題目正下方就能寫；批改後用 :has() 自動收起計算紙與按鈕，結果直接顯示在題目下。 */
function bkCard(q, head, submitFn, actions) {
  // 整卡書寫層：整張卡就是一張計算紙——題目印在 canvas 底下（題目上、旁邊、空白處都能寫），
  // 工具列與作答按鈕浮在最上層可點；批改後用 :has 收起書寫層、只留題目＋結果。
  return `<div class="card qcard booklet sheet">
    <div class="bk-head"><span class="bk-exam">數學Ａ</span><span class="bk-sect">${sectionLabel(q)}</span></div>
    <div class="sheet-tools"><b>✍️ 整張都能寫${q.type === 'fill' ? '，答案寫在最後、圈起來' : ''}</b>${inkToolsHTML()}</div>
    <div class="bk-item"><span class="bk-num">${bkNum(head)}</span>
      <div class="bk-content">${q.stem ? `<div class="bk-stem">${rtTxt(q.stem)}</div>` : ''}${rtTxt(q.q)}${q.fig ? `<div class="qfig">${sanitizeSVG(q.fig)}</div>` : ''}${bkOpts(q, submitFn)}</div></div>
    <div class="write-pad"></div>
    <div class="ansarea">${actions}</div>
    <div id="qfb"></div>
    <canvas id="ink-cv" class="qink"></canvas>
  </div>`;
}
let qsess = null;
let typedOpen = false; // 「改用打字」摺疊的展開狀態（session 內記住：習慣打字的人不用每題展開一次）
function scrollQuestionTop() {
  if (!window || typeof window.scrollTo !== 'function') return;
  try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }
  catch (e) { window.scrollTo(0, 0); }
}
function renderQuestion(q, cfg) {
  qsess = { q, cfg, t0: Date.now(), warned: false, locked: false };
  const target = qTarget(q);
  const showTimer = timerOn() && !cfg.noTimer;
  const meta = cfg.hideTopic ? '全範圍混合' : `${TOPICS[q.topic]}${q.src ? `｜<b class="accent">${escH(q.src)}</b>` : ''}｜${stars(q.diff)}`; // src 來自匯入題包，不可信
  const giveUp = `<button class="btn sm skip" onclick="qGiveUp()">🏳 放棄，看答案</button>`;
  const hintBtn = aiEnabled() ? `<button class="btn sm" onclick="qHint()">💡 我卡關了</button>` : ''; // AI 看你手寫、給下一步提示（不給完整答案）
  let actions;
  if (q.type === 'single') {
    actions = `<div class="actr">${giveUp}${hintBtn}</div>`; // 點選項即作答
  } else if (q.type === 'multi') {
    actions = `<div class="actr">${giveUp}${hintBtn}<button class="btn primary" onclick="qSubmit()">送出（多選）</button></div>`;
  } else {
    actions = `<div class="actr">${giveUp}${hintBtn}<button class="btn primary big" onclick="qSubmit()">✅ 算完了，開始批改</button></div>
      <details class="typed-opt"${typedOpen ? ' open' : ''} ontoggle="typedOpen=this.open"><summary class="dim">改用打字（選用）</summary>
      <input id="qin" class="ans-input" autocomplete="off" placeholder="輸入答案（分數用 a/b）" onkeydown="if(event.key==='Enter')qSubmit()"></details>`;
  }
  app().innerHTML = `
    <div class="session-head">
      <span>${cfg.head}｜${meta}${showTimer ? `｜目標 ${fmtSec(target)}` : ''}</span>
      <span class="shr"><span class="dim" style="font-size:11px">${APP_VER}</span>${showTimer ? '<span id="qtimer" class="timer">00:00</span>' : ''}
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    ${showTimer ? '<div class="timebar"><div id="tbfill" class="timebar-fill"></div></div>' : ''}
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    <div id="qhint"></div><!-- 提示放在書寫卡「外面、上方」：出現時把整張卡連同手寫往下推、不蓋到手寫（卡內任何面板都會蓋到滿版書寫層） -->
    ${cfg.redo ? `<div class="card redo-sol"><p><b>📖 解答攤開著——照它的路，自己再走一遍（寫完照樣批改）：</b></p>${rtTxt(q.sol)}${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}${q.tip ? `<p class="tip">💡 ${rtTxt(q.tip)}</p>` : ''}${teachBlock(q.id)}</div>` : ''}
    ${bkCard(q, cfg.head, 'qSubmit', actions)}`;
  scrollQuestionTop();
  sessionChrome(true);
  inkStart(q.id, qsess.t0);
  if (!showTimer) return; // 混合練習刻意不顯示單題時間；仍在幕後保存耗時供長期分析
  startTicker(() => {
    if (!qsess) return; // 防禦：session 已被清掉的殭屍 tick
    const e = Date.now() - qsess.t0;
    const t = $('#qtimer'); const f = $('#tbfill');
    if (!t) return;
    t.textContent = fmtClock(e);
    f.style.width = Math.min(100, (e / target) * 100) + '%';
    if (!qsess.warned && e >= target) {
      qsess.warned = true;
      flashOnce('⏰ 理想上這題現在該答完了——還沒有路就準備收尾或跳題');
    }
  });
}
/* 放棄看答案：真的不會就直接看詳解，記為答錯（錯因可標「概念不熟」） */
function qGiveUp() {
  if (!qsess || qsess.locked) return;
  qsess.locked = true;
  qsess.ms = Date.now() - qsess.t0;
  stopTicker();
  qsess.proc = inkStop();
  document.querySelectorAll('.qcard button, .qcard input').forEach((b) => (b.disabled = true));
  qsess.yourAns = '（放棄，看答案）';
  qsess.gaveUp = true;
  qResolve(false);
}
/* 💡 我卡關了：AI 看你「目前的手寫」，判斷方向可不可行→順著給下一步提示/抓算錯處，或建議換方向；絕不給完整答案。
   可連按（每次看你最新進度、帶入先前提示避免重複）。不送出、不判分、不動計時。 */
async function qHint() {
  if (!qsess || qsess.locked || qsess.hintBusy) return;
  const sess = qsess, q = sess.q; // 綁定本題：await 期間換題/離開，遲到回應才不會污染別題或對 undefined qsess 丟錯
  if (!aiEnabled()) { sess.hints = ['（請先登入雲端同步，才能透過安全代理使用 OpenAI 提示）']; if (qsess === sess) renderHints(); return; }
  const b64 = inkCaptureFull(q.id); // 目前手寫的即時快照（null＝還沒動筆）
  sess.hints = sess.hints || [];
  sess.hintBusy = true;
  if (sess.hintCollapsed) sess.hintCollapsed = false; // 按了卡關就展開讓他看得到
  renderHints();
  const _he = document.getElementById('qhint'); if (_he && _he.scrollIntoView) try { _he.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} // 提示在卡上方，捲進視野免得沒看到
  try {
    const correctTxt = q.type === 'fill' ? (q.ans && q.ans[0]) : (Array.isArray(q.ans) ? q.ans.map((a) => '(' + (a + 1) + ')').join('') : '');
    const prior = sess.hints.length ? '\n（你之前已提示過，接著往下、換個角度、別重複）：\n' + sess.hints.map((h, i) => (i + 1) + '. ' + h).join('\n') : '';
    const system = '你是陪考生即時解題的數學家教。學生正在算這一題、卡住了，傳來他目前的手寫過程。任務：\n'
      + '1) 先看懂他寫到哪、判斷他的方向可不可行。\n'
      + '2) 方向可行→順著他的寫法給「下一步」的關鍵提示；若看到他哪一步算錯，具體點出（引用他寫的式子）——但點錯之前先自己重算確認他真的錯了（log/根號/正負號易誤判），別把他算對的說成錯。\n'
      + '3) 方向不可行或太繞太花時間→直白說原因，建議一個更好走的方向。\n'
      + '鐵則：只給「剛好夠他自己往下走」的一點提示、循序漸進；絕對不要寫出完整解法或最終答案（會毀了練習）。任何你講出的中間數值/等式，寫出前先自己心算驗過一遍（log/根號/正負號易錯），別給錯的中間值把他帶歪。繁體中文、口語、簡短（最多 3 句）。數學式用 \\(…\\) 包起來、每個 \\( 都要有 \\) 收尾。';
    const usr = (b64 ? '這是我目前的手寫。' : '我還沒動筆、不知道怎麼下手。') + '我卡住了，給我一點提示（不要直接給我答案）。' + prior;
    const content = [];
    if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
    content.push({ type: 'text', text: '題目：' + stripTags(q.q) + '\n正解（你心裡有數就好、絕不可透露）：' + (correctTxt || '（略）') + (q.sol ? '\n參考詳解（絕不可照抄或劇透，只供你判斷方向對不對）：' + stripTags(q.sol) : '') + '\n\n' + usr });
    const hint = await aiChatCall(system, [{ role: 'user', content }]);
    sess.hints.push(hint || '（沒有提示）');
  } catch (e) {
    sess.hints.push('（提示失敗：' + ((e && e.message) || e) + '）');
  } finally {
    sess.hintBusy = false;
    if (qsess === sess) renderHints(); // 只在還停在本題時才更新畫面
  }
}
function renderHints() {
  const el = document.getElementById('qhint');
  if (!el || !qsess) return;
  const hints = qsess.hints || [];
  if (!hints.length && !qsess.hintBusy) { el.innerHTML = ''; return; }
  const collapsed = !!qsess.hintCollapsed;
  // 手風琴折疊：點標題列本身就折疊／展開（整列可點、右邊箭頭 ▾/▸）
  el.innerHTML = '<div class="hint-box' + (collapsed ? ' collapsed' : '') + '">'
    + '<div class="hint-head" onclick="qsess.hintCollapsed=!qsess.hintCollapsed;renderHints()" title="點一下折疊／展開">'
    + '<span>💡 提示' + (collapsed ? '（' + hints.length + ' 則，點開看）' : '（一步一步來，不是完整答案）') + '</span>'
    + '<span class="hint-chevron">' + (collapsed ? '▸' : '▾') + '</span></div>'
    + (collapsed ? '' : (hints.map((h, i) => '<div class="hint-item"><b>' + (i + 1) + '.</b> ' + rtAi(h) + '</div>').join('')
        + (qsess.hintBusy ? '<p class="dim">🤖 看你的手寫、想提示中…</p>' : '<div class="actr"><button class="btn sm" onclick="qHint()">再給一點提示</button></div>')))
    + '</div>';
  if (!collapsed) el.querySelectorAll('.hint-item').forEach((n) => { try { renderMathInElement(n, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }], throwOnError: false }); } catch (e) {} });
}
function qSubmit(optIdx) {
  if (!qsess || qsess.locked) return;
  qsess.locked = true;
  const ms = Date.now() - qsess.t0;
  qsess.ms = ms;
  stopTicker();
  qsess.proc = inkStop();
  document.querySelectorAll('.qcard button, .qcard input').forEach((b) => (b.disabled = true));
  const go = () => qGrade(optIdx);
  if (ms >= 360000) {
    modal(`<h2>⏸ 這題用了 ${fmtSec(ms)}</h2><p>超過 6 分鐘——是不是有中途離開座位？有的話這筆不列入紀錄，避免污染數據（詳解照樣看得到）。</p>`, [
      ['有離開，這筆不列入', () => { qsess.exclude = true; go(); }],
      ['沒有離開，正常記錄', go],
    ]);
  } else go();
}
function qGrade(optIdx) {
  const { q } = qsess;
  if (q.type === 'single') { qsess.yourAns = `(${optIdx + 1})`; qResolve(optIdx === q.ans[0]); return; }
  if (q.type === 'multi') {
    const chosen = [...document.querySelectorAll('.bk-opts input:checked')].map((i) => +i.value);
    qsess.yourAns = chosen.length ? chosen.map((c) => `(${c + 1})`).join('') : '（未選）';
    qResolve(chosen.length === q.ans.length && q.ans.every((a) => chosen.includes(a)));
    return;
  }
  // 填充：打字（選用）自動判；手寫 → AI 批改，沒設 AI 就看正解自評。都不用鍵盤。
  const typed = $('#qin') ? $('#qin').value.trim() : '';
  if (typed) { qsess.yourAns = typed; qResolve(checkFill(typed, q.ans)); return; }
  qsess.yourAns = '（手寫作答）';
  // 整卷截圖：題卡上的筆跡＋計算區筆跡拼成一張（跟題本一樣整面都能寫）
  const calcB64 = inkCaptureFull(q.id);
  qsess.calcImg = calcB64 ? 'data:image/png;base64,' + calcB64 : null; // 存起乾淨版：批改後在你的筆跡上畫紅圈
  qsess.calcImgW = inkCaptureFull.lastW || 480; // 手寫原始寬，批改結果照這寬顯示（不放大）
  qsess.markBox = inkCaptureFull.lastBox; // 筆跡外框：批改後把 AI 的框映射回畫布、畫在原字上
  const _ord = inkOrderedShot(q.id); // 給 AI 的是「標了書寫順序＋答案框」版；顯示/紅圈仍用乾淨版（幾何一致，marks 對得準）
  const _st = sessionInk[q.id] || {};
  const _ns = (_st.s || []).filter((s) => !s.dead && !s.arch).length;
  qsess.diag = `診斷 v${APP_VER}：OpenAI=${aiEnabled() ? '可呼叫' : '未登入'}｜筆跡 ${_ns} 筆｜截圖=${calcB64 ? '成功' : '空'}`;
  if (aiEnabled() && calcB64) {
    $('#qfb').innerHTML = '<p class="dim">🤖 AI 批改中…（認字、對答案、檢查過程哪裡開始錯）</p>';
    const sess = qsess; // 綁定本題：離開或換題後，遲到的回應直接丟棄
    sess.stuckShots = inkStuckShots(q.id, sess.t0); // 停頓證據圖一起送：同一次 API 順帶判讀「當時卡在哪」
    aiGradeCall(q, q.ans.join(' 或 '), (_ord && _ord.b64) || calcB64, sess.stuckShots, _ord ? _ord.steps : 0)
      .then((v) => { if (qsess !== sess) return; qsess.ai = v; qsess.stuck = normStuck(v, sess.stuckShots); const ok = aiCorrect(v); inkMark(q.id, ok, String(q.ans[0])); qResolve(ok); }) // AI 判定直接生效→解答頁（不再多按一次「改對了」；改判連結留在解答頁）
      .catch((e) => { if (qsess !== sess) return; qsess.aiErr = (e && e.message) || String(e); qShowJudge(false); });
  } else {
    if (aiEnabled() && !calcB64) qsess.noInk = true; // AI 可用卻沒有任何筆跡：要明講，不能靜默
    qShowJudge(false);
  }
}
function qShowJudge(hasAI) {
  const { q } = qsess;
  const v = qsess.ai;
  const peek = `<div class="sol"><p>正解：<b class="big">${mDispOpt(String(q.ans[0]))}</b></p></div>`;
  if (hasAI && v) {
    const okv = aiCorrect(v);
    $('#qfb').innerHTML = `${aiFeedbackHTML(v)}${peek}
      <p class="dim">AI 判得對就繼續；判錯了可以改判。</p>
      <div class="actr"><button class="btn" onclick="qResolve(${!okv})">改判：其實我${okv ? '錯了' : '對了'}</button>
      <button class="btn primary" onclick="qResolve(${okv})">${okv ? '✓ 沒錯，我答對了' : '✗ 對，我答錯了'}——繼續</button></div>`;
    inkMark(q.id, okv, String(q.ans[0])); // 像老師改考卷：紅勾/紅叉畫在最後一筆旁
  } else {
    const noKeyHint = !qsess.aiErr && !aiEnabled() && supa
      ? '<p class="warnc">尚未登入雲端同步，因此這題不會呼叫 OpenAI。</p>' : '';
    const noInkHint = qsess.noInk
      ? '<p class="warnc">⚠ AI 沒批改：抓不到手寫筆跡——先寫再按「算完了」。</p>' : '';
    const diag = qsess.diag && (qsess.aiErr || qsess.noInk) ? `<p style="font-size:13px;background:#fff8e1;border:1px solid #f0c14b;padding:6px 9px;border-radius:6px;margin:6px 0">🔎 ${qsess.diag}</p>` : ''; // 只在批改異常時亮診斷，平常自評不出 debug 噪音
    const noAIHint = !qsess.aiErr && !aiEnabled() ? '<p class="dim">（AI 批改未啟用——先對照正解自評；登入雲端後即可使用 OpenAI 自動批改與手寫分析。）</p>' : '';
    $('#qfb').innerHTML = `${qsess.aiErr ? `<p class="warnc">⚠ AI 批改失敗：${escH(qsess.aiErr)}——先自評，key 問題到「📊 數據」頁按「測試連線」檢查。</p>` : noInkHint || noKeyHint}${diag}${peek}${noAIHint}
      <p><b>答對了嗎？</b><span class="dim">（等價形式都算對）</span></p>
      <div class="actr"><button class="btn err" onclick="qResolve(false)">✗ 我錯了</button>
      <button class="btn primary" onclick="qResolve(true)">✓ 我對了</button></div>`;
  }
}
function fbInView() { // 批改完把回饋區捲到頂：最上面就是判定＋「下一題」，不用往下拉
  const fb = $('#qfb');
  if (fb && fb.scrollIntoView) { try { fb.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { fb.scrollIntoView(); } }
}
function qResolve(ok) {
  const { q } = qsess;
  const ms = qsess.ms;
  const target = qTarget(q);
  const visibleTiming = timerOn() && !(qsess.cfg && qsess.cfg.noTimer);
  const overtime = visibleTiming && ok && ms > target * 1.5;
  const correctTxt = q.type === 'fill' ? q.ans[0] : q.ans.map((a) => `(${a + 1})`).join('');
  // 筆跡一律上傳（珍貴分析資料）；改判會重跑 qResolve，用旗標避免重複上傳
  if (!qsess.inkSynced) {
    syncInk(q.id, qsess.t0, Object.assign(
      { mode: qsess.cfg.side ? 'side' : 'practice', ok, excluded: !!qsess.exclude, ai: qsess.ai || null }, qsess.proc || {}));
    qsess.inkSynced = true;
  }
  // 🎯 類題支線：只記到獨立桶（S.sidePractice），絕不進 attempts／錯題本／每日點數／本輪成績
  if (qsess.cfg.side) {
    if (!qsess.sideRecord) { // 首次：新增一筆
      const orig = sideState && sideState.origQ;
      const origSess = sideState && sideState.sess;
      qsess.sideRecord = {
        qid: q.id, origId: qsess.cfg.origId || null, ok, ms, ts: Date.now(), d: today(),
        topic: q.topic, diff: q.diff, kind: qsess.cfg.redo ? 'guided-redo' : 'independent-transfer',
        originErr: (origSess && origSess.errPick) || (orig && S.wrong[orig.id] && S.wrong[orig.id].err) || null,
      };
      if (qsess.cfg.redo) qsess.sideRecord.redo = 1; // 訂正重算：看著解答寫的，別跟自力類題混在一起解讀
      (S.sidePractice = S.sidePractice || []).push(qsess.sideRecord);
    } else { qsess.sideRecord.ok = ok; qsess.sideRecord.ms = ms; } // 改判：更新同一筆（陣列裡是同一個物件參照），不新增
    save();
  }
  const fb = $('#qfb');
  const v = qsess.ai; // AI 批改結果（只有手寫填充題有）：{read,correct,firstError,praise,nextTime,marks,stuck}
  const timeStr = visibleTiming ? `｜耗時 ${fmtSec(ms)}（目標 ${fmtSec(target)}）` : '';
  const solTxt = q.type === 'fill' ? mDispOpt(String(correctTxt)) : correctTxt;
  // ① 判定列——永遠最上面
  const verdict = ok
    ? `<p>${overtime ? '<span class="ok">✔ 答對，但太慢</span>' : '<span class="ok">✔ 答對</span>'}｜正解：<b>${solTxt}</b>${timeStr}</p>${overtime ? '<p class="warnc"><b>⚠ 超過目標 1.5 倍——考場上這題等於沒拿到</b></p>' : ''}`
    : `<p><span class="bad">✘ 答錯</span>（你的：${escH(qsess.yourAns)}）｜正解：<b>${solTxt}</b>${timeStr}</p>`;
  // ② AI 讀到什麼＋改判（只有 AI 批改過才有；壓成一行，兼顧信任與翻案）
  const reJudge = v
    ? `<p class="rejudge">🤖 AI 讀到「<b>${v.read != null ? escH(v.read) : '—'}</b>」→ 判${ok ? '對' : '錯'}　<a onclick="qResolve(${!ok})">判錯了？改判</a></p>`
    : '';
  // ③ 主要動作——緊接判定，一按就走，不用往下拉；類題支線用不同按鈕（不進主流程）
  const correctErrArg = overtime ? "(qsess.uncertain ? '用猜的' : '超時')" : "(qsess.uncertain ? '用猜的' : null)";
  const action = qsess.cfg.side
    ? (qsess.cfg.redo
      ? `<div class="actr"><button class="btn" onclick="qRedoAgain()">📝 再算一次</button><button class="btn" onclick="sideReturn()">↩ 回到原題</button><button class="btn primary big" onclick="qRedoDone()">下一題 →</button></div>`
      : `<div class="actr"><button class="btn primary big" onclick="sideNext()">🎯 再來一題類題</button><button class="btn" onclick="sideReturn()">↩ 回到原題</button></div>`)
    : (!ok
      ? `<p class="dim" style="margin:8px 0 4px">標個錯因幫錯題本分類（選填，不選也能直接下一題）：</p><div class="chips r">${ERR_TYPES.slice(0, 4).map((e) => `<button class="chip${qsess.errPick === e ? ' sel' : ''}" onclick="qPickErr(this,'${e}')">${e}</button>`).join('')}</div><div class="actr" style="margin-top:8px"><button class="btn" onclick="qRedoStart()">📝 看解答重算一次</button><button class="btn" onclick="qSideStart()">🎯 先練一題類題</button><button class="btn primary big" id="errnext" onclick="qFinish(false, ${ms}, qsess.errPick)">下一題 →</button></div>`
      : `<div class="actr"><button class="btn primary big" onclick="qFinish(true, ${ms}, ${correctErrArg})">下一題 →</button><button class="btn confidence-btn${qsess.uncertain ? ' sel' : ''}" aria-pressed="${qsess.uncertain ? 'true' : 'false'}" onclick="qMarkUncertain(this)">${qsess.uncertain ? '已標記：猜中，明天再驗' : '這題其實是猜中的'}</button><button class="btn" onclick="qSideStart()">🎯 再練一題類題</button></div>`);
  // ④ 中段（批改的靈魂）：先肯定你做得好的 → 錯在哪（圈在你字上）→ 🧠 卡在哪 → 🎯 下次這樣做。詳解不塞這、收摺疊。
  const willProc = aiEnabled() && !v && qsess.proc && qsess.proc.n; // 選擇/打字題稍後由 AI 過程點評接手稱讚＋下次，這裡就不重複
  // 史實類稱讚（曾錯今對/破個人最速）AI 看不到，永遠保留；AI 在場時當下類交給 AI 講
  const praiseHTML = (v && v.praise ? `<p class="praise">🎉 你做得好：${rtAi(v.praise)}</p>` : '') + praiseFor(q, ok, ms, target, !!(v || willProc));
  const nextTxt = v && v.nextTime ? rtAi(v.nextTime) : (!willProc && q.tip ? rtTxt(q.tip) : '');
  const nextHTML = nextTxt ? `<div class="next-step"><b>🎯 下次這樣做：</b>${nextTxt}</div>` : '';
  // 🧠 卡點：AI 有回就用 AI 的語意判讀；沒 AI 時退本地啟發式（位置分類）。willProc 時交給 #ai-proc 顯示，不重複。
  if (!qsess.stuck) {
    qsess.stuck = v ? normStuck(v, qsess.stuckShots) : [];
    if (!qsess.stuck.length && !willProc && qsess.proc) qsess.stuck = stuckLabel(qsess.proc, ms);
  }
  const stuckBlock = willProc ? '' : stuckHTML(qsess.stuck);
  // 你的手算圖：批改後書寫層會收起（畫布藏起來），所以把手算放進批改結果裡讓你還看得到——答錯有紅圈、答對就純手算。
  // 填充題 qGrade 已存 qsess.calcImg；其他有手寫的補抓一次。選擇題（willProc）改由 #ai-proc 顯示手算，這裡不重複。
  if (!qsess.calcImg && qsess.proc && qsess.proc.n) { const _b = inkCaptureFull(q.id); qsess.calcImg = _b ? 'data:image/png;base64,' + _b : null; qsess.calcImgW = inkCaptureFull.lastW || 480; qsess.markBox = inkCaptureFull.lastBox; }
  const handImg = ''; // 手算改畫在「原本的書寫層」上（AI 紅框對得到位置、還能繼續加寫）——不再另貼一張截圖，你就對得到了
  let mid = '';
  if (!ok) {
    const errLine = v && v.firstError ? `<p class="badc" style="margin:8px 0 4px"><b>你這裡跑掉了：</b>${rtAi(v.firstError)}</p>` : ''; // 畫布上的紅框圈「哪裡」，這行講「錯什麼」
    const method = !v ? `<div class="one-method"><b>一種最簡單的算法：</b>${rtTxt(q.sol)}${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}</div>` : ''; // 沒 AI 看手寫時才補完整方法；詳解配圖（solFig）不過 rtTxt
    mid = `${praiseHTML}${handImg}${errLine}${stuckBlock}${method}${nextHTML}`;
  } else if (overtime) {
    mid = `${praiseHTML}${handImg}${stuckBlock}${nextHTML || (willProc ? '' : '<p class="dim">多做幾次讓步驟變反射就會更快。</p>')}`;
  } else {
    mid = `${praiseHTML}${handImg}${stuckBlock}${nextHTML}`;
  }
  // ⑤ 完整解說——永遠收起（答對又準時完全不擋路）；只放上面沒秀的部分，避免重複
  const solInFull = ok ? `<p><b>詳解：</b>${rtTxt(q.sol)}</p>${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}` : ''; // 答錯已在上面用人話講過
  const tipInFull = q.tip && !overtime && !(v && v.nextTime) ? `<p class="tip">💡 <b>快解：</b>${rtTxt(q.tip)}</p>` : ''; // 快解已在上面或當「下次這樣做」用掉就不重複
  const full = `<details class="sol-detail" ontoggle="if(this.open){const b=this.querySelector('#mlib-box');if(b&&!b.innerHTML)showMethods('${q.topic}',true)}">
      <summary class="dim">📖 ${ok ? '完整解說' : '其他解法'}（詳解 · 老師方法 · 回放）</summary>
      ${solInFull}${tipInFull}${teachBlock(q.id)}
      <div class="mlib" style="margin-top:6px"><div id="mlib-box"></div></div>
      ${qsess.proc && qsess.proc.n ? `<div class="actr">${qsess.stuck && qsess.stuck.length && qsess.stuck[0].at != null ? `<button class="btn sm" onclick="inkReplay('${jsA(q.id)}', ${qsess.t0}, ${qsess.t0 + Math.max(0, (qsess.stuck[0].at - 5)) * 1000})">⏸ 從卡點前回放</button>` : ''}<button class="btn sm" onclick="inkReplay('${jsA(q.id)}', ${qsess.t0})">▶ 回放解題過程</button></div>` : ''}
    </details>`;
  qsess.lastOk = ok; // 供「追問這題」對話帶入本題對錯脈絡
  fb.innerHTML = `<div class="sol graded">${verdict}${reJudge}${action}${mid}<div id="ai-proc"></div><div id="ai-chat"></div>${full}${qsess.exclude ? '<p class="warnc">（依你的選擇，這筆不列入紀錄）</p>' : ''}</div>`;
  fbInView();
  // 選擇/打字題：答案已判定，但只要有寫手寫過程就讓 AI 看並點評（答對也看——飼主要的就是這個）
  if (aiEnabled() && !qsess.ai && qsess.proc && qsess.proc.n) {
    const el = document.getElementById('ai-proc');
    if (el) { el.innerHTML = '<p class="dim">🤖 AI 正在看你的手寫過程…（不用等，可先按下一題）</p>'; qProcReview(ok); }
  }
  // 批改後：把 AI 紅框畫在你原字上、恢復書寫層可繼續加寫（即使本題尚未落筆也要恢復工具）。
  // 等版面（含 KaTeX）定下來再抓畫布高度；換題後的遲到 callback 會由 qid guard 丟棄。
  resumeAfterGrade(q.id, (qsess.ai && qsess.ai.marks) || null, qsess.markBox);
  mountChat(qsess); // 「追問這題」多輪對話區（有 context 記憶）
}
/* 標錯因＝選取，不跳題（詳解/卡點還要看）；「下一題」才前進 */
function qPickErr(btn, e) {
  if (!qsess) return;
  qsess.errPick = e;
  if (btn && btn.parentElement) btn.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('sel', c === btn));
  const nx = $('#errnext'); if (nx) { nx.disabled = false; nx.textContent = '下一題 →'; }
}
function qMarkUncertain(btn) {
  if (!qsess) return;
  qsess.uncertain = !qsess.uncertain;
  if (btn) {
    btn.classList.toggle('sel', qsess.uncertain);
    btn.setAttribute('aria-pressed', qsess.uncertain ? 'true' : 'false');
    btn.textContent = qsess.uncertain ? '已標記：猜中，明天再驗' : '這題其實是猜中的';
  }
}
let qFinLock = false; // 重入鎖：擋掉「連點兩下下一題／錯因鈕」——第一下已把 qsess 換到下一題，第二下（脫離 DOM 的舊按鈕仍會觸發）會誤記下一題並跳過它
function qFinish(ok, ms, err) {
  if (qFinLock) return; // 同一個同步 tick 內只認第一下
  qFinLock = true; Promise.resolve().then(() => { qFinLock = false; }); // 微任務後解鎖，不影響之後正常的點擊
  const { q, cfg } = qsess;
  if (!qsess.exclude) {
    if (qsess.stuck && qsess.stuck.length && qsess.proc) qsess.proc.stuck = qsess.stuck; // 卡點分析跟著 attempt 入庫
    const rec = recordAttempt(q, ok, ms, err, prac ? prac.mode : 'practice', qsess.proc, qsess.ai);
    qsess.rec = rec; // 給遲到的 AI 過程點評精準補寫用（不再掃 attempts 猜哪筆是本場）
    const advP = qsess.advPending; // 非同步過程點評的建議若已先到，這裡補進本場紀錄與錯題卡
    if (advP) {
      let dirty = false;
      if (rec && !rec.ai) { rec.ai = advP; dirty = true; }
      if (S.wrong[q.id] && !S.wrong[q.id].grad) { S.wrong[q.id].adv = advP; S.wrong[q.id].mt = Date.now(); dirty = true; }
      if (dirty) save();
    }
    // 手寫本體不再另存本機縮圖（原 errshots 相簿無任何顯示介面）；完整筆跡照走雲端 ink_sessions
  }
  cfg.onDone({ ok, ms, err, target: qTarget(q), excluded: !!qsess.exclude });
}

/* ═══════════ 🎯 類題支線練習 ═══════════
   看完解答後立刻練一題同主題類題，驗證是不是真的會了。做完可再來一題或回原題。
   完全獨立：只記到 S.sidePractice，絕不碰 attempts／錯題本／每日點數／本輪成績表。 */
function pickSimilar(origQ, doneIds) {
  const ex = new Set([origQ.id, ...(doneIds || [])]);
  const variant = (q) => q.id.indexOf('v-' + origQ.id) === 0 || (q.src && /類題/.test(q.src));
  let cands = BANK.filter((q) => q.topic === origQ.topic && !ex.has(q.id) && q.type === origQ.type);
  if (!cands.length) cands = BANK.filter((q) => q.topic === origQ.topic && !ex.has(q.id)); // 放寬：同主題不同題型也行
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const va = variant(a) ? 1 : 0, vb = variant(b) ? 1 : 0;
    if (va !== vb) return vb - va;                             // 真類題變體最優先
    const da = a.diff === origQ.diff ? 1 : 0, db = b.diff === origQ.diff ? 1 : 0;
    if (da !== db) return db - da;                            // 同難度次之
    return attemptsOf(a.id).length - attemptsOf(b.id).length; // 少做過的優先
  });
  const top = cands.slice(0, Math.min(5, cands.length));
  return top[Math.floor(Math.random() * top.length)];        // 前幾名裡隨機，避免每次同一題
}
let sideState = null; // { html, sess, origQ, doneIds, redo? }：支線期間暫存原題解答畫面與 session，回得去
/* 📝 訂正重算：答錯當下把解答攤開，同一題再手寫走一遍（有 key 照樣 AI 批改）。
   跟類題共用支線機制：只記 S.sidePractice（帶 redo 旗標），不動 attempts/錯題本。 */
function qRedoStart() {
  if (!qsess) return;
  sideState = { html: app().innerHTML, sess: qsess, origQ: qsess.q, doneIds: [qsess.q.id], redo: true, origCut: Date.now() }; // origCut：原題手寫/標記全在此時間之前；訂正時寫的在之後——回原題時據此還原原筆、收起訂正筆
  qRedoAgain();
}
function qRedoAgain() {
  if (!sideState || !sideState.redo) return;
  renderQuestion(sideState.origQ, { head: '📝 訂正重算（解答攤開著）', side: true, redo: true, origId: sideState.origQ.id, onDone() {} });
}
function qSideStart() {
  if (!qsess) return;
  // 類題不可以抽到「本輪待出的題」——否則等等正輪出到同題等於白練＋灌水
  const exclude = [qsess.q.id,
    ...(prac && prac.queue ? prac.queue.map((x) => x.id) : [])];
  sideState = { html: app().innerHTML, sess: qsess, origQ: qsess.q, doneIds: exclude };
  sideNext();
}
function sideNext() {
  if (!sideState) return;
  const sq = pickSimilar(sideState.origQ, sideState.doneIds);
  if (!sq) { modal('<h2>沒有更多類題了</h2><p>這個單元目前沒有其他可練的類題，先回原題吧。</p>', [['回到原題', sideReturn]]); return; }
  sideState.doneIds.push(sq.id);
  renderQuestion(sq, { head: '🎯 類題練習（不列入本輪成績）', side: true, origId: sideState.origQ.id, onDone() {} });
}
function sideReturn() {
  if (!sideState) return;
  const wasRedo = sideState.redo, origCut = sideState.origCut; // 先存起來，下面會把 sideState 清掉
  app().innerHTML = sideState.html; // 還原原題解答畫面（靜態，按鈕 onclick 用回全域 qsess）
  qsess = sideState.sess;
  sideState = null;
  const el = document.getElementById('ai-proc'); // 支線期間原題的 AI 過程點評若才回來，重新貼上（否則會卡在「正在看…」）
  if (el && qsess.aiProcHTML) el.innerHTML = qsess.aiProcHTML;
  mountChat(qsess); // 還原「追問這題」對話（回原題後接著問）
  // innerHTML 還原的畫布是空白的(bitmap 不序列化)：重掛書寫層＋重畫手寫與 AI 紅圈、恢復可續寫，別讓原題的手算/批改標記消失
  if (ink) { try { if (ink.ro) ink.ro.disconnect(); } catch (e) {} ink = null; } // 舊 #ink-cv 已被 innerHTML 換成新空白 canvas；清掉舊 ink 參照，強制 resumeWithMarks 重掛到「新」canvas 上重畫
  const q = qsess.q;
  const st = q && sessionInk[q.id];
  if (st) {
    if (wasRedo && origCut) { // 訂正重算跟原題共用 qid：訂正的 inkStart 曾把原筆跡歸檔→這裡還原原筆(t0<origCut)、收起訂正筆(t0>=origCut)
      for (const s of st.s) { if (s.t0 >= origCut) s.arch = 1; else if (s.arch) delete s.arch; }
      if (st.m) for (const m of st.m) { if ((m.t || 0) >= origCut) m.arch = 1; else if (m.arch) delete m.arch; } // ✓✗/紅框標記一起還原
    }
    try { resumeWithMarks(q.id, (qsess.ai && qsess.ai.marks) || null, qsess.markBox); } catch (e) {}
  }
}
/* 訂正重算中直接「下一題」：還原原題 session（原答案是錯的）→ 記原筆＋前進，不用先繞回原題再選錯因 */
function qRedoDone() {
  if (!sideState) return;
  const s = sideState.sess;
  sideReturn(); // qsess 回到原題
  qFinish(false, (s && s.ms) || 0, s && s.errPick); // 原題答錯：記錄＋前進下一題
}

/* ═══════════ 模擬實戰 ═══════════ */
function paperLatestRun(sourceId) {
  return (S.paperRuns || []).filter((run) => run && run.sourceId === sourceId && run.status !== 'discarded')
    .sort((a, b) => Number(b.createdAt || b.mt || 0) - Number(a.createdAt || a.mt || 0))[0] || null;
}
function paperSourceCardHTML(source) {
  const active = paperActiveRun(source.id), latest = paperLatestRun(source.id);
  let status = '尚未作答';
  let button = '開啟原版整回';
  if (active) {
    if (active.status === 'grading') { status = 'AI 批改尚未完成'; button = '繼續 AI 批改'; }
    else { status = `已保留進度｜剩餘 ${fmtClock(paperRunLeft(active))}`; button = '繼續這一回'; }
  } else if (latest && ['awaiting-key', 'awaiting-correction'].includes(latest.status)) {
    status = `${latest.score}/100｜錯 ${Array.isArray(latest.wrongNos) ? latest.wrongNos.length : 0} 題｜${String(latest.due || '') <= today() ? '已到隔日訂正' : `鎖到 ${latest.due}`}`;
    button = '再寫一回';
  } else if (latest && latest.status === 'completed') {
    status = `${latest.score}/100｜原卷訂正已完成`;
    button = '再寫一回';
  }
  const actions = active
    ? `<button class="btn primary" onclick="startPaperSource('${jsA(source.id)}')">${button}</button>`
    : latest && latest.aiGrade
      ? `<div class="paper-card-actions"><button class="btn primary" onclick="openPaperGradeResult('${jsA(latest.id)}')">查看紅筆批改卷</button><button class="btn" onclick="startPaperSource('${jsA(source.id)}')">${button}</button></div>`
      : `<button class="btn" onclick="startPaperSource('${jsA(source.id)}')">${button}</button>`;
  const calibration = source.calibrationEligible === false
    ? `<p class="paper-practice-note"><b>練習卷，不列入級分校準。</b>${escH(source.practiceReason || '')}</p>`
    : '<p class="paper-calibration-note">完整 20 題，可列入級分校準。</p>';
  return `<section class="paper-source-card${source.calibrationEligible === false ? ' is-practice' : ''}"><div><span class="eyebrow">私有原卷｜${source.questions} 題・${source.minutes} 分鐘</span><h3>${escH(source.title)}</h3><p>${escH(status)}</p>${calibration}<small>直接在高解析題本上作答；交卷後 GPT‑5.5 讀取整份筆跡，以紅筆圈記並批分。</small></div>${actions}</section>`;
}
function paperRunDisplayDate(run) {
  const saved = String(run && run.d || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(saved)) return saved;
  const ts = Number(run && (run.submittedAt || run.createdAt || run.mt));
  return Number.isFinite(ts) && ts > 0
    ? new Date(ts + 8 * 3600000).toISOString().slice(0, 10)
    : '';
}
function paperRunHistoryHTML() {
  const runs = (S.paperRuns || []).filter((run) => run && run.aiGrade && run.status !== 'discarded')
    .sort((a, b) => Number(b.submittedAt || b.createdAt || b.mt || 0) - Number(a.submittedAt || a.createdAt || a.mt || 0));
  const rows = runs.map((run) => {
    const source = paperSourceById(run.sourceId);
    const date = paperRunDisplayDate(run);
    const wrong = Array.isArray(run.wrongNos) ? run.wrongNos.length : Number(run.aiGrade && run.aiGrade.wrongNos && run.aiGrade.wrongNos.length) || 0;
    const due = String(run.due || '');
    const dueNow = ['awaiting-key', 'awaiting-correction'].includes(run.status) && /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= today();
    const stage = run.status === 'completed'
      ? '訂正完成'
      : dueNow
        ? '可開始隔日訂正'
        : ['awaiting-key', 'awaiting-correction'].includes(run.status)
          ? due ? `隔日訂正鎖到 ${due}` : '等待隔日訂正'
          : '第一次批改完成';
    return `<article class="paper-history-row"><div class="paper-history-date"><span>作答日期</span><time datetime="${escH(date)}">${escH(date || '日期未記錄')}</time></div>
      <div class="paper-history-main"><b>${escH(run.name || source && source.title || '原版模考')}</b><span>${Number(run.score ?? run.aiGrade.score) || 0}/100｜錯 ${wrong} 題｜${escH(stage)}</span></div>
      <div class="paper-history-actions"><button class="btn sm" onclick="openPaperGradeResult('${jsA(run.id)}')">查看紅筆卷</button><button class="btn sm" onclick="renderPaperTeacherReport('${jsA(run.id)}')">逐題紀錄</button>${dueNow ? `<button class="btn sm primary" onclick="startPaperAnswerReview('${jsA(run.id)}')">隔日訂正</button>` : ''}</div></article>`;
  }).join('');
  return `<section class="paper-history" aria-labelledby="paper-history-title"><div class="paper-history-head"><div><span class="eyebrow">自動保存日期、分數與批改結果</span><h3 id="paper-history-title">原卷作答歷史</h3></div><b>${runs.length} 回</b></div>
    ${rows ? `<div class="paper-history-list">${rows}</div>` : '<p class="paper-history-empty">完成第一次 AI 批改後，這裡會自動留下作答日期、卷別、分數與紅筆批改卷。</p>'}</section>`;
}
function renderMockIntro() {
  const n = S.mocks.length;
  const due = visionDueEntries();
  const waiting = (S.visionQueue || []).filter((x) => !x.done && x.stage === 'waiting' && String(x.due || '') > today());
  const activePaper = visionActivePaperEntries();
  const activeDone = activePaper ? activePaper.filter((x) => x.paperSeen).length : 0;
  const completedPapers = visionCompletedPaperCount();
  app().innerHTML = `
    <div class="hero compact"><h1>模考與破題</h1><p>同一批混合題，分成兩種完全不同的訓練：完整模考建立真實成績；眼睛刷題只練從題目找到第一個切入點。</p></div>
    <section class="paper-library is-primary"><div class="paper-library-head"><div><span class="eyebrow">最常用｜你提供的紙本來源</span><h2>原版模考</h2></div><p>三回保留原版內容，作答時拆成清晰單頁並可直接在題目與留白上寫。答案本已逐題核對；第二回依原卷為 19 題，其餘兩回各 20 題。</p></div>
      <div class="paper-source-grid">${PAPER_SOURCES.map(paperSourceCardHTML).join('')}</div>
      ${paperRunHistoryHTML()}
    </section>
    ${due.length ? `<div class="card next-action"><div><span class="eyebrow">第二天到期</span><h2>${due.length} 題昨天沒有方向</h2><p>今天再看一次題目。仍無方向，才開詳解。</p></div><button class="btn primary" onclick="startVisionScan('${due[0].id}')">再想一次</button></div>` : ''}
    <div class="training-choice">
    <section class="card choice-card"><span class="eyebrow">完整一回</span><h2>全真模考</h2>
      <p><b>20 題、100 分鐘、滿分 100 分</b>｜6 單選、6 多選、5 選填、3 題混合／非選擇。</p>
      <p>作答中不顯示對錯或單題速度。交卷當天只批分與列錯題號，隔天才看最終答案訂正。</p>
      <p class="dim">最後 3 題固定抽取同一組共享情境的混合題組，保留 3、4、8 分的連動小題結構。已完成 ${n} 次系統模考。</p>
      <div class="actr"><button class="btn primary big" onclick="startMock()">開始一整回（100:00）</button></div>
    </section>
    <section class="card choice-card"><span class="eyebrow">完整一回，不計算</span><h2>用眼睛刷題</h2>
      <p><b>20 題完整學測結構</b>｜6 單選、6 多選、5 選填、3 題共享題幹混合題組。逐題只寫破題方向，不展開計算。</p>
      <p>有方向就對照詳解判斷這條路是否成立；一眼就會可略過；完全沒方向則留下所屬單元／觀念，隔天再給它一次機會。</p>
      <p class="dim">已完成 ${completedPapers} 整回｜等待明天 ${waiting.length} 題｜今天到期 ${due.length} 題</p>
      <div class="actr"><button class="btn primary big" onclick="startVisionScan()">${activePaper ? `繼續本回（${activeDone}/20）` : '開始一整回（20 題）'}</button></div>
    </section></div>`;
}

/* ═══════════ 用眼睛刷題：第一天無方向就圈起來，第二天才可看詳解 ═══════════ */
let vision = null;
function visionTopicOptions(selected) {
  return `<option value="">選一個可能單元</option>${Object.keys(TOPICS).map((k) => `<option value="${k}"${selected === k ? ' selected' : ''}>${escH(TOPICS[k])}</option>`).join('')}`;
}
function visionPaperGroups() {
  const groups = new Map();
  for (const entry of S.visionQueue || []) {
    if (!entry || !entry.paperId) continue;
    if (!groups.has(entry.paperId)) groups.set(entry.paperId, []);
    groups.get(entry.paperId).push(entry);
  }
  return [...groups.values()].map((entries) => entries.sort((a, b) => Number(a.paperIndex || 0) - Number(b.paperIndex || 0)))
    .sort((a, b) => Number(a[0] && a[0].paperTs || 0) - Number(b[0] && b[0].paperTs || 0));
}
function visionActivePaperEntries() {
  return visionPaperGroups().find((entries) => entries.some((x) => !x.paperSeen)) || null;
}
function visionCompletedPaperCount() {
  return visionPaperGroups().filter((entries) => entries.length === MOCK_SPEC.total && entries.every((x) => x.paperSeen)).length;
}
function visionQuestionFromEntry(entry) {
  const base = bankById(entry.qid);
  return base ? { ...base, examNo: entry.examNo || null, examSection: entry.examSection || null, points: entry.points || null } : null;
}
function visionOpenEntry(entry, paperEntries, paperRun) {
  const q = visionQuestionFromEntry(entry);
  if (!q) {
    entry.done = true; entry.paperSeen = true; entry.stage = 'done'; entry.outcome = 'missing'; entry.mt = Date.now(); save();
    if (paperRun) return visionAdvancePaper(paperEntries);
    renderMockIntro(); return;
  }
  vision = { entry, q, paperEntries: paperEntries || null, paperRun: !!paperRun };
  sessionActive = true; sessionMode = 'vision';
  const lastAttempt = (entry.attempts || [])[entry.attempts.length - 1];
  if (entry.stage === 'compare' && entry.solutionUnlockedAt && lastAttempt) renderVisionCompare(!!lastAttempt.hasDirection);
  else renderVisionWork();
}
function startVisionScan(entryId) {
  if (!syncGate()) return;
  if (entryId) {
    const entry = (S.visionQueue || []).find((x) => x.id === entryId && !x.done);
    if (!entry) { renderMockIntro(); return; }
    if (entry.stage === 'waiting' && String(entry.due || '') > today()) { alert(`這題要到 ${entry.due} 再想；先讓腦袋真正隔一天。`); return; }
    visionOpenEntry(entry, null, false);
    return;
  }
  let entries = visionActivePaperEntries();
  if (!entries) {
    const paper = buildPaper(true);
    if (paper.length !== MOCK_SPEC.total) { alert(`題庫目前只能組出 ${paper.length} 題，尚不足完整 20 題眼睛刷題。`); return; }
    const ts = Date.now(), paperId = `vision-paper-${ts}`;
    entries = paper.map((q, index) => ({
      id: `${paperId}-${index + 1}`, paperId, paperTs: ts, paperIndex: index,
      mixedGroupId: buildPaper.lastMixedGroupId || null,
      qid: q.id, examNo: q.examNo, examSection: q.examSection, points: q.points,
      d: today(), ts: ts + index, mt: ts, due: null, stage: 'new', attempts: [], done: false, paperSeen: false,
    }));
    S.visionQueue = S.visionQueue || []; S.visionQueue.push(...entries); save();
  }
  const entry = entries.find((x) => !x.paperSeen);
  if (!entry) { renderVisionPaperResult(entries); return; }
  visionOpenEntry(entry, entries, true);
}
function visionQuestionHTML(q) {
  return `<div class="eye-question"><div class="bk-head"><span class="bk-exam">數學Ａ</span><span class="bk-sect">${escH(sectionLabel(q))}</span></div>
    <div class="bk-item"><span class="bk-num">${q.examNo ? `${q.examNo}.` : '※'}</span><div class="bk-content">${q.stem ? `<div class="bk-stem">${rtTxt(q.stem)}</div>` : ''}${rtTxt(q.q)}${q.fig ? `<div class="qfig">${sanitizeSVG(q.fig)}</div>` : ''}${q.opts ? `<div class="eye-options">${q.opts.map((o, i) => `<p>(${i + 1}) ${rtTxt(o)}</p>`).join('')}</div>` : ''}</div></div></div>`;
}
function renderVisionWork() {
  const { entry, q } = vision;
  const prior = (entry.attempts || []).map((a, i) => `<li>第 ${i + 1} 天：${a.direction ? escH(a.direction) : `沒有方向；猜 ${escH(TOPICS[a.topic] || '未選單元')}${a.concept ? `／${escH(a.concept)}` : ''}`}</li>`).join('');
  const second = (entry.attempts || []).length > 0;
  const doneN = vision.paperRun ? vision.paperEntries.filter((x) => x.paperSeen).length : 0;
  app().innerHTML = `<div class="session-head"><span>${vision.paperRun ? `眼睛刷題整回｜第 ${q.examNo}/20 題｜${escH(sectionLabel(q))}` : `眼睛刷題｜${second ? '第二天再想' : '第一眼找方向'}`}</span><button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></div>
    ${vision.paperRun ? `<div class="vision-paper-progress" aria-label="本回進度 ${doneN} / 20"><span style="width:${doneN / 20 * 100}%"></span></div>` : ''}
    ${vision.paperRun ? `<div class="vision-paper-map" aria-label="整回 20 題導覽">${vision.paperEntries.map((item) => `<span class="${item.id === entry.id ? 'current' : item.paperSeen ? 'done' : ''}">${item.examNo}</span>`).join('')}</div>` : ''}
    <div class="vision-workspace"><section class="vision-question-pane"><div class="vision-rule"><b>今天不計算。</b>${vision.paperRun ? `本回維持學測 20 題結構，目前第 ${q.examNo} 題。` : ''}目標只有一個：說出第一步為什麼值得做，以及下一步想得到什麼。</div>
    ${visionQuestionHTML(q)}</section>
    <div class="card direction-form">
      ${prior ? `<details open><summary>上次留下的紀錄</summary><ol>${prior}</ol></details>` : ''}
      <label><b>我想到的破題方向</b><textarea id="vision-direction" rows="4" placeholder="例如：先把條件改寫成向量內積，因為題目在問垂直；接著用內積為 0 建式。"></textarea></label>
      <label>可能還有另一條路（選填）<textarea id="vision-alt" rows="2" placeholder="這不是目前主要目標，有想到再記。"></textarea></label>
      <div class="fallback-fields"><label>如果真的沒方向，至少猜所屬單元<select id="vision-topic">${visionTopicOptions('')}</select></label>
      <label>可能卡在哪個觀念<input id="vision-concept" type="text" placeholder="例如：條件機率的分母"></label></div>
      <p id="vision-msg" class="dim"></p>
      <div class="actr"><button class="btn primary big" onclick="visionSubmit(true)">我有一個方向，對照詳解</button>
      <button class="btn" onclick="visionSubmit(false)">${second ? '第二天仍沒有方向，開詳解' : '完全沒方向，圈到明天'}</button>
      ${second ? '' : '<button class="btn subtle" onclick="visionKnown()">一眼就會且很可能作對，略過</button>'}</div>
    </div></div>`;
  sessionChrome(true); scrollQuestionTop();
}
function visionReadForm() {
  return {
    direction: (($('#vision-direction') || {}).value || '').trim(),
    alternate: (($('#vision-alt') || {}).value || '').trim(),
    topic: (($('#vision-topic') || {}).value || '').trim(),
    concept: (($('#vision-concept') || {}).value || '').trim(),
  };
}
function visionSubmit(hasDirection) {
  if (!vision) return;
  const data = visionReadForm(), entry = vision.entry, priorN = (entry.attempts || []).length;
  if (hasDirection && data.direction.length < 8) { alert('請把方向寫得再具體一點：至少包含「先做什麼」以及「為什麼／想得到什麼」。'); return; }
  if (!hasDirection && !data.topic && data.concept.length < 2) { alert('即使沒有方向，也要先猜一個所屬單元，或寫下你覺得卡住的觀念。'); return; }
  entry.attempts = entry.attempts || [];
  entry.attempts.push({ d: today(), ts: Date.now(), hasDirection: !!hasDirection, ...data });
  entry.mt = Date.now();
  if (!hasDirection && priorN === 0) {
    entry.stage = 'waiting'; entry.due = addDays(today(), 1); entry.paperSeen = !!vision.paperRun; save();
    if (vision.paperRun) { visionAdvancePaper(vision.paperEntries); return; }
    sessionActive = false; sessionMode = null; sessionChrome(false); vision = null;
    app().innerHTML = `<h1>已把這題圈到明天</h1><div class="card waiting-card"><b>詳解仍鎖住</b><p>你已留下「${escH(TOPICS[data.topic] || data.concept)}」這個初步辨認。<b>${entry.due}</b> 再看同一題一次；到時仍沒有方向，才開詳解。</p>
      <div class="actr"><button class="btn" onclick="nav('mock')">回模考與破題</button><button class="btn primary" onclick="nav('home')">回今日</button></div></div>`;
    return;
  }
  entry.stage = 'compare'; entry.solutionUnlockedAt = Date.now(); save();
  renderVisionCompare(hasDirection);
}
function renderVisionCompare(hadDirection) {
  const { entry, q } = vision;
  const last = entry.attempts[entry.attempts.length - 1];
  const doneN = vision.paperRun ? vision.paperEntries.filter((x) => x.paperSeen).length : 0;
  app().innerHTML = `<div class="session-head"><span>${vision.paperRun ? `眼睛刷題整回｜第 ${q.examNo}/20 題｜方向對照` : `方向對照｜${hadDirection ? '檢查這條路' : '第二天後開詳解'}`}</span><button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></div>
    ${vision.paperRun ? `<div class="vision-paper-progress" aria-label="本回進度 ${doneN} / 20"><span style="width:${doneN / 20 * 100}%"></span></div>` : ''}
    ${visionQuestionHTML(q)}
    <div class="card your-direction"><span class="eyebrow">你先留下的內容</span><p>${last.direction ? escH(last.direction) : `沒有方向；猜測 ${escH(TOPICS[last.topic] || '')}${last.concept ? `／${escH(last.concept)}` : ''}`}</p>${last.alternate ? `<p class="dim">另一條路：${escH(last.alternate)}</p>` : ''}</div>
    <div class="card solution-compare"><span class="eyebrow">現在才看的詳解</span><div>${rtTxt(q.sol || '這題目前沒有詳解。')}</div>${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}${q.tip ? `<p class="tip">${rtTxt(q.tip)}</p>` : ''}</div>
    <div class="card"><h2>對照後，這個方向怎麼樣？</h2>
      <label>從詳解多學到的另一個方向（選填）<textarea id="vision-learned" rows="2" placeholder="只記值得帶走的切入點，不抄整篇詳解。"></textarea></label>
      <div class="actr">${hadDirection ? '<button class="btn primary" onclick="visionFinish(\'works\')">原方向成立</button><button class="btn" onclick="visionFinish(\'different\')">詳解有更好的方向</button><button class="btn" onclick="visionFinish(\'fails\')">原方向不成立</button>' : '<button class="btn primary" onclick="visionFinish(\'solution\')">已看懂詳解的切入點</button>'}</div></div>`;
  sessionChrome(true); scrollQuestionTop();
}
function visionFinish(outcome) {
  if (!vision) return;
  const { entry, q } = vision, learned = (($('#vision-learned') || {}).value || '').trim();
  entry.done = true; entry.paperSeen = entry.paperSeen || !!vision.paperRun; entry.stage = 'done'; entry.outcome = outcome; entry.learned = learned.slice(0, 500); entry.completedAt = Date.now(); entry.mt = Date.now();
  S.visionHistory = S.visionHistory || [];
  S.visionHistory.push({ id: `vision-result-${entry.id}`, paperId: entry.paperId || null, examNo: entry.examNo || null, examSection: entry.examSection || null, qid: q.id, d: today(), ts: Date.now(), outcome, days: (entry.attempts || []).length, attempts: entry.attempts, learned: entry.learned });
  save();
  if (vision.paperRun) { visionAdvancePaper(vision.paperEntries); return; }
  sessionActive = false; sessionMode = null; sessionChrome(false); vision = null;
  app().innerHTML = `<h1>這題的方向紀錄完成</h1><div class="card good"><p class="big">${outcome === 'works' ? '你的第一條路成立。' : outcome === 'different' ? '你找到一條路，也從詳解多收一條。' : outcome === 'fails' ? '你已辨認原方向為什麼走不通。' : '這題確實用了兩天，現在才收下詳解的切入點。'}</p>
    <p>今天的成果不是算出數字，而是讓「看到題目後先去哪裡」變得更容易被叫出來。</p><div class="actr"><button class="btn" onclick="nav('mock')">回入口</button><button class="btn primary" onclick="startVisionScan()">開始一整回</button></div></div>`;
}
function visionKnown() {
  if (!vision) return;
  const { entry, q } = vision;
  entry.done = true; entry.paperSeen = entry.paperSeen || !!vision.paperRun; entry.stage = 'done'; entry.outcome = 'obvious'; entry.completedAt = Date.now(); entry.mt = Date.now();
  S.visionHistory = S.visionHistory || []; S.visionHistory.push({ id: `vision-obvious-${entry.id}`, paperId: entry.paperId || null, examNo: entry.examNo || null, examSection: entry.examSection || null, qid: q.id, d: today(), ts: Date.now(), outcome: 'obvious', days: 0 });
  save();
  if (vision.paperRun) { visionAdvancePaper(vision.paperEntries); return; }
  sessionActive = false; sessionMode = null; sessionChrome(false); vision = null;
  app().innerHTML = `<h1>已略過明顯會寫的題</h1><div class="card"><p>沒有花時間展開計算，符合老師目前的優先順序。</p><div class="actr"><button class="btn" onclick="nav('mock')">回入口</button><button class="btn primary" onclick="startVisionScan()">開始一整回</button></div></div>`;
}
function visionAdvancePaper(entries) {
  const next = (entries || []).find((x) => !x.paperSeen);
  if (next) { visionOpenEntry(next, entries, true); return; }
  sessionActive = false; sessionMode = null; sessionChrome(false); vision = null;
  renderVisionPaperResult(entries || []);
}
function renderVisionPaperResult(entries) {
  const obvious = entries.filter((x) => x.outcome === 'obvious').length;
  const directions = entries.filter((x) => ['works', 'different', 'fails'].includes(x.outcome)).length;
  const waiting = entries.filter((x) => !x.done && x.stage === 'waiting').length;
  const missing = entries.filter((x) => x.outcome === 'missing').length;
  app().innerHTML = `<h1>完成一整回眼睛刷題</h1><div class="card good">
    <p class="big"><b>20 / 20 題</b>｜維持 6 單選、6 多選、5 選填、3 題共享題幹混合題組。</p>
    <div class="new-progress-grid vision-summary"><section><span>找到並對照方向</span><b>${directions}</b><small>題</small></section><section><span>一眼明顯會寫</span><b>${obvious}</b><small>題，沒有浪費時間計算</small></section><section><span>圈到明天</span><b>${waiting}</b><small>題，詳解仍鎖住</small></section></div>
    ${missing ? `<p class="warnc">有 ${missing} 題因題庫內容暫時無法取得而略過，未計入訓練成果。</p>` : ''}
    <p>這一回練的是完整考卷裡連續切換題型時，能不能替每題叫出第一個可行方向。</p>
    <div class="actr"><button class="btn" onclick="nav('mock')">回模考與破題</button><button class="btn primary" onclick="startVisionScan()">開始下一整回</button></div></div>`;
  sessionChrome(false);
}

/* ═══════════ 私有原版紙本卷：保留掃描版面、100 分鐘整回計時 ═══════════ */
const PAPER_LAYOUT_VERSION = 2;
let paperSourceSession = null;
let paperFitObserver = null;
function paperSourceById(id) { return PAPER_SOURCES.find((source) => source.id === id) || null; }
function paperRunLeft(run) {
  if (!run) return 0;
  const base = Number.isFinite(Number(run.remainingMs)) ? Number(run.remainingMs) : MOCK_SPEC.minutes * 60000;
  return Math.max(0, base - (run.resumeAt ? Date.now() - Number(run.resumeAt) : 0));
}
const PAPER_RECOVERY_HEARTBEAT_MS = 5000;
const PAPER_RECOVERY_STATE_MS = 20000;
function paperRecoveryStorageKey(runId) {
  return `${KEY}:paper-recovery:${String(runId || '').replace(/[^\w.-]/g, '_')}`;
}
function paperRecoveryRead(run) {
  if (!run) return null;
  let local = null;
  try { local = JSON.parse(localStorage.getItem(paperRecoveryStorageKey(run.id)) || 'null'); } catch (_) {}
  const state = run.paperRecovery && typeof run.paperRecovery === 'object' ? run.paperRecovery : null;
  return [local, state]
    .filter((item) => item && item.runId === run.id && !item.closed)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
}
function paperRecoveryApply(run) {
  if (!run || run.status !== 'active') return null;
  const recovery = paperRecoveryRead(run);
  if (!recovery) {
    // 舊版沒有心跳資料時，寧可保留最後一次已知剩餘時間，也不把當機後的離線時間算成考試時間。
    run.resumeAt = null;
    run.status = 'paused';
    return null;
  }
  if (Number.isFinite(Number(recovery.remainingMs))) run.remainingMs = Math.max(0, Number(recovery.remainingMs));
  if (Number.isFinite(Number(recovery.page))) run.paperPage = Math.max(0, Number(recovery.page));
  run.resumeAt = null;
  run.status = 'paused';
  run.recoveredAt = Date.now();
  run.recoveredFrom = Number(recovery.updatedAt) || null;
  return recovery;
}
function paperRecoverySnapshot(session = paperSourceSession) {
  if (!session || !session.run) return null;
  const durability = session.durability || {};
  const recoveryRunId = session.recoveryRunId || session.run.id;
  return {
    version: 1,
    runId: recoveryRunId,
    sourceId: session.source && session.source.id || session.run.sourceId,
    page: Number(session.page) || 0,
    remainingMs: session.reviewMode ? null : paperRunLeft(session.run),
    mode: session.reviewMode ? 'paper-correction' : 'paper-source',
    questionNo: session.reviewMode && paperReview ? Number(paperReview.nos[paperReview.i]) || null : null,
    updatedAt: Date.now(),
    lastLocalAt: Number(durability.localAt) || null,
    lastCloudAt: Number(durability.cloudAt) || null,
    pending: durability.pendingClientIds instanceof Set ? durability.pendingClientIds.size : 0,
    closed: false,
  };
}
function paperRecoveryWrite(forceState = false, session = paperSourceSession) {
  const recovery = paperRecoverySnapshot(session);
  if (!recovery) return null;
  try { localStorage.setItem(paperRecoveryStorageKey(recovery.runId), JSON.stringify(recovery)); } catch (_) {}
  session.recoveryHeartbeatAt = recovery.updatedAt;
  session.run.paperRecovery = recovery;
  if (forceState || recovery.updatedAt - Number(session.recoveryStateAt || 0) >= PAPER_RECOVERY_STATE_MS) {
    session.recoveryStateAt = recovery.updatedAt;
    session.run.mt = recovery.updatedAt;
    save();
  }
  return recovery;
}
function paperRecoveryHeartbeat(now = Date.now()) {
  if (!paperSourceSession || !['paper-source', 'paper-review'].includes(sessionMode)) return null;
  if (Number(now) - Number(paperSourceSession.recoveryHeartbeatAt || 0) < PAPER_RECOVERY_HEARTBEAT_MS) return null;
  return paperRecoveryWrite(false);
}
function paperRecoveryClose(run, status) {
  if (!run) return;
  try { localStorage.removeItem(paperRecoveryStorageKey(run.id)); } catch (_) {}
  run.paperRecovery = {
    ...(run.paperRecovery && typeof run.paperRecovery === 'object' ? run.paperRecovery : {}),
    version: 1, runId: run.id, sourceId: run.sourceId,
    remainingMs: Number(run.remainingMs) || 0, page: Number(run.paperPage) || 0,
    updatedAt: Date.now(), closed: true, status: status || run.status || 'closed',
  };
}
function paperActiveRun(sourceId) {
  return (S.paperRuns || []).filter((run) => run && run.sourceId === sourceId && ['active', 'paused', 'grading'].includes(run.status))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
}
function paperSourceRelease() {
  if (paperFitObserver) { paperFitObserver.disconnect(); paperFitObserver = null; }
  if (paperSourceSession && Array.isArray(paperSourceSession.urls)) {
    for (const url of new Set(paperSourceSession.urls)) try { URL.revokeObjectURL(url); } catch (_) {}
  }
  paperSourceSession = null;
}
async function paperSourceFiles(source) {
  const bucket = supa.storage.from(PAPER_SOURCE_BUCKET), urls = [], loaded = new Map();
  try {
    for (const scan of source.scans) {
      if (loaded.has(scan.file)) { urls.push(loaded.get(scan.file)); continue; }
      const { data, error } = await bucket.download(scan.file);
      if (error || !data) throw new Error((error && error.message) || `無法下載 ${scan.file}`);
      const url = URL.createObjectURL(data); loaded.set(scan.file, url); urls.push(url);
    }
    return urls;
  } catch (e) {
    for (const url of new Set(urls)) try { URL.revokeObjectURL(url); } catch (_) {}
    throw e;
  }
}
async function startPaperSource(sourceId) {
  const source = paperSourceById(sourceId);
  if (!source) return;
  if (!supa || !syncState.user) { alert('原版紙本卷存放在私有雲端；請先到「進度與設定」登入。'); return; }
  paperSourceRelease();
  let run = paperActiveRun(sourceId);
  if (!run) {
    const now = Date.now();
    run = { id: `paper-run-${now}`, sourceId, name: source.title, d: today(), createdAt: now, mt: now,
      status: 'paused', remainingMs: source.minutes * 60000, resumeAt: null, wrongNos: [], paperPage: 0,
      paperLayoutVersion: PAPER_LAYOUT_VERSION };
    S.paperRuns = S.paperRuns || []; S.paperRuns.push(run); save();
  }
  const recovered = paperRecoveryApply(run);
  if (run.paperLayoutVersion !== PAPER_LAYOUT_VERSION) {
    const legacyPage = Math.max(0, Number(run.paperPage) || 0);
    run.paperPage = legacyPage > 0 ? (legacyPage - 1) * 2 : 0;
    run.paperInkClients = {};
    run.paperLayoutVersion = PAPER_LAYOUT_VERSION;
    run.mt = Date.now(); save();
  }
  app().innerHTML = `<div class="card"><h1>正在開啟 ${escH(source.title)}</h1><p class="dim">從私有題本載入 ${source.pages} 張清晰單頁；原掃描不會放到公開網站。</p></div>`;
  try {
    const urls = await paperSourceFiles(source);
    run.paperInkClients = run.paperInkClients || {};
    for (let i = 0; i < source.scans.length; i++) {
      if (!run.paperInkClients[i]) run.paperInkClients[i] = inkClientId(`paper-${run.id}-${i}`, run.createdAt + i);
    }
    const inkPages = await paperInkLoadAll(run, source);
    run.status = run.status === 'grading' ? 'grading' : 'active';
    if (run.status === 'active') run.resumeAt = Date.now();
    run.mt = Date.now(); save();
    const savedPage = Number(run.paperPage);
    const inkColor = PAPER_INK_COLORS[run.paperInkColor] ? run.paperInkColor : 'black';
    paperSourceSession = {
      source, run, urls, inkPages,
      page: Number.isFinite(savedPage) ? savedPage : 0,
      zoom: 1,
      inkMode: 'pen',
      inkWidth: paperInkWidthValue(run.paperInkWidth),
      inkColor,
      inkUserId: syncState.user ? syncState.user.id : null,
      inkClientIds: Object.fromEntries(source.scans.map((_, page) => [page, paperInkClientFor(run, page)])),
      journalPromises: new Set(),
      journalRetry: new Map(),
      durability: {
        localAt: Number(paperInkLoadAll.lastMeta && paperInkLoadAll.lastMeta.localAt) || null,
        cloudAt: Number(paperInkLoadAll.lastMeta && paperInkLoadAll.lastMeta.cloudAt) || null,
        localError: false,
        cloudError: false,
        pendingClientIds: new Set(paperInkLoadAll.lastMeta && paperInkLoadAll.lastMeta.pendingClientIds || []),
      },
      recoveredNotice: recovered ? `已從 ${new Date(Number(recovered.updatedAt)).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 的安全點恢復` : '',
    };
    paperSourceSession.page = Math.max(0, Math.min(source.scans.length - 1, paperSourceSession.page));
    sessionActive = true; sessionMode = run.status === 'grading' ? 'paper-grade' : 'paper-source';
    if (sessionMode === 'paper-source') paperRecoveryWrite(true);
    if (run.status === 'grading' || paperRunLeft(run) <= 0) paperSourceGrade(run.status === 'grading' ? '繼續今天的批分' : '時間到');
    else renderPaperSource();
  } catch (e) {
    run.status = 'paused'; run.resumeAt = null; run.mt = Date.now(); save();
    app().innerHTML = `<div class="card warn"><h2>原卷暫時載入失敗</h2><p>${escH((e && e.message) || e)}</p><div class="actr"><button class="btn" onclick="nav('mock')">回模考與破題</button><button class="btn primary" onclick="startPaperSource('${jsA(sourceId)}')">重試</button></div></div>`;
  }
}

/* 原卷平板工作台：將高解析跨頁即時拆成清晰單頁，筆跡直接覆蓋題目與右側留白。
   每個單頁有獨立筆跡，座標以 0–1 保存，旋轉平板或換裝置後仍能對齊；
   inkrecords 與既有 ink_sessions 共用離線補傳機制，不把大型筆跡塞進 localStorage 的主狀態。 */
const paperInkSaveTimers = new Map();
// 測試接縫：paper-stability/learning-loop 測試在案例間清空排程中的保存 timer（app 內不呼叫）
function paperInkSaveTimersClearAll() {
  for (const timer of paperInkSaveTimers.values()) clearTimeout(timer);
  paperInkSaveTimers.clear();
}
let paperInkCloudTimer = null;
let paperStateSaveTimer = null;
let paperZoomPaintTimer = null;
const PAPER_ZOOM_MIN = .75;
const PAPER_ZOOM_MAX = 4;
/* A 400% zoom must not create gigabyte-sized backing stores on a high-DPR tablet.
   The CSS sheet still zooms normally; only each transparent canvas layer is capped. */
const PAPER_CANVAS_MAX_PIXELS = 12000000;
const PAPER_INK_GRID_SIZE = 40;
const PAPER_INK_DEVICE_KEY = 'mathA13_paper_device_v1';
const PAPER_INK_JOURNAL_MS = 650;
const PAPER_INK_SNAPSHOT_MS = 60000;
const PAPER_INK_CLOUD_MS = 900;
const PAPER_INK_CLOUD_PAGE_SIZE = 1000;
const PAPER_INK_WIDTH_MIN = .35;
const PAPER_INK_WIDTH_MAX = 2;
const PAPER_INK_COLORS = {
  black: '#343a36',
  blue: '#315f78',
  green: '#4f7158',
};
const PAPER_AI_RED = '#b43b32';
function paperInkQid(run, page) { return `paper:${run.id}:v${PAPER_LAYOUT_VERSION}:${page}`; }
function paperReviewInkRun(run) {
  const createdAt = Number(run && (run.submittedAt || run.createdAt)) || Date.now();
  return {
    id: `${run && run.id || 'paper'}-correction`,
    sourceId: run && run.sourceId,
    name: `${run && run.name || '原版模考'}隔日訂正`,
    d: run && (run.due || run.d) || today(),
    createdAt,
    mt: Number(run && run.mt) || createdAt,
    remainingMs: 0,
    resumeAt: null,
  };
}
function paperInkStorageRun(session = paperSourceSession) {
  return session && (session.inkRun || session.run);
}
function paperInkDeviceId() {
  try {
    let id = localStorage.getItem(PAPER_INK_DEVICE_KEY);
    if (id) return id;
    id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    id = String(id).replace(/[^\w.-]/g, '_');
    localStorage.setItem(PAPER_INK_DEVICE_KEY, id);
    return id;
  } catch (_) {
    return 'device-fallback';
  }
}
function paperInkClientFor(run, page) {
  return `ink-paper-${String(run.id || 'run').replace(/[^\w.-]/g, '_')}-${Number(page) || 0}-${paperInkDeviceId()}`;
}
function paperInkStrokeId(stroke) {
  if (!stroke) return '';
  if (stroke.id) return String(stroke.id);
  const pts = Array.isArray(stroke.pts) ? stroke.pts : [];
  const first = pts[0] || [], last = pts[pts.length - 1] || [];
  const coord = (value) => Math.round((Number(value) || 0) * 100000);
  stroke.id = `legacy-${Number(stroke.t0) || 0}-${pts.length}-${coord(first[0])}-${coord(first[1])}-${coord(last[0])}-${coord(last[1])}-${stroke.c || 'black'}`;
  return stroke.id;
}
function paperInkMergePayloads(payloads) {
  const strokes = new Map(), deleted = new Set();
  for (const payload of payloads || []) {
    for (const id of payload && Array.isArray(payload.deleted) ? payload.deleted : []) if (id) deleted.add(String(id));
    for (const stroke of payload && Array.isArray(payload.s) ? payload.s : []) {
      if (!stroke) continue;
      const id = paperInkStrokeId(stroke);
      if (stroke.dead) deleted.add(id);
      const old = strokes.get(id);
      if (!old || Number(stroke.t1 || stroke.t0 || 0) >= Number(old.t1 || old.t0 || 0)) strokes.set(id, stroke);
    }
  }
  for (const id of deleted) strokes.delete(id);
  return {
    s: [...strokes.values()].sort((a, b) => Number(a.t0 || 0) - Number(b.t0 || 0)),
    deleted: [...deleted],
  };
}
function paperInkRowUpdatedAt(row) {
  return Date.parse(row && (row.updated_at || row.created_at) || '')
    || Number(row && (row.updatedAt || row.t0) || 0);
}
async function paperInkCloudRows(runId) {
  if (!supa || !syncState.user) return [];
  const out = [];
  let from = 0;
  while (true) {
    let query = supa.from('ink_sessions')
      .select('client_id,qid,t0,proc,strokes,created_at,updated_at')
      .like('qid', `paper:${runId}:%`);
    const canPage = query && typeof query.range === 'function';
    if (query && typeof query.order === 'function') query = query.order('updated_at', { ascending: true });
    if (canPage) query = query.range(from, from + PAPER_INK_CLOUD_PAGE_SIZE - 1);
    let { data, error } = await query;
    if (error && /updated_at/i.test(String(error.message || ''))) {
      query = supa.from('ink_sessions')
        .select('client_id,qid,t0,proc,strokes,created_at')
        .like('qid', `paper:${runId}:%`);
      if (canPage && query && typeof query.range === 'function') query = query.range(from, from + PAPER_INK_CLOUD_PAGE_SIZE - 1);
      ({ data, error } = await query);
    }
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    out.push(...rows);
    if (!canPage || rows.length < PAPER_INK_CLOUD_PAGE_SIZE) break;
    from += PAPER_INK_CLOUD_PAGE_SIZE;
  }
  return out;
}
async function paperInkLoadAll(run, source) {
  const pages = {};
  const qids = source.scans.map((_, page) => paperInkQid(run, page));
  let local = [];
  try {
    const groups = await Promise.all(qids.map((qid) => inkRecordByQid(qid)));
    local = groups.flat().filter(inkRecordVisibleToCurrentUser);
  } catch (_) {}
  let cloud = [];
  if (supa && syncState.user) {
    try { cloud = await paperInkCloudRows(run.id); } catch (_) {}
  }
  const pendingClientIds = new Set(local.filter((row) => row && !row.uploaded).map((row) => row.client_id));
  let localAt = local.reduce((max, row) => Math.max(max, Number(row && row.updatedAt) || 0), 0);
  const cloudAt = cloud.reduce((max, row) => Math.max(max, paperInkRowUpdatedAt(row)), 0);
  for (let page = 0; page < source.scans.length; page++) {
    const qid = paperInkQid(run, page);
    const localRows = local.filter((row) => row && row.qid === qid)
      .sort((a, b) => Number(b.updatedAt || b.t0 || 0) - Number(a.updatedAt || a.t0 || 0));
    const cloudRows = cloud.filter((row) => row && row.qid === qid)
      .sort((a, b) => paperInkRowUpdatedAt(b) - paperInkRowUpdatedAt(a));
    const byClient = new Map();
    for (const row of [...cloudRows, ...localRows]) {
      if (!row || !row.client_id) continue;
      const old = byClient.get(row.client_id);
      if (!old || paperInkRowUpdatedAt(row) >= paperInkRowUpdatedAt(old)) byClient.set(row.client_id, row);
    }
    const rows = [...byClient.values()];
    const merged = paperInkMergePayloads(rows.map((row) => row.strokes));
    pages[page] = {
      s: merged.s,
      deleted: new Set(merged.deleted),
      loaded: true, revision: 0, persistedRevision: 0, dirty: false,
    };
    const localClients = new Set(localRows.map((row) => row.client_id));
    for (const row of cloudRows) if (row && row.client_id && !localClients.has(row.client_id)) {
      inkRecordPut({ ...row, user_id: syncState.user ? syncState.user.id : null, uploaded: true })
        .then((stored) => { localAt = Math.max(localAt, Number(stored.updatedAt) || 0); }).catch(() => {});
    }
  }
  paperInkLoadAll.lastMeta = { pendingClientIds: [...pendingClientIds], localAt, cloudAt };
  return pages;
}
function paperInkPage(page) {
  if (!paperSourceSession) return null;
  paperSourceSession.inkPages = paperSourceSession.inkPages || {};
  const index = page == null ? (Number(paperSourceSession.page) || 0) : page;
  return (paperSourceSession.inkPages[index] = paperSourceSession.inkPages[index]
    || { s: [], deleted:new Set(), loaded: true, revision: 0, persistedRevision: 0, dirty: false });
}
function paperInkCloneStroke(stroke) {
  return {
    id: paperInkStrokeId(stroke),
    t0: Number(stroke.t0) || Date.now(),
    t1: Number(stroke.t1) || null,
    w: paperInkWidthValue(stroke.w),
    c: PAPER_INK_COLORS[stroke.c] ? stroke.c : 'black',
    pts: (stroke.pts || []).map((point) => [
      Number(point[0]) || 0,
      Number(point[1]) || 0,
      Number(point[2]) || .5,
    ]),
  };
}
function paperInkEventClientFor(run, pageIndex, kind, id) {
  const safe = (value) => String(value || '').replace(/[^\w.-]/g, '_').slice(-96);
  return `ink-paper-event-${safe(run && run.id)}-${Number(pageIndex) || 0}-${safe(paperInkDeviceId())}-${safe(kind)}-${safe(id)}`;
}
function paperInkStatusText(session = paperSourceSession) {
  if (paperInkGestureIsTemporaryErase()) return 'S Pen 側鍵按住：暫時橡皮擦';
  if (!session || !session.durability) return '筆跡自動保存';
  const durability = session.durability;
  if (durability.localError) return '本機保存失敗，正在重試；請勿關閉';
  const pending = durability.pendingClientIds instanceof Set ? durability.pendingClientIds.size : 0;
  if (pending) return typeof navigator !== 'undefined' && navigator.onLine === false
    ? `已存在本機，等待網路（${pending}）`
    : `已存在本機，雲端同步中（${pending}）`;
  if (durability.cloudAt) return '本機與雲端已同步';
  if (durability.localAt) return '已安全保存在本機';
  return '啟用當機保護';
}
function paperInkStatusRender(session = paperSourceSession) {
  const status = $('#paper-ink-status');
  if (!status || !session || paperSourceSession !== session) return;
  const durability = session.durability || {};
  status.textContent = paperInkStatusText(session);
  if (status.dataset) {
    status.dataset.state = durability.localError ? 'error'
      : durability.pendingClientIds instanceof Set && durability.pendingClientIds.size ? 'pending'
        : durability.cloudAt ? 'synced' : 'local';
  }
}
function paperInkCloudSchedule() {
  if (paperInkCloudTimer != null) return;
  paperInkCloudTimer = setTimeout(() => {
    paperInkCloudTimer = null;
    if (syncState.user) flushInkQueue();
  }, PAPER_INK_CLOUD_MS);
  if (paperInkCloudTimer && typeof paperInkCloudTimer.unref === 'function') paperInkCloudTimer.unref();
}
function paperInkLocalStored(record, session = paperSourceSession) {
  if (!session || !session.durability || !record) return;
  session.durability.localAt = Math.max(Number(session.durability.localAt) || 0, Number(record.updatedAt) || Date.now());
  session.durability.localError = false;
  if (!record.uploaded) session.durability.pendingClientIds.add(record.client_id);
  paperInkStatusRender(session);
  paperRecoveryWrite(false, session);
  paperInkCloudSchedule();
}
function paperInkCloudStored(clientIds, at = Date.now(), session = paperSourceSession) {
  if (!session || !session.durability) return;
  for (const id of clientIds || []) session.durability.pendingClientIds.delete(id);
  session.durability.cloudAt = Math.max(Number(session.durability.cloudAt) || 0, Number(at) || Date.now());
  session.durability.cloudError = false;
  paperInkStatusRender(session);
}
function paperInkJournalRetrySchedule(session = paperSourceSession) {
  if (!session || session.journalRetryTimer || !(session.journalRetry instanceof Map) || !session.journalRetry.size) return;
  session.journalRetryTimer = setTimeout(() => {
    session.journalRetryTimer = null;
    paperInkJournalRetryNow(session);
  }, 1200);
  if (session.journalRetryTimer && typeof session.journalRetryTimer.unref === 'function') session.journalRetryTimer.unref();
}
async function paperInkJournalRecord(record, session = paperSourceSession) {
  if (!session || !record) return false;
  try {
    const stored = await inkRecordPut(record);
    if (session.journalRetry instanceof Map) session.journalRetry.delete(record.client_id);
    paperInkLocalStored(stored, session);
    return true;
  } catch (_) {
    session.durability = session.durability || { pendingClientIds: new Set() };
    session.durability.localError = true;
    session.journalRetry = session.journalRetry instanceof Map ? session.journalRetry : new Map();
    session.journalRetry.set(record.client_id, record);
    statePersistErr = true;
    paperInkStatusRender(session);
    paperInkJournalRetrySchedule(session);
    return false;
  }
}
async function paperInkJournalRetryNow(session = paperSourceSession) {
  if (!session || !(session.journalRetry instanceof Map) || !session.journalRetry.size) return true;
  const records = [...session.journalRetry.values()];
  const results = await Promise.all(records.map((record) => paperInkJournalRecord(record, session)));
  if (session.journalRetry.size) paperInkJournalRetrySchedule(session);
  return results.every(Boolean);
}
function paperInkTrackJournal(promise, session = paperSourceSession) {
  if (!session) return promise;
  session.journalPromises = session.journalPromises instanceof Set ? session.journalPromises : new Set();
  session.journalPromises.add(promise);
  promise.finally(() => session.journalPromises.delete(promise)).catch(() => {});
  return promise;
}
function paperInkJournalStroke(stroke, final = false, session = paperSourceSession) {
  if (!session || !session.run || !stroke || !Array.isArray(stroke.pts) || stroke.pts.length < 2) return Promise.resolve(false);
  const pageIndex = Number(session.page) || 0;
  const storageRun = paperInkStorageRun(session);
  if (!stroke._journalClientId) {
    stroke._journalClientId = paperInkEventClientFor(storageRun, pageIndex, 'stroke', paperInkStrokeId(stroke));
  }
  const captured = paperInkCloneStroke(stroke);
  if (final) captured.t1 = Number(stroke.t1) || Date.now();
  const record = {
    client_id: stroke._journalClientId,
    user_id: session.inkUserId || (syncState.user ? syncState.user.id : null),
    qid: paperInkQid(storageRun, pageIndex),
    t0: Number(stroke.t0) || Date.now(),
    proc: { overlay: true, mode: session.reviewMode ? 'paper-correction' : 'paper-source', page: pageIndex, event: 'stroke', draft: !final },
    strokes: { paper: true, event: true, s: [captured], deleted: [] },
    uploaded: false,
  };
  const previous = stroke._journalPromise || Promise.resolve();
  const task = previous.catch(() => {}).then(() => paperInkJournalRecord(record, session));
  stroke._journalPromise = task;
  return paperInkTrackJournal(task, session);
}
function paperInkJournalDeleted(ids, session = paperSourceSession) {
  const deleted = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!session || !session.run || !deleted.length) return Promise.resolve(false);
  const pageIndex = Number(session.page) || 0;
  const storageRun = paperInkStorageRun(session);
  const eventId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const record = {
    client_id: paperInkEventClientFor(storageRun, pageIndex, 'delete', eventId),
    user_id: session.inkUserId || (syncState.user ? syncState.user.id : null),
    qid: paperInkQid(storageRun, pageIndex),
    t0: Date.now(),
    proc: { overlay: true, mode: session.reviewMode ? 'paper-correction' : 'paper-source', page: pageIndex, event: 'delete' },
    strokes: { paper: true, event: true, s: [], deleted },
    uploaded: false,
  };
  return paperInkTrackJournal(paperInkJournalRecord(record, session), session);
}
async function paperInkJournalDrain(session = paperSourceSession) {
  if (!session) return true;
  await paperInkJournalRetryNow(session);
  const pending = session.journalPromises instanceof Set ? [...session.journalPromises] : [];
  if (pending.length) await Promise.allSettled(pending);
  if (session.journalRetry instanceof Map && session.journalRetry.size) await paperInkJournalRetryNow(session);
  return !(session.journalRetry instanceof Map) || session.journalRetry.size === 0;
}
function paperInkCompact(data) {
  if (!data || !Array.isArray(data.s)) return [];
  data.deleted = data.deleted instanceof Set ? data.deleted : new Set(data.deleted || []);
  for (const stroke of data.s) if (stroke && stroke.dead) data.deleted.add(paperInkStrokeId(stroke));
  const live = data.s.filter((stroke) => stroke && !stroke.dead && Array.isArray(stroke.pts) && stroke.pts.length > 1);
  if (live.length !== data.s.length) {
    data.s = live;
    data.spatial = null;
  }
  return live;
}
function paperInkSnapshot(data, pageIndex, session = paperSourceSession) {
  const strokes = paperInkCompact(data).map(paperInkCloneStroke);
  const current = session && Number(session.page) === Number(pageIndex) ? session.inkCurrent : null;
  if (current && Array.isArray(current.pts) && current.pts.length > 1) strokes.push(paperInkCloneStroke(current));
  return strokes;
}
function paperInkSaveKey(session, pageIndex) {
  const run = paperInkStorageRun(session);
  return `${run && run.id || 'paper'}:${Number(pageIndex) || 0}`;
}
function paperInkSaveTimerClear(session, pageIndex) {
  const key = paperInkSaveKey(session, pageIndex);
  const timer = paperInkSaveTimers.get(key);
  if (timer != null) clearTimeout(timer);
  paperInkSaveTimers.delete(key);
}
function paperInkScheduleRetry(pageIndex, data, session = paperSourceSession) {
  if (!session || !data || session.inkPages[pageIndex] !== data) return;
  const key = paperInkSaveKey(session, pageIndex);
  if (paperInkSaveTimers.has(key)) return;
  const delay = Math.min(30000, 1200 * (2 ** Math.min(5, Math.max(0, Number(data.persistFailures) - 1))));
  const timer = setTimeout(() => {
    if (paperInkSaveTimers.get(key) === timer) paperInkSaveTimers.delete(key);
    paperInkPersistPage(pageIndex, data, false, session);
  }, delay);
  paperInkSaveTimers.set(key, timer);
  // Node 測試環境的 Timeout 支援 unref；瀏覽器回傳數字、正式自動重試不受影響。
  if (timer && typeof timer.unref === 'function') timer.unref();
}
async function paperInkPersistPage(pageIndex, data, force, session = paperSourceSession) {
  if (!session || !data || !session.run) return false;
  const run = paperInkStorageRun(session);
  if (data.persistPromise) {
    try { await data.persistPromise; } catch (_) {}
  }
  let wrote = false;
  do {
    if (!data.dirty && !force) return wrote;
    const revision = Number(data.revision) || 0;
    const record = {
      client_id: session.inkClientIds[pageIndex],
      user_id: session.inkUserId || (syncState.user ? syncState.user.id : null),
      qid: paperInkQid(run, pageIndex),
      t0: Number(run.createdAt) + pageIndex,
      proc: { overlay: true, mode: session.reviewMode ? 'paper-correction' : 'paper-source', page: pageIndex, revision },
      strokes: {
        paper: true, revision,
        s: paperInkSnapshot(data, pageIndex, session),
        deleted: [...(data.deleted instanceof Set ? data.deleted : new Set(data.deleted || []))],
      },
      uploaded: false,
    };
    const request = inkRecordPut(record);
    data.persistPromise = request;
    try {
      const stored = await request;
      wrote = true;
      data.persistedRevision = Math.max(Number(data.persistedRevision) || 0, revision);
      data.dirty = Number(data.revision) > revision;
      data.persistFailures = 0;
      statePersistErr = false;
      paperInkLocalStored(stored, session);
    } catch (_) {
      data.dirty = true;
      data.persistFailures = (Number(data.persistFailures) || 0) + 1;
      statePersistErr = true;
      if (session.durability) session.durability.localError = true;
      paperInkStatusRender(session);
      paperInkScheduleRetry(pageIndex, data, session);
      return false;
    } finally {
      if (data.persistPromise === request) data.persistPromise = null;
    }
    force = force && data.dirty;
  } while (force);
  return wrote;
}
function paperInkPersist(force) {
  if (!paperSourceSession) return Promise.resolve(false);
  const session = paperSourceSession;
  const page = session.page, run = paperInkStorageRun(session);
  const data = paperInkPage(page);
  if (!data) return Promise.resolve(false);
  const pageIndex = Number(page) || 0;
  paperSourceSession.inkClientIds = paperSourceSession.inkClientIds || {};
  if (!paperSourceSession.inkClientIds[pageIndex]) paperSourceSession.inkClientIds[pageIndex] = paperInkClientFor(run, pageIndex);
  if (!data.dirty && !force) return Promise.resolve(false);
  if (force) {
    paperInkSaveTimerClear(session, pageIndex);
    return paperInkPersistPage(pageIndex, data, true, session);
  }
  const key = paperInkSaveKey(session, pageIndex);
  if (!paperInkSaveTimers.has(key)) {
    const timer = setTimeout(() => {
      if (paperInkSaveTimers.get(key) === timer) paperInkSaveTimers.delete(key);
      paperInkPersistPage(pageIndex, data, false, session);
    }, PAPER_INK_SNAPSHOT_MS);
    paperInkSaveTimers.set(key, timer);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  paperInkStatusRender(session);
  return Promise.resolve(true);
}
function paperInkMarkDirty() {
  const page = paperInkPage(); if (!page) return;
  page.revision = (Number(page.revision) || 0) + 1;
  page.dirty = true;
  paperInkPersist(false);
}
function paperInkCheckpointCurrent(now) {
  if (!paperSourceSession || !paperSourceSession.inkCurrent || paperSourceSession.inkCurrent.pts.length < 2) return false;
  const at = Number(now) || Date.now();
  if (at - Number(paperSourceSession.inkCheckpointAt || 0) < PAPER_INK_JOURNAL_MS) return false;
  paperSourceSession.inkCheckpointAt = at;
  paperInkJournalStroke(paperSourceSession.inkCurrent, false);
  return true;
}
function paperInkLine(ctx, stroke, width, height, colorOverride) {
  if (!stroke || stroke.dead || !Array.isArray(stroke.pts) || stroke.pts.length < 2) return;
  ctx.strokeStyle = colorOverride || PAPER_INK_COLORS[stroke.c] || PAPER_INK_COLORS.black;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const pressure = Number(stroke.pts.reduce((sum, p) => sum + (Number(p[2]) || .5), 0) / stroke.pts.length);
  ctx.lineWidth = (1.35 + Math.max(.15, pressure) * 1.5) * paperInkWidthValue(stroke.w);
  ctx.beginPath(); ctx.moveTo(stroke.pts[0][0] * width, stroke.pts[0][1] * height);
  for (let i = 1; i < stroke.pts.length; i++) ctx.lineTo(stroke.pts[i][0] * width, stroke.pts[i][1] * height);
  ctx.stroke();
}
function paperCanvasBackingScale(width, height) {
  const dpr = Math.max(.5, Number(window.devicePixelRatio) || 1);
  const limited = Math.sqrt(PAPER_CANVAS_MAX_PIXELS / Math.max(1, width * height));
  return Math.max(.35, Math.min(dpr, limited));
}
function paperCanvasPrepare(cv, forcedScale) {
  const width = Number(cv.clientWidth) || Number(cv.width) || 1;
  const height = Number(cv.clientHeight) || Number(cv.height) || 1;
  const scale = Number(forcedScale) > 0 ? Number(forcedScale) : paperCanvasBackingScale(width, height);
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  const resized = cv.width !== pixelWidth || cv.height !== pixelHeight;
  if (resized) { cv.width = pixelWidth; cv.height = pixelHeight; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { ctx, width, height, scale, resized };
}
function paperInkStrokeRange(ctx, stroke, width, height, fromIndex) {
  if (!stroke || stroke.dead || !Array.isArray(stroke.pts) || stroke.pts.length < 2) return;
  const start = Math.max(1, Number(fromIndex) || 1);
  if (start >= stroke.pts.length) return;
  const range = stroke.pts.slice(Math.max(0, start - 1));
  const pressure = Number(range.reduce((sum, p) => sum + (Number(p[2]) || .5), 0) / Math.max(1, range.length));
  ctx.strokeStyle = PAPER_INK_COLORS[stroke.c] || PAPER_INK_COLORS.black;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = (1.35 + Math.max(.15, pressure) * 1.5) * paperInkWidthValue(stroke.w);
  ctx.beginPath();
  ctx.moveTo(stroke.pts[start - 1][0] * width, stroke.pts[start - 1][1] * height);
  for (let i = start; i < stroke.pts.length; i++) ctx.lineTo(stroke.pts[i][0] * width, stroke.pts[i][1] * height);
  ctx.stroke();
}
function paperInkPaintCurrent(fromIndex) {
  const cv = $('#paper-ink-canvas'), stroke = paperSourceSession && paperSourceSession.inkCurrent;
  if (!cv || !stroke || !cv.clientWidth || !cv.clientHeight) return;
  const prepared = paperCanvasPrepare(cv);
  if (prepared.resized) { paperInkPaint(); return; }
  paperInkStrokeRange(prepared.ctx, stroke, prepared.width, prepared.height, fromIndex);
}
function paperInkPaint() {
  const cv = $('#paper-ink-canvas'), data = paperInkPage();
  if (!cv || !data || !cv.clientWidth || !cv.clientHeight) return;
  const { ctx, width, height } = paperCanvasPrepare(cv);
  ctx.clearRect(0, 0, width, height);
  for (const stroke of data.s) paperInkLine(ctx, stroke, width, height);
  if (paperSourceSession.inkCurrent) paperInkLine(ctx, paperSourceSession.inkCurrent, width, height);
  paperBaseInkPaint();
  paperAiPaint();
}
function paperBaseInkPaint() {
  const cv = $('#paper-base-ink-canvas'), session = paperSourceSession;
  if (!cv || !session || !session.baseInkPages || !cv.clientWidth || !cv.clientHeight) return;
  const data = session.baseInkPages[Number(session.page) || 0];
  const { ctx, width, height } = paperCanvasPrepare(cv);
  ctx.clearRect(0, 0, width, height);
  for (const stroke of data && Array.isArray(data.s) ? data.s : []) paperInkLine(ctx, stroke, width, height);
}
function paperAiPageQuestions(page) {
  const result = paperSourceSession && paperSourceSession.run && paperSourceSession.run.aiGrade;
  return result && Array.isArray(result.questions)
    ? result.questions.filter((item) => Number(item && item.page) === Number(page) + 1)
    : [];
}
function paperAiPaintCanvas(cv, questions, includeAnswer, forcedScale) {
  if (!cv || !(Number(cv.clientWidth) || Number(cv.width)) || !(Number(cv.clientHeight) || Number(cv.height))) return;
  const { ctx, width, height } = paperCanvasPrepare(cv, forcedScale);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = PAPER_AI_RED;
  ctx.fillStyle = PAPER_AI_RED;
  ctx.lineWidth = Math.max(2, width / 520);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const baseSize = Math.max(14, Math.min(25, width / 46));
  const summaryRail = { left:width * .765, right:width * .974 };
  const summaryFont = Math.max(11, Math.min(18, width / 62));
  let summaryRailBottom = 0;
  const teacherText = (text, x, y, size, limits) => {
    let label = String(text || '').slice(0, 46);
    if (!label) return;
    let fontSize = size || baseSize;
    const minX = limits ? Number(limits.left) : 4;
    const maxX = limits ? Number(limits.right) : width - 4;
    const available = Math.max(20, maxX - minX);
    ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    let metrics = ctx.measureText(label);
    while (metrics.width > available && fontSize > 10) {
      fontSize--;
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      metrics = ctx.measureText(label);
    }
    while (metrics.width > available && label.length > 3) {
      label = label.slice(0, -2).trimEnd() + '…';
      metrics = ctx.measureText(label);
    }
    const tx = Math.max(minX, Math.min(maxX - metrics.width, x));
    const ty = Math.max(fontSize + 3, Math.min(height - 4, y));
    if (typeof ctx.save === 'function') ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, fontSize * .24);
    ctx.strokeStyle = 'rgba(255,253,248,.94)';
    if (typeof ctx.strokeText === 'function') ctx.strokeText(label, tx, ty);
    ctx.fillStyle = PAPER_AI_RED;
    ctx.fillText(label, tx, ty);
    if (typeof ctx.restore === 'function') ctx.restore();
    ctx.strokeStyle = PAPER_AI_RED;
    ctx.fillStyle = PAPER_AI_RED;
    return { x:tx, y:ty, width:metrics.width, fontSize, label };
  };
  const teacherCheck = (x, y, size) => {
    ctx.beginPath();
    ctx.moveTo(x - size * .46, y);
    ctx.lineTo(x - size * .12, y + size * .34);
    ctx.lineTo(x + size * .52, y - size * .42);
    ctx.stroke();
  };
  const teacherCross = (x, y, size) => {
    ctx.beginPath();
    ctx.moveTo(x - size * .42, y - size * .42);
    ctx.lineTo(x + size * .42, y + size * .42);
    ctx.moveTo(x + size * .42, y - size * .42);
    ctx.lineTo(x - size * .42, y + size * .42);
    ctx.stroke();
  };
  for (const item of questions || []) {
    let summaryAnchor = null;
    for (const mark of Array.isArray(item.marks) ? item.marks : []) {
      const box = Array.isArray(mark && mark.box) ? mark.box.map(Number) : [];
      if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) continue;
      const left = Math.max(0, Math.min(1, Math.min(box[0], box[2]))) * width;
      const top = Math.max(0, Math.min(1, Math.min(box[1], box[3]))) * height;
      const right = Math.max(0, Math.min(1, Math.max(box[0], box[2]))) * width;
      const bottom = Math.max(0, Math.min(1, Math.max(box[1], box[3]))) * height;
      const kind = String(mark.kind || (item.status === 'correct' ? 'check'
        : item.status === 'incorrect' && Number(item.points) > 0 ? 'partial'
        : item.status === 'incorrect' ? 'cross'
        : item.status === 'unanswered' ? 'unanswered'
        : item.status === 'uncertain' ? 'uncertain' : ''));
      if (!kind) {
        ctx.strokeRect(left, top, Math.max(8, right - left), Math.max(8, bottom - top));
        const legacyLabel = String(mark.label || '').slice(0, 16);
        if (legacyLabel) teacherText(legacyLabel, left, top >= baseSize + 8 ? top - 5 : bottom + baseSize + 4);
        continue;
      }
      const symbolSize = Math.max(12, Math.min(24, width / 48));
      const symbolX = Math.max(symbolSize * .6, Math.min(width - symbolSize * .6, (left + right) / 2));
      const symbolY = Math.max(symbolSize * .6, Math.min(height - symbolSize * .6, (top + bottom) / 2));
      if (kind === 'check') {
        teacherCheck(symbolX, symbolY, symbolSize);
      } else if (kind === 'cross') {
        teacherCross(symbolX, symbolY, symbolSize);
      } else if (kind === 'strike') {
        ctx.beginPath();
        ctx.moveTo(Math.max(2, left - 3), (top + bottom) / 2);
        ctx.lineTo(Math.min(width - 2, right + 3), (top + bottom) / 2);
        ctx.stroke();
      } else if (kind === 'add') {
        const option = Number(mark.option);
        if (left >= summaryRail.left) {
          teacherText(option >= 1 && option <= 5 ? `+(${option})` : String(mark.label || ''), left,
            Math.max(top + summaryFont, (top + bottom) / 2 + summaryFont * .42), summaryFont,
            summaryRail);
        } else {
          teacherCheck(symbolX, symbolY, symbolSize * .78);
        }
      }
      if (!summaryAnchor || kind === 'cross' || kind === 'strike' || kind === 'add' || kind === 'partial') {
        summaryAnchor = { y:Math.max(summaryFont + 3, symbolY) };
      }
    }
    if (summaryAnchor && item.status) {
      const points = Number(item.points) || 0;
      const storedAnswer = item.answer || (includeAnswer && paperSourceSession && paperSourceSession.source
        ? paperFinalAnswerText(paperSourceSession.source.key[Number(item.no) - 1]) : '');
      let summary = `第 ${Number(item.no) || '?'} 題　` + (item.status === 'correct' ? `✓ +${points}`
        : item.status === 'incorrect' && points > 0 ? `△ +${points}`
        : item.status === 'incorrect' ? '✕ 0'
        : item.status === 'unanswered' ? '未答 0' : '看不清楚 0');
      const lines = [summary];
      if (includeAnswer && item.status !== 'correct' && storedAnswer) {
        lines.push(`正解 ${String(storedAnswer).slice(0, 26)}`);
      }
      const lineHeight = summaryFont + 5;
      const maximumFirstLine = Math.max(summaryFont + 3, height - 5 - (lines.length - 1) * lineHeight);
      let firstLine = Math.max(summaryFont + 3, summaryAnchor.y, summaryRailBottom + summaryFont + 7);
      firstLine = Math.min(maximumFirstLine, firstLine);
      lines.forEach((line, index) => teacherText(line, summaryRail.left, firstLine + index * lineHeight,
        summaryFont, summaryRail));
      summaryRailBottom = firstLine + (lines.length - 1) * lineHeight + 4;
    }
  }
}
function paperAiPaint() {
  if (!paperSourceSession) return;
  const canvas = $('#paper-ai-canvas');
  if (paperSourceSession.aiMarksHidden) {
    if (canvas && (Number(canvas.clientWidth) || Number(canvas.width)) && (Number(canvas.clientHeight) || Number(canvas.height))) {
      const prepared = paperCanvasPrepare(canvas);
      prepared.ctx.clearRect(0, 0, prepared.width, prepared.height);
    }
    return;
  }
  const page = Number(paperSourceSession.page) || 0;
  const questions = paperAiPageQuestions(page).slice();
  if (paperSourceSession.reviewMode && paperSourceSession.run && paperSourceSession.run.review) {
    for (const [noText, state] of Object.entries(paperSourceSession.run.review)) {
      const no = Number(noText), grade = state && state.correctionGrade;
      if (!grade || paperQuestionScanIndex(paperSourceSession.source, no) !== page) continue;
      questions.push({
        no,
        page: page + 1,
        status: grade.correct ? 'correct' : grade.uncertain ? 'uncertain' : 'incorrect',
        points: grade.correct ? Number(paperSourceSession.source.key[no - 1] && paperSourceSession.source.key[no - 1].points) || 0 : 0,
        answer: paperFinalAnswerText(paperSourceSession.source.key[no - 1]),
        marks: grade.marks || [],
      });
    }
  }
  paperAiPaintCanvas(canvas, questions, true);
}
function paperAiToggleButtonHTML() {
  const hidden = !!(paperSourceSession && paperSourceSession.aiMarksHidden);
  return `<button id='paper-ai-toggle' class='paper-ai-toggle-button' onclick='paperAiMarksToggle()' aria-pressed='${hidden}'>${hidden ? '顯示紅筆' : '隱藏紅筆'}</button>`;
}
function paperAiMarksToggle() {
  if (!paperSourceSession) return;
  paperSourceSession.aiMarksHidden = !paperSourceSession.aiMarksHidden;
  paperAiPaint();
  const button = $('#paper-ai-toggle');
  if (button) {
    button.textContent = paperSourceSession.aiMarksHidden ? '顯示紅筆' : '隱藏紅筆';
    button.setAttribute('aria-pressed', String(!!paperSourceSession.aiMarksHidden));
  }
}
function paperInkPoint(e, cv) {
  const rect = cv.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))),
    Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height))),
    Number.isFinite(Number(e.pressure)) && Number(e.pressure) > 0 ? Number(e.pressure) : .5];
}
function paperInkStrokeBounds(stroke) {
  if (!stroke || !Array.isArray(stroke.pts) || !stroke.pts.length) return null;
  if (stroke._paperBounds) return stroke._paperBounds;
  let left = 1, top = 1, right = 0, bottom = 0;
  for (const point of stroke.pts) {
    const x = Math.max(0, Math.min(1, Number(point[0]) || 0));
    const y = Math.max(0, Math.min(1, Number(point[1]) || 0));
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return (stroke._paperBounds = [left, top, right, bottom]);
}
function paperInkGridRange(bounds) {
  const clamp = (value) => Math.max(0, Math.min(PAPER_INK_GRID_SIZE - 1, Math.floor(value * PAPER_INK_GRID_SIZE)));
  return [clamp(bounds[0]), clamp(bounds[1]), clamp(bounds[2]), clamp(bounds[3])];
}
function paperInkSpatialAdd(data, stroke, index) {
  const bounds = paperInkStrokeBounds(stroke);
  if (!data || !data.spatial || !bounds || stroke.dead) return;
  const [x0, y0, x1, y1] = paperInkGridRange(bounds);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const key = y * PAPER_INK_GRID_SIZE + x;
    let bucket = data.spatial.get(key);
    if (!bucket) data.spatial.set(key, (bucket = []));
    bucket.push(index);
  }
}
function paperInkSpatialBuild(data) {
  if (!data) return new Map();
  if (data.spatial) return data.spatial;
  data.spatial = new Map();
  for (let i = 0; i < data.s.length; i++) paperInkSpatialAdd(data, data.s[i], i);
  return data.spatial;
}
function paperInkSpatialCandidates(data, bounds) {
  const spatial = paperInkSpatialBuild(data);
  const [x0, y0, x1, y1] = paperInkGridRange(bounds);
  const found = new Set();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    for (const index of spatial.get(y * PAPER_INK_GRID_SIZE + x) || []) found.add(index);
  }
  return [...found].sort((a, b) => b - a);
}
function paperInkRedrawRegion(cv, data, bounds) {
  if (!cv || !data || !bounds) return;
  const prepared = paperCanvasPrepare(cv);
  if (prepared.resized) { paperInkPaint(); return; }
  const { ctx, width, height } = prepared;
  const pad = 12;
  const left = Math.max(0, bounds[0] * width - pad), top = Math.max(0, bounds[1] * height - pad);
  const right = Math.min(width, bounds[2] * width + pad), bottom = Math.min(height, bounds[3] * height + pad);
  ctx.clearRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  const clipped = typeof ctx.save === 'function' && typeof ctx.clip === 'function' && typeof ctx.rect === 'function';
  if (clipped) {
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  }
  const expanded = [
    Math.max(0, left / width), Math.max(0, top / height),
    Math.min(1, right / width), Math.min(1, bottom / height),
  ];
  const candidates = paperInkSpatialCandidates(data, expanded).sort((a, b) => a - b);
  for (const index of candidates) {
    const stroke = data.s[index];
    if (stroke && !stroke.dead) paperInkLine(ctx, stroke, width, height);
  }
  const current = paperSourceSession && paperSourceSession.inkCurrent;
  if (current) {
    const currentBounds = paperInkStrokeBounds(current);
    if (currentBounds && !(currentBounds[2] < expanded[0] || currentBounds[0] > expanded[2]
      || currentBounds[3] < expanded[1] || currentBounds[1] > expanded[3])) paperInkLine(ctx, current, width, height);
  }
  if (clipped) ctx.restore();
}
function paperInkEraseAt(e, cv) {
  const data = paperInkPage(); if (!data) return false;
  const p = paperInkPoint(e, cv), width = cv.clientWidth, height = cv.clientHeight;
  const px = p[0] * width, py = p[1] * height;
  let hit = null, best = 18;
  const radiusX = 22 / Math.max(1, width), radiusY = 22 / Math.max(1, height);
  const candidates = paperInkSpatialCandidates(data, [
    Math.max(0, p[0] - radiusX), Math.max(0, p[1] - radiusY),
    Math.min(1, p[0] + radiusX), Math.min(1, p[1] + radiusY),
  ]);
  for (const i of candidates) {
    const stroke = data.s[i]; if (!stroke || stroke.dead) continue;
    const pts = stroke.pts || [];
    for (let j = 0; j < pts.length; j++) {
      const q = pts[j];
      const d = j === 0
        ? Math.hypot(px - q[0] * width, py - q[1] * height)
        : inkPointSegmentDistance(px, py,
          [pts[j - 1][0] * width, pts[j - 1][1] * height],
          [q[0] * width, q[1] * height]);
      if (d < best) { best = d; hit = stroke; }
    }
  }
  if (!hit) return false;
  const bounds = paperInkStrokeBounds(hit);
  data.deleted = data.deleted instanceof Set ? data.deleted : new Set(data.deleted || []);
  const deletedId = paperInkStrokeId(hit);
  data.deleted.add(deletedId);
  hit.dead = Date.now();
  paperInkJournalDeleted([deletedId]);
  paperInkMarkDirty();
  paperInkRedrawRegion(cv, data, bounds);
  return true;
}
function paperPinchMeasure(a, b) {
  return {
    x: (Number(a.x) + Number(b.x)) / 2,
    y: (Number(a.y) + Number(b.y)) / 2,
    distance: Math.max(1, Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y))),
  };
}
function paperPinchBegin(cv) {
  if (!paperSourceSession || !paperSourceSession.inkTouches || paperSourceSession.inkTouches.size < 2) return null;
  const pair = [...paperSourceSession.inkTouches.values()].slice(0, 2);
  const measure = paperPinchMeasure(pair[0], pair[1]);
  const sheet = $('#paper-write-sheet'), pane = cv.closest('.paper-page-viewport');
  if (!sheet || !pane) return null;
  const rect = sheet.getBoundingClientRect();
  return {
    ids: [pair[0].id, pair[1].id], distance: measure.distance, zoom: paperSourceSession.zoom,
    sheetX: Math.max(0, Math.min(1, (measure.x - rect.left) / Math.max(1, rect.width))),
    sheetY: Math.max(0, Math.min(1, (measure.y - rect.top) / Math.max(1, rect.height))),
    pane,
  };
}
function paperTouchPageDelta(touch) {
  if (!touch || touch.swipeBlocked) return 0;
  const dx = Number(touch.x) - Number(touch.startX);
  const dy = Number(touch.y) - Number(touch.startY);
  if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.25) return 0;
  return dx < 0 ? 1 : -1;
}
function paperTouchPanBlocksPage(touch, zoom) {
  if (!touch) return false;
  if (Number(zoom) > 1.05) return true;
  const max = Math.max(0, Number(touch.maxScrollLeft) || 0);
  if (max <= 2) return false;
  const dx = Number(touch.x) - Number(touch.startX);
  const startedAtLeft = Number(touch.startScrollLeft) <= 2;
  const startedAtRight = Number(touch.startScrollLeft) >= max - 2;
  return !((startedAtLeft && dx > 0) || (startedAtRight && dx < 0));
}
function paperInkDown(e) {
  if (!paperSourceSession) return;
  const cv = e.currentTarget;
  if (e.pointerType === 'touch') {
    e.preventDefault();
    if (paperSourceSession.inkPointer != null) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    paperSourceSession.inkTouches = paperSourceSession.inkTouches || new Map();
    const pane = typeof cv.closest === 'function' ? cv.closest('.paper-page-viewport') : null;
    const touch = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: pane ? Number(pane.scrollLeft) || 0 : 0,
      maxScrollLeft: pane ? Math.max(0, (Number(pane.scrollWidth) || 0) - (Number(pane.clientWidth) || 0)) : 0,
      swipeBlocked: false,
    };
    paperSourceSession.inkTouches.set(e.pointerId, touch);
    if (paperSourceSession.inkTouches.size >= 2) {
      for (const item of paperSourceSession.inkTouches.values()) item.swipeBlocked = true;
      paperSourceSession.inkTouch = null;
      if (!paperSourceSession.inkPinch) paperSourceSession.inkPinch = paperPinchBegin(cv);
    } else paperSourceSession.inkTouch = touch;
    return;
  }
  if (paperSourceSession.readOnly) return;
  if (!['pen', 'mouse'].includes(e.pointerType || 'mouse')) return;
  if (e.pointerType === 'pen') {
    paperSourceSession.sPenLastAt = Date.now();
    if (paperInkSamsungHoverButton(e)) { e.preventDefault(); paperInkSamsungHover(e); return; }
  }
  e.preventDefault();
  paperSourceSession.inkTouches = new Map(); paperSourceSession.inkTouch = null; paperSourceSession.inkPinch = null;
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  paperSourceSession.inkPointer = e.pointerId;
  paperSourceSession.inkGestureMode = paperInkGestureMode(e);
  paperInkModeRender(paperSourceSession.inkGestureMode, paperInkGestureIsTemporaryErase());
  if (paperSourceSession.inkGestureMode === 'erase') {
    if (paperInkPenHasContact(e)) paperInkEraseAt(e, cv);
    return;
  }
  paperSourceSession.inkCurrent = {
    id: inkClientId('paper-stroke', Date.now()),
    t0: Date.now(),
    w: paperInkWidthValue(paperSourceSession.inkWidth),
    c: PAPER_INK_COLORS[paperSourceSession.inkColor] ? paperSourceSession.inkColor : 'black',
    pts: [paperInkPoint(e, cv)],
  };
  paperSourceSession.inkCheckpointAt = Date.now();
}
function paperInkMove(e) {
  if (!paperSourceSession) return;
  if (e.pointerType === 'touch') {
    const touches = paperSourceSession.inkTouches;
    if (!touches || !touches.has(e.pointerId) || paperSourceSession.inkPointer != null) return;
    const tracked = touches.get(e.pointerId);
    const previousX = tracked.x, previousY = tracked.y;
    tracked.x = e.clientX; tracked.y = e.clientY;
    if (paperTouchPanBlocksPage(tracked, paperSourceSession.zoom)) tracked.swipeBlocked = true;
    const pinch = paperSourceSession.inkPinch;
    if (pinch) {
      const a = touches.get(pinch.ids[0]), b = touches.get(pinch.ids[1]);
      if (a && b) {
        e.preventDefault();
        const measure = paperPinchMeasure(a, b);
        paperWorkspaceSetZoom(pinch.zoom * measure.distance / pinch.distance, {
          pane: pinch.pane, sheetX: pinch.sheetX, sheetY: pinch.sheetY,
          clientX: measure.x, clientY: measure.y,
        });
      }
      return;
    }
    const touch = paperSourceSession.inkTouch;
    if (!touch || touch.id !== e.pointerId) return;
    e.preventDefault();
    const pane = e.currentTarget.closest('.paper-page-viewport');
    const dx = e.clientX - previousX, dy = e.clientY - previousY;
    if (pane) { pane.scrollLeft -= dx; pane.scrollTop -= dy; }
    return;
  }
  if (e.pointerType === 'pen') {
    paperSourceSession.sPenLastAt = Date.now();
    if (paperSourceSession.inkPointer == null) { paperInkSamsungHover(e); return; }
  }
  if (paperSourceSession.inkPointer !== e.pointerId) return;
  const cv = e.currentTarget; e.preventDefault();
  const nextMode = paperInkGestureMode(e);
  if (nextMode !== paperSourceSession.inkGestureMode) {
    paperInkCommitCurrent();
    paperSourceSession.inkGestureMode = nextMode;
    paperInkModeRender(nextMode, paperInkGestureIsTemporaryErase());
    if (nextMode === 'pen') {
      paperSourceSession.inkCurrent = {
        id: inkClientId('paper-stroke', Date.now()),
        t0: Date.now(),
        w: paperInkWidthValue(paperSourceSession.inkWidth),
        c: PAPER_INK_COLORS[paperSourceSession.inkColor] ? paperSourceSession.inkColor : 'black',
        pts: [paperInkPoint(e, cv)],
      };
    }
  }
  if (paperSourceSession.inkGestureMode === 'erase') {
    if (paperInkPenHasContact(e)) paperInkEraseAt(e, cv);
    return;
  }
  const stroke = paperSourceSession.inkCurrent; if (!stroke) return;
  const fromIndex = stroke.pts.length;
  let events = [e];
  try { const coalesced = e.getCoalescedEvents && e.getCoalescedEvents(); if (coalesced && coalesced.length) events = coalesced; } catch (_) {}
  for (const ev of events) {
    const p = paperInkPoint(ev, cv), last = stroke.pts[stroke.pts.length - 1];
    if (Math.hypot((p[0] - last[0]) * cv.clientWidth, (p[1] - last[1]) * cv.clientHeight) >= .8) stroke.pts.push(p);
  }
  if (stroke.pts.length > fromIndex) {
    delete stroke._paperBounds;
    paperInkPaintCurrent(fromIndex);
    paperInkCheckpointCurrent(Date.now());
  }
}
function paperInkUp(e) {
  if (!paperSourceSession) return;
  if (e.pointerType === 'touch') {
    const touches = paperSourceSession.inkTouches;
    const touch = touches && touches.get(e.pointerId);
    const wasPinching = !!paperSourceSession.inkPinch;
    if (touches) touches.delete(e.pointerId);
    if (wasPinching) {
      paperSourceSession.inkPinch = touches && touches.size >= 2 ? paperPinchBegin(e.currentTarget) : null;
      if (touches && touches.size === 1) {
        const remaining = [...touches.values()][0];
        remaining.startX = remaining.x;
        remaining.startY = remaining.y;
        remaining.swipeBlocked = true;
        paperSourceSession.inkTouch = remaining;
      } else paperSourceSession.inkTouch = null;
    } else if (paperSourceSession.inkTouch && paperSourceSession.inkTouch.id === e.pointerId) {
      paperSourceSession.inkTouch = null;
      if (e.type === 'pointerup') {
        const delta = paperTouchPageDelta(touch);
        if (delta) paperWorkspacePage(delta);
      }
    }
    return;
  }
  if (e.pointerType === 'pen') paperSourceSession.sPenLastAt = Date.now();
  if (paperSourceSession.inkPointer !== e.pointerId) return;
  const current = paperSourceSession.inkCurrent;
  if (paperSourceSession.inkGestureMode === 'pen' && current && paperInkPenHasContact(e)) {
    const cv = e.currentTarget, fromIndex = current.pts.length;
    const p = paperInkPoint(e, cv), last = current.pts[current.pts.length - 1];
    if (Math.hypot((p[0] - last[0]) * cv.clientWidth, (p[1] - last[1]) * cv.clientHeight) >= .8) {
      current.pts.push(p); delete current._paperBounds; paperInkPaintCurrent(fromIndex);
    }
  }
  paperInkCommitCurrent();
  paperSourceSession.inkPointer = null; paperSourceSession.inkGestureMode = null;
  paperInkModeRender(paperSourceSession.sPenButtonHeld ? 'erase' : (paperSourceSession.inkMode || 'pen'), !!paperSourceSession.sPenButtonHeld);
}
function paperInkAttach() {
  const cv = $('#paper-ink-canvas'); if (!cv) return;
  paperSourceSession.inkTouches = new Map(); paperSourceSession.inkTouch = null; paperSourceSession.inkPinch = null; paperSourceSession.inkGestureMode = null;
  cv.onpointerdown = paperInkDown; cv.onpointermove = paperInkMove;
  cv.onpointerup = cv.onpointercancel = cv.onlostpointercapture = paperInkUp;
  cv.oncontextmenu = paperInkContextMenu;
  paperInkPaint();
  if (!paperSourceSession.readOnly) {
    paperInkModeSet(paperSourceSession.inkMode || 'pen');
    paperInkColorSet(paperSourceSession.inkColor || 'black');
  }
  paperWorkspaceObserveFit();
}
function paperInkPenErasePressed(e) {
  return sPenErasePressed(e);
}
function paperInkSamsungHoverButton(e) {
  return sPenSamsungHoverButton(e);
}
function paperInkSamsungHoldSet(held) {
  if (!paperSourceSession) return false;
  paperSourceSession.sPenButtonHeld = !!held;
  if (paperSourceSession.inkPointer == null) paperInkModeRender(held ? 'erase' : (paperSourceSession.inkMode || 'pen'), !!held);
  return true;
}
function paperInkSamsungHover(e) {
  if (!paperSourceSession || !e || e.pointerType !== 'pen') return false;
  if (paperInkSamsungHoverButton(e)) return paperInkSamsungHoldSet(true);
  if (Number(e.pressure) === 0) return paperInkSamsungHoldSet(false);
  return false;
}
function paperInkContextMenu(e) {
  e.preventDefault();
  if (!paperSourceSession) return false;
  paperInkCommitCurrent();
  paperSourceSession.sPenButtonHeld = false;
  paperSourceSession.inkPointer = null; paperSourceSession.inkGestureMode = null;
  paperInkModeRender(paperSourceSession.inkMode || 'pen');
  return false;
}
function paperInkPenHasContact(e) {
  if (!e || e.pointerType !== 'pen') return true;
  const pressure = Number(e.pressure);
  return Number.isFinite(pressure) ? pressure > 0 : !!(Number(e.buttons) & 1);
}
function paperInkGestureMode(e) {
  return (paperInkPenErasePressed(e) || paperSourceSession && paperSourceSession.sPenButtonHeld) ? 'erase' : (paperSourceSession && paperSourceSession.inkMode === 'erase' ? 'erase' : 'pen');
}
function paperInkGestureIsTemporaryErase() {
  return !!paperSourceSession && (paperSourceSession.sPenButtonHeld || paperSourceSession.inkGestureMode === 'erase' && paperSourceSession.inkMode !== 'erase');
}
function paperInkCommitCurrent() {
  if (!paperSourceSession) return false;
  const stroke = paperSourceSession.inkCurrent;
  paperSourceSession.inkCurrent = null;
  if (!stroke || stroke.pts.length <= 1) return false;
  stroke.t1 = Date.now();
  paperInkJournalStroke(stroke, true);
  const data = paperInkPage(), index = data.s.length;
  data.s.push(stroke);
  if (data.spatial) paperInkSpatialAdd(data, stroke, index);
  paperInkMarkDirty();
  return true;
}
function paperInkModeRender(mode, temporaryErase = false) {
  for (const key of ['pen', 'erase']) {
    const btn = $(`#paper-tool-${key}`); if (btn) btn.classList.toggle('active', key === mode);
  }
  const cv = $('#paper-ink-canvas'); if (cv) cv.dataset.mode = mode;
  paperInkStatusRender();
}
function paperInkModeSet(mode) {
  if (!paperSourceSession) return;
  paperSourceSession.inkMode = mode === 'erase' ? 'erase' : 'pen';
  if (paperSourceSession.inkPointer == null) paperInkModeRender(paperSourceSession.sPenButtonHeld ? 'erase' : paperSourceSession.inkMode, !!paperSourceSession.sPenButtonHeld);
}
function paperInkWidthValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(PAPER_INK_WIDTH_MIN, Math.min(PAPER_INK_WIDTH_MAX, Math.round(n * 100) / 100)) : 1;
}
function paperInkWidthSet(percent) {
  if (!paperSourceSession) return;
  const width = paperInkWidthValue(Number(percent) / 100);
  paperSourceSession.inkWidth = width;
  if (paperSourceSession.run) {
    if (paperSourceSession.reviewMode) paperSourceSession.run.reviewInkWidth = width;
    else paperSourceSession.run.paperInkWidth = width;
    paperSourceSession.run.mt = Date.now();
    clearTimeout(paperStateSaveTimer); paperStateSaveTimer = setTimeout(save, 300);
  }
  const label = $('#paper-pen-width-label'); if (label) label.textContent = `${Math.round(width * 100)}%`;
}
function paperInkColorSet(color) {
  if (!paperSourceSession || !PAPER_INK_COLORS[color]) return;
  paperSourceSession.inkColor = color;
  if (paperSourceSession.run) {
    if (paperSourceSession.reviewMode) paperSourceSession.run.reviewInkColor = color;
    else paperSourceSession.run.paperInkColor = color;
    paperSourceSession.run.mt = Date.now();
    clearTimeout(paperStateSaveTimer); paperStateSaveTimer = setTimeout(save, 300);
  }
  for (const key of Object.keys(PAPER_INK_COLORS)) {
    const button = $(`#paper-color-${key}`);
    if (button) {
      const selected = key === color;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }
  paperInkModeSet('pen');
}
function paperInkUndo() {
  const data = paperInkPage(); if (!data) return;
  const stroke = [...data.s].reverse().find((item) => item && !item.dead); if (!stroke) return;
  const bounds = paperInkStrokeBounds(stroke);
  data.deleted = data.deleted instanceof Set ? data.deleted : new Set(data.deleted || []);
  const deletedId = paperInkStrokeId(stroke);
  data.deleted.add(deletedId);
  stroke.dead = Date.now(); paperInkMarkDirty();
  paperInkJournalDeleted([deletedId]);
  paperInkRedrawRegion($('#paper-ink-canvas'), data, bounds);
}
function paperInkClear() {
  const data = paperInkPage(); if (!data || !data.s.some((item) => item && !item.dead)) return;
  if (!confirm('清空這一頁題本上的全部筆跡？其他頁不受影響。')) return;
  const now = Date.now();
  const deletedIds = [];
  data.deleted = data.deleted instanceof Set ? data.deleted : new Set(data.deleted || []);
  for (const stroke of data.s) if (stroke && !stroke.dead) {
    const deletedId = paperInkStrokeId(stroke);
    data.deleted.add(deletedId);
    deletedIds.push(deletedId);
    stroke.dead = now;
  }
  paperInkJournalDeleted(deletedIds);
  paperInkMarkDirty(); paperInkPaint();
}
function paperWorkspacePage(delta) {
  if (!paperSourceSession) return;
  if (!paperSourceSession.readOnly) {
    paperInkCommitCurrent();
    paperInkPersist(true);
  }
  const nextPage = Math.max(0, Math.min(paperSourceSession.source.scans.length - 1, paperSourceSession.page + delta));
  if (nextPage === paperSourceSession.page) return false;
  paperSourceSession.page = nextPage;
  if (paperSourceSession.reviewMode) paperSourceSession.run.reviewPage = paperSourceSession.page;
  else paperSourceSession.run.paperPage = paperSourceSession.page;
  paperSourceSession.run.mt = Date.now();
  paperRecoveryWrite(true);
  if (paperSourceSession.reviewMode) renderPaperAnswerReview();
  else renderPaperSource();
  return true;
}
function paperWorkspaceZoom(delta) {
  if (!paperSourceSession) return;
  paperWorkspaceSetZoom(Math.round((paperSourceSession.zoom + delta) * 4) / 4);
}
function paperWorkspaceFit() {
  if (!paperSourceSession) return;
  const pane = document.querySelector('.paper-page-viewport'), sheet = $('#paper-write-sheet');
  if (!pane || !sheet || !pane.clientWidth || !pane.clientHeight) return;
  const sheetRatio = 2112 / 2535;
  paperSourceSession.fitWidth = Math.max(pane.clientWidth, pane.clientHeight * sheetRatio);
  sheet.style.width = `${paperSourceSession.fitWidth * paperSourceSession.zoom}px`;
  sheet.style.maxWidth = 'none';
  clearTimeout(paperZoomPaintTimer); paperZoomPaintTimer = setTimeout(paperInkPaint, 35);
}
function paperWorkspaceObserveFit() {
  if (paperFitObserver) { paperFitObserver.disconnect(); paperFitObserver = null; }
  const pane = document.querySelector('.paper-page-viewport');
  if (pane && window.ResizeObserver) {
    paperFitObserver = new ResizeObserver(() => paperWorkspaceFit());
    paperFitObserver.observe(pane);
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paperWorkspaceFit);
  else paperWorkspaceFit();
}
function paperWorkspaceSetZoom(value, focus) {
  if (!paperSourceSession) return;
  const previousZoom = paperSourceSession.zoom || 1;
  paperSourceSession.zoom = Math.max(PAPER_ZOOM_MIN, Math.min(PAPER_ZOOM_MAX, Math.round(Number(value) * 100) / 100));
  const sheet = $('#paper-write-sheet'), label = $('#paper-zoom-label');
  if (sheet) {
    const pane = typeof sheet.closest === 'function' ? sheet.closest('.paper-page-viewport') : document.querySelector('.paper-page-viewport');
    const sheetRatio = 2112 / 2535;
    const measuredWidth = typeof sheet.getBoundingClientRect === 'function' ? sheet.getBoundingClientRect().width / previousZoom : Number(sheet.clientWidth);
    const fitWidth = paperSourceSession.fitWidth || (pane ? Math.max(pane.clientWidth, pane.clientHeight * sheetRatio) : measuredWidth);
    paperSourceSession.fitWidth = fitWidth;
    sheet.style.width = `${fitWidth * paperSourceSession.zoom}px`;
    sheet.style.maxWidth = 'none';
  }
  if (label) label.textContent = `${Math.round(paperSourceSession.zoom * 100)}%`;
  if (sheet && focus && focus.pane) {
    const rect = sheet.getBoundingClientRect();
    focus.pane.scrollLeft += rect.left + focus.sheetX * rect.width - focus.clientX;
    focus.pane.scrollTop += rect.top + focus.sheetY * rect.height - focus.clientY;
  }
  clearTimeout(paperZoomPaintTimer); paperZoomPaintTimer = setTimeout(paperInkPaint, 35);
}
function paperUiToggle() {
  const shell = document.querySelector('.paper-session-shell'); if (!shell) return;
  const hidden = shell.classList.toggle('paper-ui-hidden');
  const button = $('#paper-ui-toggle');
  if (button) {
    button.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    button.setAttribute('aria-label', hidden ? '顯示工具' : '收起工具');
    const label = button.querySelector('span'); if (label) label.textContent = hidden ? '工具' : '收起';
  }
}
function paperImageLoad(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('題本影像無法載入'));
    image.src = url;
  });
}
async function paperCompositeImage(source, urls, inkPages, page, includeGrade, overlayInkPages, overlayColor) {
  const scan = source.scans[page];
  const image = await paperImageLoad(urls[page]);
  const width = 1536, height = Math.round(width * 2535 / 2112);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fffefa'; ctx.fillRect(0, 0, width, height);
  const crop = { x: width * .03, y: height * .025, w: width * .708, h: height * .94 };
  const half = image.naturalWidth / 2, sourceX = scan.side === 'right' ? half : 0;
  ctx.filter = 'grayscale(.92) contrast(1.1) brightness(1.035)';
  ctx.drawImage(image, sourceX, 0, half, image.naturalHeight, crop.x, crop.y, crop.w, crop.h);
  ctx.filter = 'none';
  const marginX = width * .756;
  ctx.strokeStyle = '#d5d0c7'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(marginX, height * .03); ctx.lineTo(marginX, height * .97); ctx.stroke();
  ctx.strokeStyle = 'rgba(122,112,100,.16)';
  for (let y = height * .08; y < height * .96; y += height * .017) {
    ctx.beginPath(); ctx.moveTo(marginX + 8, y); ctx.lineTo(width * .975, y); ctx.stroke();
  }
  const data = inkPages && inkPages[page];
  for (const stroke of data && Array.isArray(data.s) ? data.s : []) paperInkLine(ctx, stroke, width, height);
  if (includeGrade) {
    const red = document.createElement('canvas');
    red.width = width; red.height = height;
    paperAiPaintCanvas(red, paperAiPageQuestions(page), true, 1);
    ctx.drawImage(red, 0, 0);
  }
  const overlay = overlayInkPages && overlayInkPages[page];
  for (const stroke of overlay && Array.isArray(overlay.s) ? overlay.s : []) {
    paperInkLine(ctx, stroke, width, height, overlayColor);
  }
  return canvas.toDataURL('image/jpeg', .9).split(',')[1];
}
async function paperPageComposite(page) {
  if (!paperSourceSession) throw new Error('原卷工作階段不存在');
  return paperCompositeImage(
    paperSourceSession.source,
    paperSourceSession.urls,
    paperSourceSession.inkPages,
    page,
  );
}
async function paperExportGradedPdf() {
  if (!paperSourceSession || !paperSourceSession.run || !paperSourceSession.run.aiGrade) {
    alert('目前沒有可輸出的批改結果。');
    return false;
  }
  const session = paperSourceSession;
  const { source, run, urls, inkPages } = session;
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('瀏覽器封鎖了列印頁。請允許這個網站開啟新分頁後再按一次。');
    return false;
  }
  printWindow.document.write('<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>正在產生批改卷</title></head><body style="font-family:system-ui,sans-serif;padding:32px;color:#51483f">正在整理完整批改卷，請稍候，不要關閉此分頁。</body></html>');
  printWindow.document.close();
  const button = $('#paper-export-pdf');
  if (button) { button.disabled = true; button.textContent = '正在整理 PDF…'; }
  try {
    const images = [];
    for (let page = 0; page < source.scans.length; page++) {
      if (button) button.textContent = `正在整理 ${page + 1}/${source.scans.length}`;
      images.push(`data:image/jpeg;base64,${await paperCompositeImage(source, urls, inkPages, page, true)}`);
    }
    const title = `${source.title}_${run.d || today()}_${run.aiGrade.score}分_紅筆批改`;
    const wrong = run.aiGrade.wrongNos && run.aiGrade.wrongNos.length ? run.aiGrade.wrongNos.join('、') : '無';
    const pages = images.map((src, index) => `<section class="page">
      ${index === 0 ? `<header><strong>${escH(source.title)}　${Number(run.aiGrade.score) || 0} / 100</strong><span>錯題：${escH(wrong)}　作答日：${escH(run.d || today())}</span></header>` : ''}
      <img src="${src}" alt="${escH(source.title)}第 ${index + 1} 頁批改卷">
      <footer>${index + 1} / ${images.length}</footer>
    </section>`).join('');
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${escH(title)}</title>
      <style>
        @page { size: A4 portrait; margin: 5mm; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff; color: #413b35; font-family: system-ui, "Noto Sans TC", sans-serif; }
        .page { width: 100%; min-height: 287mm; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; align-items: start; break-after: page; page-break-after: always; }
        .page:last-child { break-after: auto; page-break-after: auto; }
        header { min-height: 12mm; display: flex; align-items: center; justify-content: space-between; gap: 8mm; padding: 1mm 2mm 2mm; font-size: 10pt; }
        header strong { font-size: 13pt; }
        img { display: block; width: 100%; height: auto; max-height: 266mm; object-fit: contain; object-position: top center; }
        footer { min-height: 5mm; padding-top: 1mm; text-align: right; color: #82786d; font-size: 8pt; }
        @media screen { body { max-width: 210mm; margin: 0 auto; background: #d8d3cb; } .page { margin: 10mm 0; padding: 5mm; background: #fff; box-shadow: 0 3px 18px rgba(0,0,0,.14); } }
      </style></head><body>${pages}</body></html>`);
    printWindow.document.close();
    printWindow.document.title = title;
    const ready = () => {
      try { printWindow.focus(); printWindow.print(); } catch (_) {}
    };
    if (printWindow.document.readyState === 'complete') setTimeout(ready, 250);
    else printWindow.addEventListener('load', () => setTimeout(ready, 250), { once: true });
    return true;
  } catch (error) {
    try {
      printWindow.document.body.innerHTML = `<h1>批改卷整理失敗</h1><p>${escH((error && error.message) || error)}</p>`;
    } catch (_) {}
    alert(`批改卷整理失敗：${(error && error.message) || error}`);
    return false;
  } finally {
    if (button) { button.disabled = false; button.innerHTML = `${uiIcon('save')}輸出批改卷 PDF`; }
  }
}
function paperGradePromptKey(source) {
  return source.key.map((q, index) => ({
    no: index + 1,
    page: paperQuestionScanIndex(source, index + 1) + 1,
    type: q.type,
    answer: paperFinalAnswerText(q),
    correctOptions: q.type === 'single' || q.type === 'multi' ? q.ans.map((option) => option + 1) : [],
    points: q.points,
  }));
}
async function paperAiGradeCall(source, pages) {
  const key = paperGradePromptKey(source);
  const content = [{
    type: 'text',
    text: `你是台灣學測數學閱卷老師。接下來依序附上「${source.title}」的 ${pages.length} 張單頁題本；每張已把原掃描題目、考生在題目上與右側留白寫的黑／藍／綠筆跡合成。請直接讀取題本上的作答，不存在另外的答案卡。

正式答案與配分：${JSON.stringify(key)}

批改規則：
1. questions 必須恰好回傳第 1 到 ${source.questions} 題，每題一次；page 必須依上面對照。
2. 只把考生自己寫的黑／藍／綠筆跡視為作答。印刷題目不是作答，右側留白也可能有最後答案。
3. 特別防止誤判：圈住「印刷的題號」只代表考生想回頭看，絕對不是選了同號選項。若只圈題號並寫「不會」、沒有另外寫最終答案，必須回傳 hasFinalAnswer=false、status=unanswered、selectedOptions=[]；例如圈住印刷題號 4 不等於單選答案 (4)。
4. hasFinalAnswer 只表示你是否真的找到考生另外寫出的最終答案。finalAnswer 必須逐字填入你辨識到的最終答案；沒有答案填空字串。單選與填答答對得該題滿分，答錯或未答 0 分；等價分數、根式、小數形式可算對。
5. 單選與多選的 selectedOptions 都必須列出你從考生「最終答案清單」辨識到的 1 起算選項，不可從算式中猜；填答題固定回傳空陣列。多選依五個選項逐一比較：全對 5 分、差 1 個選項 3 分、差 2 個選項 1 分、差 3 個以上 0 分；系統會以 selectedOptions 與正式答案重新計分，不採信模型自行填的 status 或 points。
6. status：正確 correct、錯誤 incorrect、沒有作答 unanswered、筆跡真的無法辨識 uncertain。不要為了湊答案而猜。
7. marks 的 box 是該張完整單頁 [左,上,右,下] 0–1 座標，必須落在考生實際寫下的最終答案或答案清單上，不可框題目、題號或中間算式。單選／填答各回傳一個 kind=check 或 cross；未答用 unanswered、看不清楚用 uncertain，option=0。
8. 複選題必須像真人逐項批改：每個正確選到的手寫選項回傳 kind=check；每個錯選的手寫選項回傳 kind=strike；每個漏選的正確選項回傳 kind=add，box 放在答案清單旁可補寫的位置。這三種 mark 的 option 都填該選項 1–5。若部分得分，可另回傳一個 option=0 的 partial，但不可省略逐項 marks。
9. label 只可放「✓」「✕」「△」「未答」「看不清楚」或補入的選項號碼；系統會在紅叉或部分得分旁強制寫出完整正解。
10. read 只記錄實際辨識到的最終答案與必要的「寫了不會」事實，供稽核；note 只記錄整體辨識風險。
11. 這是第一次簡批。禁止輸出詳解、提示、破題方向、錯誤類型或「從哪一步開始錯」；也不要把這些內容塞進 read、note 或 label。`,
  }];
  pages.forEach((b64, index) => {
    content.push({ type: 'text', text: `【完整單頁 ${index + 1}／${pages.length}】` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  });
  const payload = await openAiInvoke({ responseType: 'paper_grade', messages: [{ role: 'user', content }] }, 90000);
  if (!payload.json || typeof payload.json !== 'object') throw new Error('OpenAI 沒有回傳完整批改資料');
  return {
    json: payload.json,
    model: String(payload.model || ''),
    requestId: String(payload.requestId || ''),
    usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
    budget: payload.budget && typeof payload.budget === 'object' ? payload.budget : null,
  };
}
function paperFallbackMark(source, no, page, label, kind, option, slot) {
  const pageNos = source.key.map((_, index) => index + 1)
    .filter((itemNo) => paperQuestionScanIndex(source, itemNo) + 1 === page);
  const index = Math.max(0, pageNos.indexOf(no));
  const y = .09 + index * (.78 / Math.max(1, pageNos.length)) + (Number(slot) || 0) * .018;
  return {
    box: [.78, Math.min(.94, y), .85, Math.min(.97, y + .035)],
    label,
    kind: kind || 'uncertain',
    option: Number(option) || 0,
  };
}
function paperNormalizeAiGrade(source, raw, model) {
  const incoming = Array.isArray(raw && raw.questions) ? raw.questions : [];
  const byNo = new Map();
  for (const item of incoming) {
    const no = Number(item && item.no);
    if (Number.isInteger(no) && no >= 1 && no <= source.questions && !byNo.has(no)) byNo.set(no, item);
  }
  if (byNo.size !== source.questions) throw new Error(`AI 只完成 ${byNo.size}/${source.questions} 題，請重新批改`);
  const questions = source.key.map((q, index) => {
    const no = index + 1, item = byNo.get(no), page = paperQuestionScanIndex(source, no) + 1;
    const allowed = new Set(['correct', 'incorrect', 'unanswered', 'uncertain']);
    let status = allowed.has(item.status) ? item.status : 'uncertain';
    const selectedOptionsProvided = Array.isArray(item.selectedOptions);
    const selectedOptions = selectedOptionsProvided
      ? [...new Set(item.selectedOptions.map(Number).filter((option) => Number.isInteger(option) && option >= 1 && option <= 5))].sort((a, b) => a - b)
      : [];
    const finalAnswerProvided = typeof item.finalAnswer === 'string';
    const finalAnswer = finalAnswerProvided ? item.finalAnswer.trim() : '';
    const correctOptions = q.type === 'single' || q.type === 'multi'
      ? q.ans.map((option) => option + 1).sort((a, b) => a - b) : [];
    const concreteAnswer = q.type === 'fill'
      ? finalAnswerProvided && !!finalAnswer
      : selectedOptionsProvided && selectedOptions.length > 0;
    // `status` 是模型摘要，結構化答案才是確定性核分依據。只有明確說「沒找到答案」，
    // 或既沒有答案內容、status 也為 unanswered 時，才判未答。
    const explicitlyUnanswered = item.hasFinalAnswer === false || (status === 'unanswered' && !concreteAnswer);
    let points = Number(item.points);
    if (status === 'uncertain') points = 0;
    else if (q.type === 'single' && selectedOptionsProvided) {
      if (explicitlyUnanswered) {
        status = 'unanswered';
        points = 0;
      } else if (selectedOptions.length !== 1) {
        status = selectedOptions.length ? 'incorrect' : 'uncertain';
        points = 0;
      } else {
        const correct = selectedOptions[0] === correctOptions[0];
        status = correct ? 'correct' : 'incorrect';
        points = correct ? q.points : 0;
      }
    } else if (q.type === 'fill' && finalAnswerProvided) {
      if (explicitlyUnanswered) {
        status = 'unanswered';
        points = 0;
      } else if (!finalAnswer) {
        status = 'uncertain';
        points = 0;
      } else {
        const correct = checkFill(finalAnswer, q.ans);
        status = correct ? 'correct' : 'incorrect';
        points = correct ? q.points : 0;
      }
    }
    else if (q.type === 'multi' && selectedOptionsProvided) {
      if (explicitlyUnanswered || !selectedOptions.length) {
        status = 'unanswered';
        points = 0;
      } else {
        points = multiPartialPoints(q.points, selectedOptions, correctOptions, [1, 2, 3, 4, 5]);
        status = points === q.points ? 'correct' : 'incorrect';
      }
    } else if (explicitlyUnanswered) {
      status = 'unanswered';
      points = 0;
    } else if (status === 'correct') points = q.points;
    else if (q.type !== 'multi') points = 0;
    else {
      const allowedPartial = [0, q.points * .2, q.points * .6];
      points = allowedPartial.reduce((best, value) => Math.abs(value - points) < Math.abs(best - points) ? value : best, 0);
    }
    points = Math.max(0, Math.min(q.points, Math.round(points * 100) / 100));
    const label = status === 'correct' ? `✓ +${points}`
      : status === 'incorrect' && points > 0 ? `△ +${points}`
      : status === 'incorrect' ? '✕ 0'
      : status === 'unanswered' ? '未作答' : '看不清楚';
    const rawMarks = (Array.isArray(item.marks) ? item.marks : []).slice(0, 7).map((mark) => {
      const box = Array.isArray(mark && mark.box) ? mark.box.map(Number) : [];
      if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
      return {
        box: box.map((n) => Math.max(0, Math.min(1, n))),
        kind: String(mark.kind || ''),
        option: Number(mark.option) || 0,
      };
    }).filter(Boolean);
    const used = new Set();
    const locate = (kind, option, slot) => {
      let found = rawMarks.findIndex((mark, markIndex) => !used.has(markIndex)
        && mark.option === option && (!mark.kind || mark.kind === kind));
      if (found < 0) found = rawMarks.findIndex((mark, markIndex) => !used.has(markIndex) && mark.option === option);
      if (found < 0 && option === 0) found = rawMarks.findIndex((mark, markIndex) => !used.has(markIndex));
      if (found >= 0) {
        used.add(found);
        return { ...rawMarks[found], kind, option, label: kind === 'add' ? `(${option})` : label };
      }
      return paperFallbackMark(source, no, page, kind === 'add' ? `(${option})` : label, kind, option, slot);
    };
    let marks;
    if (q.type === 'multi' && selectedOptionsProvided && status !== 'unanswered' && status !== 'uncertain') {
      const selected = new Set(selectedOptions), correct = new Set(correctOptions);
      const expected = [
        ...selectedOptions.map((option) => ({ kind: correct.has(option) ? 'check' : 'strike', option })),
        ...correctOptions.filter((option) => !selected.has(option)).map((option) => ({ kind: 'add', option })),
      ];
      marks = expected.map((mark, slot) => locate(mark.kind, mark.option, slot));
    } else {
      const kind = status === 'correct' ? 'check'
        : status === 'incorrect' && points > 0 ? 'partial'
        : status === 'incorrect' ? 'cross'
        : status === 'unanswered' ? 'unanswered' : 'uncertain';
      marks = [locate(kind, 0, 0)];
    }
    return {
      no, page, status, points,
      answer: paperFinalAnswerText(q),
      read: String(item.read || '').slice(0, 120),
      hasFinalAnswer: status !== 'unanswered' && item.hasFinalAnswer !== false,
      finalAnswer,
      selectedOptions: q.type === 'single' || q.type === 'multi' ? selectedOptions : [],
      marks,
    };
  });
  const score = Math.round(questions.reduce((sum, item) => sum + item.points, 0) * 100) / 100;
  return {
    model: model || 'gpt-5.5',
    gradedAt: Date.now(),
    score,
    wrongNos: questions.filter((item) => item.status !== 'correct').map((item) => item.no),
    uncertainNos: questions.filter((item) => item.status === 'uncertain').map((item) => item.no),
    questions,
  };
}
function paperRecoveryTimeText(value) {
  const at = Number(value) || 0;
  return at ? new Date(at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未';
}
async function paperRecoveryRows(session = paperSourceSession) {
  if (!session || !session.run || !session.source) return [];
  const run = paperInkStorageRun(session);
  const groups = await Promise.all(session.source.scans.map((_, page) => inkRecordByQid(paperInkQid(run, page))));
  return groups.flat().filter(inkRecordVisibleToCurrentUser);
}
async function paperRecoveryOpen() {
  if (!paperSourceSession) return;
  const session = paperSourceSession;
  let rows = [];
  try { rows = await paperRecoveryRows(session); } catch (_) {}
  const pending = rows.filter((row) => row && !row.uploaded).length;
  const journalRows = rows.filter((row) => row && row.proc && row.proc.event).length;
  const durability = session.durability || {};
  modal(`<h2>這一回的當機保護</h2>
    <p class="dim">每一筆先寫進平板本機，再分批同步到私人 Supabase。整頁快照只做檢查點，不會隨筆跡增加而拖慢每一筆。</p>
    ${session.recoveredNotice ? `<p class="good">${escH(session.recoveredNotice)}；當機後的離線時間沒有算進考試。</p>` : ''}
    <div class="paper-recovery-grid">
      <span>本機最後保存</span><b>${paperRecoveryTimeText(durability.localAt)}</b>
      <span>雲端最後同步</span><b>${paperRecoveryTimeText(durability.cloudAt)}</b>
      <span>待補傳</span><b>${pending} 筆</b>
      <span>本回增量紀錄</span><b>${journalRows} 筆</b>
      <span>救援識別碼</span><code>${escH(session.run.id)}</code>
    </div>
    <p class="dim">即使 Chrome 當機，重新開啟同一回會合併本機日誌、雲端日誌與最近快照，並回到最後保存的頁碼與時間。</p>`, [
    ['關閉'],
    ['匯出救援檔', () => paperRecoveryExport()],
    ['立即同步', async () => {
      paperInkCommitCurrent();
      await paperInkJournalDrain(session);
      await paperInkPersist(true);
      await flushInkQueue();
      paperInkStatusRender(session);
    }, 'primary'],
  ]);
}
async function paperRecoveryExport() {
  if (!paperSourceSession) return false;
  const session = paperSourceSession;
  paperInkCommitCurrent();
  const journalOk = await paperInkJournalDrain(session);
  const snapshotOk = await paperInkPersist(true);
  let records = [];
  try { records = await paperRecoveryRows(session); } catch (_) {}
  const recovery = paperRecoveryWrite(true, session);
  const payload = {
    kind: 'matha-paper-rescue-v1',
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VER,
    run: {
      id: session.run.id, sourceId: session.run.sourceId, name: session.run.name,
      date: session.run.d, createdAt: session.run.createdAt,
      page: Number(session.page) || 0, remainingMs: paperRunLeft(session.run),
    },
    source: { id: session.source.id, title: session.source.title, pages: session.source.scans.length },
    recovery,
    records,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `數A原卷救援-${session.run.d || today()}-${session.run.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  if (!journalOk || !snapshotOk) alert('救援檔已匯出，但本機資料庫仍有寫入失敗；請保留這個檔案並不要關閉頁面。');
  return true;
}
function renderPaperSource() {
  if (!paperSourceSession) return renderMockIntro();
  if (paperSourceSession.readOnly) return renderPaperGradeResult();
  const { source, run, urls } = paperSourceSession;
  const left = paperRunLeft(run), page = paperSourceSession.page, scan = source.scans[page];
  app().innerHTML = `<div class="paper-session-shell">
    <div class="paper-workbar"><div class="paper-work-title"><b>${escH(source.title)}</b><small>${paperSourceSession.recoveredNotice ? escH(paperSourceSession.recoveredNotice) : '單指左右滑動翻頁'}</small></div>
      <span id="paper-clock" class="timer paper-timer">${fmtClock(left)}</span>
      <div class="paper-workgroup right"><button id="paper-ink-status" class="paper-save-status" data-state="local" onclick="paperRecoveryOpen()" aria-label="查看當機保護與救援">${escH(paperInkStatusText(paperSourceSession))}</button><button class="paper-icon-btn" onclick="paperWorkspaceZoom(-.25)" aria-label="縮小題本">−</button><span id="paper-zoom-label" class="paper-zoom-label">${Math.round(paperSourceSession.zoom * 100)}%</span><button class="paper-icon-btn" onclick="paperWorkspaceZoom(.25)" aria-label="放大題本">＋</button><span class="paper-page-label"><b>${page + 1} / ${source.scans.length}</b><small>${escH(scan.label)}</small></span><button class="paper-icon-btn" onclick="paperWorkspacePage(-1)" ${page <= 0 ? 'disabled' : ''} aria-label="上一頁">${uiIcon('arrow-left')}</button><button class="paper-icon-btn" onclick="paperWorkspacePage(1)" ${page >= source.scans.length - 1 ? 'disabled' : ''} aria-label="下一頁">${uiIcon('arrow-right')}</button><button class="paper-icon-btn" onclick="exitFlow()" aria-label="離開">${uiIcon('x')}</button></div></div>
    <div class="paper-workspace"><section class="paper-source-pane"><div class="paper-ink-tools"><button id="paper-tool-pen" onclick="paperInkModeSet('pen')">${uiIcon('pencil')}筆</button><button id="paper-tool-erase" onclick="paperInkModeSet('erase')">${uiIcon('erase')}橡皮擦</button><button onclick="paperInkUndo()">${uiIcon('undo')}復原</button><button onclick="paperInkClear()">${uiIcon('x')}清空本頁</button><div class="paper-color-group" role="group" aria-label="畫筆顏色"><button id="paper-color-black" class="paper-color-button" onclick="paperInkColorSet('black')" aria-label="黑色筆" aria-pressed="${paperSourceSession.inkColor === 'black'}"><i style="--ink:${PAPER_INK_COLORS.black}"></i><span>黑</span></button><button id="paper-color-blue" class="paper-color-button" onclick="paperInkColorSet('blue')" aria-label="藍色筆" aria-pressed="${paperSourceSession.inkColor === 'blue'}"><i style="--ink:${PAPER_INK_COLORS.blue}"></i><span>藍</span></button><button id="paper-color-green" class="paper-color-button" onclick="paperInkColorSet('green')" aria-label="綠色筆" aria-pressed="${paperSourceSession.inkColor === 'green'}"><i style="--ink:${PAPER_INK_COLORS.green}"></i><span>綠</span></button></div><label class="paper-pen-width" for="paper-pen-width"><span>筆粗 <b id="paper-pen-width-label">${Math.round(paperInkWidthValue(paperSourceSession.inkWidth) * 100)}%</b></span><input id="paper-pen-width" type="range" min="35" max="200" step="5" value="${Math.round(paperInkWidthValue(paperSourceSession.inkWidth) * 100)}" oninput="paperInkWidthSet(this.value)" aria-label="調整畫筆粗細"></label></div><div class="paper-page-viewport"><div class="paper-spread"><div id="paper-write-sheet" class="paper-write-sheet" data-side="${scan.side}"><div class="paper-question-crop"><img id="paper-source-image" src="${urls[page]}" alt="${escH(source.title)} ${escH(scan.label)}"></div><div class="paper-note-margin" aria-hidden="true"></div><canvas id="paper-ink-canvas" aria-label="整個畫面皆可直接書寫並左右滑動翻頁"></canvas><canvas id="paper-ai-canvas" aria-hidden="true"></canvas></div></div></div></section></div>
    <div class="paper-finish-bar"><span>${source.questions} 題・${source.minutes} 分鐘</span><button class="btn primary" onclick="paperSourceGrade('主動交卷')">交卷並第一次批改</button></div>
    <button id="paper-ui-toggle" class="paper-ui-toggle" onclick="paperUiToggle()" aria-label="收起工具" aria-pressed="false">${uiIcon('pencil')}<span>收起</span></button></div>`;
  sessionChrome(true);
  paperInkAttach();
  paperInkStatusRender();
  startTicker(() => {
    if (!paperSourceSession || sessionMode !== 'paper-source') return stopTicker();
    const remain = paperRunLeft(run), clock = $('#paper-clock');
    if (clock) clock.textContent = fmtClock(remain);
    paperRecoveryHeartbeat();
    if (remain <= 0) paperSourceGrade('時間到');
  });
}
async function paperSourcePause() {
  if (!paperSourceSession) return Promise.resolve(false);
  const session = paperSourceSession, run = session.run;
  const remaining = paperRunLeft(run);
  paperInkCommitCurrent();
  run.remainingMs = remaining; run.resumeAt = null; run.status = 'paused'; run.mt = Date.now();
  run.paperPage = Number(session.page) || 0;
  paperRecoveryClose(run, 'paused');
  save();
  const [journalOk, persisted] = await Promise.all([paperInkJournalDrain(session), paperInkPersist(true)]);
  return !!journalOk && (!!persisted || !paperInkPage() || !paperInkPage().dirty);
}
function paperSourceDiscard(runId) {
  const run = (S.paperRuns || []).find((item) => item && item.id === runId);
  if (run) {
    const now = Date.now();
    run.status = 'discarded';
    run.resumeAt = null;
    run.gradeDraft = null;
    run.discardedAt = now;
    run.mt = now;
    paperRecoveryClose(run, 'discarded');
  }
  S.extMocks = (S.extMocks || []).filter((row) => row && row.paperRunId !== runId);
  save();
}
function paperGradeSnapshot(grade, reason) {
  return {
    id: `grade-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    reason: String(reason || 'snapshot').slice(0, 80),
    model: String(grade && grade.model || ''),
    requestId: String(grade && grade.requestId || ''),
    promptVersion: String(grade && grade.promptVersion || ''),
    usage: grade && grade.usage && typeof grade.usage === 'object' ? { ...grade.usage } : null,
    gradedAt: Number(grade && grade.gradedAt) || null,
    score: Number(grade && grade.score) || 0,
    questions: (grade && Array.isArray(grade.questions) ? grade.questions : []).map((item) => ({
      no: Number(item.no), status: String(item.status || 'uncertain'), points: Number(item.points) || 0,
      read: String(item.read || ''), finalAnswer: String(item.finalAnswer || ''),
      selectedOptions: Array.isArray(item.selectedOptions) ? item.selectedOptions.slice() : [],
    })),
  };
}
function paperGradeAuditPush(run, reason) {
  if (!run || !run.aiGrade) return;
  run.gradeAudit = Array.isArray(run.gradeAudit) ? run.gradeAudit : [];
  run.gradeAudit.push(paperGradeSnapshot(run.aiGrade, reason));
  if (run.gradeAudit.length > 20) run.gradeAudit.splice(0, run.gradeAudit.length - 20);
}
function paperGradeRecalculate(grade) {
  grade.score = Math.round(grade.questions.reduce((sum, item) => sum + (Number(item.points) || 0), 0) * 100) / 100;
  grade.wrongNos = grade.questions.filter((item) => item.status !== 'correct').map((item) => item.no);
  grade.uncertainNos = grade.questions.filter((item) => item.status === 'uncertain').map((item) => item.no);
  return grade;
}
function paperSourceUpdateExtMock(source, run) {
  S.extMocks = S.extMocks || [];
  const grade = run.aiGrade;
  if (!grade) return;
  const tags = paperRunLearningTags(run);
  const record = {
    id: `external-${run.id}`, paperRunId: run.id, sourceId: source.id, d: run.d || today(), ts: run.submittedAt,
    name: source.title, score: grade.score, total: 100, questions: source.questions,
    calibrationEligible: source.questions === 20 && source.calibrationEligible !== false,
    minutesLeft: Math.max(0, Math.round(run.remainingMs / 60000)),
    topics: tags.topics, errors: tags.errors,
    err: tags.errors[0] || String(run.err || ''),
    note: `${grade.wrongNos.length ? `錯題 ${grade.wrongNos.join('、')}` : '全對'}${run.note ? `｜${run.note}` : ''}`,
    mt: run.mt,
  };
  const existing = S.extMocks.findIndex((item) => item && item.paperRunId === run.id);
  if (existing >= 0) S.extMocks[existing] = { ...S.extMocks[existing], ...record };
  else S.extMocks.push(record);
}
function paperRunLearningTags(run) {
  const topics = new Set(Array.isArray(run && run.topics) ? run.topics : []);
  const errors = new Set(Array.isArray(run && run.errors) ? run.errors : []);
  for (const state of Object.values(run && run.review || {})) {
    if (!state || typeof state !== 'object') continue;
    if (state.topic) topics.add(state.topic);
    if (state.errorKind) errors.add(state.errorKind);
    if (state.aiErrorKind) errors.add(state.aiErrorKind);
    for (const log of state.logs || []) {
      if (log && log.topic) topics.add(log.topic);
      if (log && log.errorKind) errors.add(log.errorKind);
    }
  }
  return { topics: [...topics].filter((key) => TOPICS[key]), errors: [...errors].filter(Boolean) };
}
function paperRunRefreshLearningTags(run) {
  const tags = paperRunLearningTags(run);
  run.topics = tags.topics;
  run.errors = tags.errors;
  return tags;
}
function paperSourceRecordGrade(source, run, grade) {
  if (run.aiGrade) paperGradeAuditPush(run, 'AI 重新批改前');
  run.aiGrade = grade;
  run.score = grade.score;
  run.wrongNos = grade.wrongNos;
  run.note = grade.uncertainNos.length ? `AI 看不清楚：${grade.uncertainNos.join('、')}` : '';
  run.gradeDraft = null;
  run.status = 'awaiting-correction';
  run.submittedAt = run.submittedAt || Date.now();
  run.due = run.due || addDays(run.d || today(), 1);
  run.mt = Date.now();
  paperSourceUpdateExtMock(source, run);
  save();
}
function paperSourceGradeLoading(source, reason, progress, error) {
  app().innerHTML = `<div class="paper-grade-loading card${error ? ' warn' : ''}"><span class="eyebrow">第一次批改｜GPT‑5.5 整卷視覺核分</span><h1>${error ? '這次批改沒有完成' : escH(reason)}</h1><p id="paper-grade-progress">${escH(progress)}</p>
    ${error ? `<p class="warnc">${escH(error)}</p><div class="actr"><button class="btn" onclick="exitFlow()">先離開</button><button class="btn primary" onclick="paperSourceGrade('重新批改')">重新批改整份原卷</button></div>` : '<div class="paper-grade-pulse" aria-hidden="true"><span></span></div><p class="dim">正在辨識卷面上的黑、藍、綠筆跡並逐題核分。這一輪會在錯答旁標出正解，但不分析步驟，也不提供詳解。</p>'}
    <small>${escH(source.title)}｜請保持此頁開啟；即使失敗，原筆跡也不會消失。</small></div>`;
  sessionChrome(true);
}
async function paperSourceGrade(reason) {
  if (!paperSourceSession || paperSourceSession.grading) return;
  stopTicker();
  const session = paperSourceSession, { source, run } = session;
  session.grading = true;
  const remaining = paperRunLeft(run);
  paperInkCommitCurrent();
  const [journalOk, saved] = await Promise.all([paperInkJournalDrain(session), paperInkPersist(true)]);
  if (!journalOk || (!saved && paperInkPage() && paperInkPage().dirty)) {
    session.grading = false;
    renderPaperSource();
    alert('最後一筆尚未安全保存，已取消交卷。請保持頁面開啟，等右上顯示「已保存」後再交卷。');
    return;
  }
  run.remainingMs = remaining; run.resumeAt = null; run.status = 'grading'; run.gradeReason = reason; run.mt = Date.now();
  paperRecoveryClose(run, 'grading');
  save();
  sessionMode = 'paper-grade';
  paperSourceGradeLoading(source, reason, `正在整理第 1 / ${source.scans.length} 頁…`);
  try {
    const pages = [];
    for (let page = 0; page < source.scans.length; page++) {
      const progress = $('#paper-grade-progress');
      if (progress) progress.textContent = `正在整理第 ${page + 1} / ${source.scans.length} 頁…`;
      pages.push(await paperPageComposite(page));
    }
    const progress = $('#paper-grade-progress');
    if (progress) progress.textContent = `已送出 ${source.scans.length} 頁，正在逐題辨識與核分…`;
    const response = await paperAiGradeCall(source, pages);
    const grade = paperNormalizeAiGrade(source, response.json, response.model);
    grade.requestId = response.requestId;
    grade.usage = response.usage;
    grade.budget = response.budget;
    grade.promptVersion = 'paper-grade-first-pass-v2';
    if (run.status === 'discarded') return;
    paperSourceRecordGrade(source, run, grade);
    if (paperSourceSession === session) {
      session.grading = false;
      session.readOnly = true;
      session.page = 0;
      session.zoom = 1;
      sessionMode = 'paper-result';
      sessionActive = false;
      renderPaperGradeResult();
    }
  } catch (error) {
    run.status = 'grading'; run.resumeAt = null; run.mt = Date.now(); save();
    if (paperSourceSession === session) {
      session.grading = false;
      paperSourceGradeLoading(source, '批改未完成', '原筆跡已保留，可以直接重試。', (error && error.message) || String(error));
    }
  }
}
function renderPaperGradeResult() {
  if (!paperSourceSession) return renderMockIntro();
  const { source, run, urls } = paperSourceSession, grade = run.aiGrade;
  if (!grade) return paperSourceGradeLoading(source, '批改未完成', '找不到完整批改結果，請重新批改。', '批改資料尚未完成');
  const page = paperSourceSession.page, scan = source.scans[page];
  const uncertain = Array.isArray(grade.uncertainNos) ? grade.uncertainNos : [];
  app().innerHTML = `<div class="paper-session-shell is-graded">
    <div class="paper-workbar"><div class="paper-work-title"><b>第一次批改｜對錯、分數、正確答案</b><small>${escH(source.title)}</small></div><strong class="paper-result-score">${grade.score} / 100</strong>
      <div class="paper-workgroup right">${paperAiToggleButtonHTML()}<button class="paper-icon-btn" onclick="paperWorkspaceZoom(-.25)" aria-label="縮小題本">−</button><span id="paper-zoom-label" class="paper-zoom-label">${Math.round(paperSourceSession.zoom * 100)}%</span><button class="paper-icon-btn" onclick="paperWorkspaceZoom(.25)" aria-label="放大題本">＋</button><span class="paper-page-label"><b>${page + 1} / ${source.scans.length}</b><small>${escH(scan.label)}</small></span><button class="paper-icon-btn" onclick="paperWorkspacePage(-1)" ${page <= 0 ? 'disabled' : ''} aria-label="上一頁">${uiIcon('arrow-left')}</button><button class="paper-icon-btn" onclick="paperWorkspacePage(1)" ${page >= source.scans.length - 1 ? 'disabled' : ''} aria-label="下一頁">${uiIcon('arrow-right')}</button><button class="paper-icon-btn" onclick="paperSourceCloseResult()" aria-label="關閉批改結果">${uiIcon('x')}</button></div></div>
    <div class="paper-workspace" aria-label="你的原筆跡＋AI 紅筆標記"><section class="paper-source-pane"><div class="paper-page-viewport"><div class="paper-spread"><div id="paper-write-sheet" class="paper-write-sheet" data-side="${scan.side}"><div class="paper-question-crop"><img id="paper-source-image" src="${urls[page]}" alt="${escH(source.title)} ${escH(scan.label)}"></div><div class="paper-note-margin" aria-hidden="true"></div><canvas id="paper-ink-canvas" aria-label="可左右滑動查看 AI 紅筆批改的題本頁"></canvas><canvas id="paper-ai-canvas" aria-label="AI 紅筆批改標記"></canvas></div></div></div></section></div>
    <div class="paper-finish-bar paper-result-bar"><span>錯題：${grade.wrongNos.length ? grade.wrongNos.join('、') : '無'}${uncertain.length ? `｜看不清楚：${uncertain.join('、')}` : ''}｜逐題詳解於 ${run.due} 開放</span><div class="paper-result-actions"><button class="btn" onclick="paperGradeAuditOpen()">核對／修正分數</button><button class="btn" onclick="paperSourceRegrade()">重新 AI 簡批</button><button id="paper-export-pdf" class="btn" onclick="paperExportGradedPdf()">${uiIcon('save')}輸出 PDF</button><button class="btn primary" onclick="paperSourceCloseResult()">完成</button></div></div>
    <button id="paper-ui-toggle" class="paper-ui-toggle" onclick="paperUiToggle()" aria-label="收起工具" aria-pressed="false">${uiIcon('pencil')}<span>收起</span></button></div>`;
  sessionChrome(true);
  paperInkAttach();
}
async function openPaperGradeResult(runId) {
  const run = (S.paperRuns || []).find((item) => item && item.id === runId);
  const source = run && paperSourceById(run.sourceId);
  if (!run || !source || !run.aiGrade) { alert('找不到這一回的完整批改結果。'); return false; }
  if (!supa || !syncState.user) { alert('請先登入，才能載入私有原卷與完整筆跡。'); return false; }
  paperSourceRelease();
  app().innerHTML = `<div class="card"><h1>正在載入 ${escH(source.title)}批改卷</h1><p class="dim">正在合併私有原掃描、考試筆跡與 AI 紅筆。</p></div>`;
  try {
    const urls = await paperSourceFiles(source);
    run.paperInkClients = run.paperInkClients || {};
    const inkPages = await paperInkLoadAll(run, source);
    paperSourceSession = {
      source, run, urls, inkPages, page:0, zoom:1, inkMode:'pen',
      inkWidth:paperInkWidthValue(run.paperInkWidth), inkColor:'black', readOnly:true,
      inkUserId:syncState.user ? syncState.user.id : null,
      inkClientIds:Object.fromEntries(source.scans.map((_, page) => [page, paperInkClientFor(run, page)])),
    };
    sessionMode = 'paper-result';
    sessionActive = false;
    renderPaperGradeResult();
    return true;
  } catch (error) {
    paperSourceRelease();
    alert(`批改卷載入失敗：${(error && error.message) || error}`);
    nav('mock');
    return false;
  }
}
function paperGradeAuditOpen() {
  if (!paperSourceSession || !paperSourceSession.run || !paperSourceSession.run.aiGrade) return;
  const { source, run } = paperSourceSession;
  const rows = run.aiGrade.questions.map((item) => {
    const key = source.key[item.no - 1];
    const options = [
      ['correct', '正確'], ['incorrect', '錯誤'], ['unanswered', '未答'], ['uncertain', '看不清楚'],
    ].map(([value, label]) => `<option value="${value}"${item.status === value ? ' selected' : ''}>${label}</option>`).join('');
    return `<tr data-no="${item.no}"><th>${item.no}</th><td>${escH(paperFinalAnswerText(key))}</td><td><select class="paper-audit-status" aria-label="第 ${item.no} 題狀態">${options}</select></td><td><input class="paper-audit-points" type="number" min="0" max="${Number(key.points) || 0}" step="1" value="${Number(item.points) || 0}" aria-label="第 ${item.no} 題得分"> / ${Number(key.points) || 0}</td></tr>`;
  }).join('');
  const history = Array.isArray(run.gradeAudit) ? run.gradeAudit.length : 0;
  modal(`<div class="paper-grade-audit"><span class="eyebrow">人工覆核</span><h2>逐題核對分數</h2><p>只在確認 AI 看錯答案或配分時修改。每次修改前的版本都會保留，不會覆蓋歷史。</p><div class="paper-audit-scroll"><table><thead><tr><th>題</th><th>正解</th><th>判定</th><th>得分</th></tr></thead><tbody>${rows}</tbody></table></div><p class="dim">目前已有 ${history} 份歷史批改快照。</p><button class="btn primary" onclick="paperGradeAuditSave()">保存人工覆核</button></div>`, [['取消']]);
}
function paperGradeAuditSave() {
  if (!paperSourceSession || !paperSourceSession.run || !paperSourceSession.run.aiGrade) return;
  const { source, run } = paperSourceSession;
  const grade = run.aiGrade;
  const rows = [...document.querySelectorAll('.paper-grade-audit tbody tr')];
  if (rows.length !== grade.questions.length) { alert('覆核表不完整，沒有修改任何分數。'); return; }
  paperGradeAuditPush(run, '人工覆核前');
  const adjustedAt = Date.now();
  for (const row of rows) {
    const no = Number(row.dataset.no), item = grade.questions.find((question) => question.no === no);
    const key = source.key[no - 1];
    if (!item || !key) continue;
    const status = row.querySelector('.paper-audit-status').value;
    const points = Math.max(0, Math.min(Number(key.points) || 0, Number(row.querySelector('.paper-audit-points').value) || 0));
    const nextStatus = ['correct', 'incorrect', 'unanswered', 'uncertain'].includes(status) ? status : 'uncertain';
    const nextPoints = Math.round(points * 100) / 100;
    const changed = item.status !== nextStatus || Number(item.points) !== nextPoints;
    item.status = nextStatus;
    item.points = nextPoints;
    if (changed) {
      item.manual = true;
      item.manualAt = adjustedAt;
      item.mt = adjustedAt;
    }
    const kind = item.status === 'correct' ? 'check'
      : item.status === 'incorrect' && item.points > 0 ? 'partial'
      : item.status === 'incorrect' ? 'cross'
      : item.status === 'unanswered' ? 'unanswered' : 'uncertain';
    const first = Array.isArray(item.marks) && item.marks[0]
      ? { ...item.marks[0], kind, option:0 }
      : paperFallbackMark(source, no, paperQuestionScanIndex(source, no) + 1, '', kind, 0, 0);
    item.marks = [first];
  }
  grade.model = String(grade.model || 'gpt-5.5');
  grade.adjustedAt = adjustedAt;
  grade.adjustmentCount = (Number(grade.adjustmentCount) || 0) + 1;
  paperGradeRecalculate(grade);
  run.score = grade.score;
  run.wrongNos = grade.wrongNos.slice();
  run.note = grade.uncertainNos.length ? `AI／人工仍看不清楚：${grade.uncertainNos.join('、')}` : '';
  run.mt = Date.now();
  paperSourceUpdateExtMock(source, run);
  save();
  modalClose();
  renderPaperGradeResult();
}
function paperSourceRegrade() {
  if (!paperSourceSession || !paperSourceSession.run || !paperSourceSession.run.aiGrade) return;
  modal('<h2>重新進行第一次 AI 簡批？</h2><p>會重新辨識全部頁面，但仍只給對錯、分數與正解，不會開詳解。現在的批改結果會先存入稽核歷史。</p>', [
    ['取消'],
    ['重新 AI 簡批', () => paperSourceGrade('重新 AI 簡批'), 'primary'],
  ]);
}
function paperSourceCloseResult() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  paperSourceRelease();
  nav('mock');
}
let mock = null;
function buildPaper(forVision) {
  const usedIds = new Set(), usedGroups = new Set(), topicUse = {};
  const ac = attCountMap();
  const visionUse = new Map();
  if (forVision) for (const row of S.visionHistory || []) visionUse.set(row.qid, (visionUse.get(row.qid) || 0) + 1);
  const eligible = (q) => !usedIds.has(q.id) && !(q.grp && usedGroups.has(q.grp)) && !(q.src && packIsOff(q.src));
  const choose = (type, count, diffPattern) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const want = diffPattern[i % diffPattern.length];
      let pool = BANK.filter((q) => q.type === type && q.diff === want && eligible(q));
      if (!pool.length) pool = BANK.filter((q) => q.type === type && eligible(q));
      pool.sort((a, b) => ((topicUse[a.topic] || 0) - (topicUse[b.topic] || 0))
        || (((ac.get(a.id) || 0) + (visionUse.get(a.id) || 0) * 4) - ((ac.get(b.id) || 0) + (visionUse.get(b.id) || 0) * 4)) || (Math.random() - 0.5));
      const q = pool[0]; if (!q) break;
      usedIds.add(q.id); if (q.grp) usedGroups.add(q.grp); topicUse[q.topic] = (topicUse[q.topic] || 0) + 1;
      out.push(q);
    }
    return out;
  };
  const lastVisionPaper = forVision ? (S.visionQueue || []).filter((x) => x.paperId && x.mixedGroupId).sort((a, b) => Number(b.paperTs || 0) - Number(a.paperTs || 0))[0] : null;
  const previousGroup = forVision
    ? (lastVisionPaper && lastVisionPaper.mixedGroupId)
    : ((S.mocks && S.mocks.length) ? S.mocks[S.mocks.length - 1].mixedGroupId : null);
  const candidates = MOCK_MIXED_GROUPS.filter((g) => g.id !== previousGroup);
  const mixedGroup = (candidates.length ? candidates : MOCK_MIXED_GROUPS)[Math.floor(Math.random() * (candidates.length || MOCK_MIXED_GROUPS.length))];
  const mixedQuestions = mixedGroup.items.map((q, index) => ({
    ...q,
    grp: mixedGroup.id,
    groupId: mixedGroup.id,
    groupTitle: mixedGroup.title,
    stem: `${index === 0 ? '【共享題幹】' : '【同一題組，題幹重列】'}${mixedGroup.stem}`,
    responseType: 'written',
  }));
  const sections = [
    { spec: MOCK_SPEC.sections[0], qs: choose('single', 6, [1, 2, 2, 3, 2, 1]) },
    { spec: MOCK_SPEC.sections[1], qs: choose('multi', 6, [1, 2, 2, 3, 2, 1]) },
    { spec: MOCK_SPEC.sections[2], qs: choose('fill', 5, [1, 2, 2, 3, 2]) },
    { spec: MOCK_SPEC.sections[3], qs: mixedQuestions },
  ];
  const paper = [];
  for (const section of sections) for (let i = 0; i < section.qs.length; i++) {
    paper.push({ ...section.qs[i], examNo: paper.length + 1, examSection: section.spec.key, points: section.spec.points[i] });
  }
  buildPaper.lastMixedGroupId = mixedGroup.id;
  return paper;
}
function startMock() {
  if (!syncGate()) return;
  const paper = buildPaper();
  if (paper.length !== MOCK_SPEC.total) { alert(`題庫目前只能組出 ${paper.length} 題，尚不足正式 20 題結構。`); return; }
  mock = {
    paper, orig: paper.slice(), i: 0, round: 1, skipped: [],
    mixedGroupId: buildPaper.lastMixedGroupId,
    answers: {}, times: {}, proc: {}, exclude: {}, judge: {},
    tEnd: Date.now() + MOCK_SPEC.minutes * 60 * 1000, t0: 0, sessT0: Date.now(),
  };
  sessionActive = true;
  sessionMode = 'mock';
  mockNext();
}
function mockNext() {
  if (Date.now() >= mock.tEnd) return mockGrade('時間到！');
  if (mock.i >= mock.paper.length) {
    if (mock.round === 1 && mock.skipped.length) {
      mock.round = 2; mock.paper = mock.skipped.slice(); mock.skipped = []; mock.i = 0;
      app().innerHTML = `<div class="card good"><h2>第一輪完成</h2>
        <p>剩餘 <b>${fmtClock(mock.tEnd - Date.now())}</b>，回頭處理 ${mock.paper.length} 題先放著的題。照你自己的考場策略完成，不提供單題速度提示。</p>
        <div class="actr"><button class="btn primary" onclick="mockQ()">進入第二輪</button></div></div>`;
      return;
    }
    return mockGrade('全部作答完成');
  }
  mockQ();
}
function mockQ() {
  const q = mock.paper[mock.i];
  mock.t0 = Date.now();
  (mock.qSeen = mock.qSeen || {});
  (mock.qSeen[q.id] = mock.qSeen[q.id] || []).push(mock.t0); // 每輪進場時間：卡點分析只看最後一輪，跨輪空檔不算停頓
  mock.qlock = false;
  mock.sel = null; // 單選劃卡狀態逐題歸零
  const mockRow = `<div class="mock-actions">
      ${mock.round === 1 ? `<button class="btn skip" onclick="mockSkip()">先放著，稍後回來</button>` : `<button class="btn skip" onclick="mockGiveup()">暫不作答</button>`}</div>`;
  let actions;
  if (q.type === 'single') {
    actions = `<div class="actr"><button class="btn primary" id="mock-submit" disabled onclick="mockAns(mock.sel)">送出此題</button></div>${mockRow}`; // 點選項＝劃卡，送出才鎖定
  } else if (q.type === 'multi') {
    actions = `<div class="actr"><button class="btn primary" onclick="mockAns()">送出此題</button></div>${mockRow}`;
  } else {
    const writtenHint = q.examSection === 'mixed' ? `<p class="dim fs13">這是共享題幹的非選擇小題。請在計算區留下破題方向、關鍵推導與最後答案；即使算不完也要保留方向。</p>
      <label class="field-label" for="mock-direction">若沒有在手寫區寫方向，請在這裡補一句</label><textarea id="mock-direction" rows="2" placeholder="先做什麼，以及為什麼／想得到什麼"></textarea>` : '';
    actions = `${writtenHint}<div class="actr"><button class="btn primary big" onclick="mockAns()">完成作答，送出此題</button></div>
      <details class="typed-opt"${typedOpen ? ' open' : ''} ontoggle="typedOpen=this.open"><summary class="dim">改用打字（選用）</summary>
      <input id="qin" class="ans-input" autocomplete="off" placeholder="答案（分數用 a/b）" onkeydown="if(event.key==='Enter')mockAns()"></details>${mockRow}`;
  }
  app().innerHTML = `
    <div class="session-head">
      <span>第${mock.round === 1 ? '一' : '二'}輪｜第 ${q.examNo} 題｜${sectionLabel(q)}｜${q.points} 分</span>
      <span class="shr"><span id="mclock" class="timer">${fmtClock(mock.tEnd - Date.now())}</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div class="mock-paper-nav" aria-label="整回 20 題導覽"><span><b>整回題號</b><small>已答 ${Object.keys(mock.answers).length} / ${mock.orig.length}</small></span><div>${mock.orig.map((item) => `<i class="${item.id === q.id ? 'current' : mock.answers[item.id] ? 'done' : mock.skipped.some((skip) => skip.id === item.id) ? 'skipped' : ''}">${item.examNo}</i>`).join('')}</div></div>
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    ${bkCard(q, '第 ' + (mock.i + 1) + ' 題', 'mockAns', actions)}`;
  sessionChrome(true);
  inkStart(q.id, mock.t0, mock.sessT0); // 第二輪回頭時保留第一輪筆跡；更早的舊筆跡歸檔
  startTicker(() => {
    const left = mock.tEnd - Date.now();
    if (left <= 0) { mockGrade('時間到！'); return; }
    const c = $('#mclock'); if (c) c.textContent = fmtClock(left);
  });
}
function mockInkDone(qid) {
  const t0 = mock.t0;
  const p = inkStop();
  if (p) mock.proc[qid] = mergeProc(mock.proc[qid], p);
  syncInk(qid, t0, Object.assign({ mode: 'mock' }, p || {}));
}
/* 模擬單選的「劃卡」：先選取標記，按「送出此題」才真正作答 */
function mockPick(i, el) {
  if (!mock || mock.qlock) return;
  mock.sel = i;
  document.querySelectorAll('.bk-opt').forEach((o) => o.classList.remove('picked'));
  if (el) el.classList.add('picked');
  const b = $('#mock-submit'); if (b) b.disabled = false;
}
function mockAns(optIdx) {
  if (!mock || mock.qlock || Date.now() - mock.t0 < 350) return; // 350ms 內＝double-tap 殘留，忽略
  if (optIdx == null && mock.paper[mock.i].type === 'single') return; // 單選還沒劃卡不能送
  mock.qlock = true;
  const q = mock.paper[mock.i];
  const elapsed = Date.now() - mock.t0;
  const direction = q.examSection === 'mixed' && $('#mock-direction') ? $('#mock-direction').value.trim() : '';
  const activeInk = sessionInk[q.id] ? sessionInk[q.id].s.filter((s) => !s.dead && s.t0 >= mock.t0).length : 0;
  if (q.examSection === 'mixed' && !activeInk && direction.length < 8) {
    mock.qlock = false;
    alert('混合／非選擇題要留下可給老師看的破題方向：請在計算區寫出推導，或在文字欄寫出「先做什麼」與「為什麼」。');
    return;
  }
  let ans;
  if (q.type === 'single') ans = { type: 'single', v: optIdx };
  else if (q.type === 'multi') ans = { type: 'multi', v: [...document.querySelectorAll('.bk-opts input:checked')].map((i) => +i.value) };
  else {
    const typed = $('#qin') ? $('#qin').value.trim() : '';
    ans = typed ? { type: 'fill', v: typed } : { type: 'inkfill' };
  }
  if (q.examSection === 'mixed') ans.direction = direction.slice(0, 500);
  const commit = (excluded) => {
    if (excluded) mock.exclude[q.id] = 1;
    mock.answers[q.id] = ans;
    mock.times[q.id] = (mock.times[q.id] || 0) + elapsed;
    mockInkDone(q.id);
    mock.i++;
    stopTicker();
    mockNext();
  };
  if (elapsed >= 360000) {
    stopTicker();
    modal(`<h2>⏸ 這題用了 ${fmtSec(elapsed)}</h2><p>是不是有中途離開座位？有的話這題不列入成績與數據，避免污染。</p>`, [
      ['有離開，這題不列入', () => commit(true)],
      ['沒有離開，正常記錄', () => commit(false)],
    ]);
    return;
  }
  commit(false);
}
function mockSkip() {
  if (!mock || mock.qlock || Date.now() - mock.t0 < 350) return;
  mock.qlock = true;
  const q = mock.paper[mock.i];
  mock.times[q.id] = (mock.times[q.id] || 0) + (Date.now() - mock.t0);
  mockInkDone(q.id);
  mock.skipped.push(q);
  mock.i++;
  stopTicker();
  mockNext();
}
function mockGiveup() {
  if (!mock || mock.qlock || Date.now() - mock.t0 < 350) return;
  mock.qlock = true;
  const q = mock.paper[mock.i];
  mock.times[q.id] = (mock.times[q.id] || 0) + (Date.now() - mock.t0);
  mockInkDone(q.id);
  mock.i++;
  stopTicker();
  mockNext();
}
function mockGrade(reason, partial) {
  stopTicker();
  if (ink) mockInkDone(ink.qid);
  modalClose();
  mock.reason = reason;
  mock.partial = !!partial;
  // 完整模擬＝整份原卷（含未作答）；中途保留＝只結算作答過的題。排除「離開座位」題。
  mock.graded = (partial ? mock.orig.filter((q) => mock.answers[q.id]) : mock.orig)
    .filter((q) => !mock.exclude[q.id]);
  const inkfills = mock.graded.filter((q) => { const a = mock.answers[q.id]; return a && a.type === 'inkfill'; });
  if (inkfills.length) {
    // 批改期間紀錄還沒寫入——維持 session 守衛，nav 會先確認，避免一點就整場蒸發
    sessionActive = true;
    sessionMode = 'judging';
    return mockJudgePanel(inkfills);
  }
  mockFinal();
}
/* 手寫填充題的批改面板：AI 先批（有 key 時），人工可改判 */
function mockJudgePanel(list) {
  sessionChrome(false);
  mock.toJudge = list;
  const items = list.map((q, i) => {
    const img = inkCaptureFull(q.id, true);
    return `<div class="judge-item">
      <div class="judge-img">${img ? `<img src="${img}" alt="手寫過程">` : '<span class="dim">（沒有筆跡）</span>'}</div>
      <div class="judge-info">
        <div class="wc-q fs13 dim" style="margin-bottom:4px">${q.stem ? `<div class="bk-stem">${rtTxt(q.stem)}</div>` : ''}${rtTxt(q.q)}</div>
        <p class="dim">第 ${q.examNo} 題｜批改用最終答案：<b class="big">${q.type === 'fill' ? mDispOpt(String(q.ans[0])) : q.ans.map((a) => `(${a + 1})`).join('')}</b></p>
        <div id="jai-${i}"></div>
        <div class="actr"><button class="btn sm err" id="jbad-${i}" onclick="mockJudgeSet(${i}, false)">✗ 錯</button>
        <button class="btn sm okb" id="jok-${i}" onclick="mockJudgeSet(${i}, true)">✓ 對</button></div>
      </div>
    </div>`;
  }).join('');
  app().innerHTML = `
    <h1>📝 批改手寫題（${list.length} 題）</h1>
    <div class="card">
      <p>這一步只完成對錯判定，不分析錯法、不訂正。逐題對照手寫答案與最終答案（等價形式、順序不同都算對），按對或錯。
      ${aiEnabled() ? '' : '<span class="dim">（登入雲端同步後，OpenAI 可協助先判對錯。）</span>'}</p>
      ${items}
      <p id="jmsg" class="dim"></p>
      <div class="actr"><button class="btn primary big" onclick="mockJudgeDone()">完成批改，看結果</button></div>
    </div>`;
  if (aiEnabled()) mockAIJudge();
}
function mockJudgeSet(i, ok) {
  const q = mock.toJudge[i];
  mock.judge[q.id] = ok;
  const a = $('#jok-' + i), b = $('#jbad-' + i);
  if (a) a.className = 'btn sm okb' + (ok ? ' active' : '');
  if (b) b.className = 'btn sm err' + (!ok ? ' active' : '');
}
async function mockAIJudge() {
  const m = mock; // 綁定本場：使用者若放棄離開再開新模擬，遲到的回應不可寫進新場
  const msgEl = $('#jmsg');
  m.aiv = m.aiv || {};
  for (let i = 0; i < m.toJudge.length; i++) {
    if (mock !== m || sessionMode !== 'judging') return;
    const q = m.toJudge[i];
    if (msgEl) msgEl.textContent = `🤖 AI 批改中… ${i + 1} / ${m.toJudge.length}`;
    try {
      const img = inkCaptureFull(q.id);
      if (!img) { const box = $('#jai-' + i); if (box) box.innerHTML = '<p class="dim">（這題沒有手寫作答，AI 不亂猜——請你人工判 ✓/✗）</p>'; continue; } // 沒圖不送批改、更不盲判
      const visits = (m.qSeen && m.qSeen[q.id]) || [];
      // 只用「最後一輪進場」當窗：第一輪跳過→第二輪回頭之間去寫別題的幾分鐘不是卡點，秒數也才會相對本題
      const shots = inkStuckShots(q.id, visits.length ? visits[visits.length - 1] : m.sessT0);
      const ord = inkOrderedShot(q.id);
      const v = await aiGradeCall(q, q.ans.join(' 或 '), (ord && ord.b64) || img, shots, ord ? ord.steps : 0);
      if (mock !== m || sessionMode !== 'judging') return;
      m.aiv[q.id] = v;
      const stuck = normStuck(v, shots); // 卡點跟著這題的 proc 走，mockFinal 記錄時自然入庫
      if (stuck.length) { m.proc[q.id] = m.proc[q.id] || {}; m.proc[q.id].stuck = stuck; }
      const box = $('#jai-' + i);
      if (box) box.innerHTML = `<p class="dim">AI 初判：<b>${aiCorrect(v) ? '對' : '錯'}</b>。過程分析已封存到隔日訂正，不在今天顯示。</p>`;
      if (m.judge[q.id] === undefined) mockJudgeSet(i, aiCorrect(v));
    } catch (e) {
      const box = $('#jai-' + i);
      if (box) box.innerHTML = `<p class="warnc">⚠ AI 批改失敗：${escH((e && e.message) || e)}——請人工批這題。</p>`;
    }
  }
  if (mock === m && msgEl && msgEl.isConnected) msgEl.textContent = 'AI 初判完成——請逐題確認對或錯，再完成今天的批改。';
}
function mockJudgeDone() {
  const missing = mock.toJudge.filter((q) => mock.judge[q.id] === undefined);
  if (missing.length) { const m = $('#jmsg'); if (m) m.textContent = `還有 ${missing.length} 題沒批——每題要按 ✓ 或 ✗。`; return; }
  mockFinal();
}
function mockAnswerResult(q, a) {
  if (!a) return { ok: false, yourAns: '（未作答）', points: 0 };
  let ok = false, yourAns = '（未作答）';
  if (a.type === 'single') { ok = a.v === q.ans[0]; yourAns = `(${a.v + 1})`; }
  else if (a.type === 'multi') {
    const chosen = Array.isArray(a.v) ? a.v : [];
    ok = chosen.length === q.ans.length && q.ans.every((x) => chosen.includes(x));
    yourAns = chosen.length ? chosen.map((c) => `(${c + 1})`).join('') : '（未選）';
  } else if (a.type === 'inkfill') { ok = !!mock.judge[q.id]; yourAns = '（手寫）'; }
  else { ok = checkFill(a.v, q.ans); yourAns = a.v || '（空白）'; }
  let points = ok ? q.points : 0;
  if (a.type === 'multi' && !ok) points = multiPartialPoints(q.points, a.v, q.ans, (q.opts || []).map((_, i) => i));
  return { ok, yourAns, points: Math.round(points * 100) / 100 };
}
function queueMockCorrection(detail, mockTs) {
  const entries = detail.map((x) => ({
    qid: x.q.id, examNo: x.q.examNo, examSection: x.q.examSection, points: x.q.points,
    yourAns: x.yourAns, answered: x.answered, correctOnExam: !!x.ok,
    examDirection: x.examDirection || '', examStrokes: Number(x.examStrokes) || 0,
    done: !!x.ok, level: x.ok ? 1 : null, outcome: x.ok ? 'direct' : null,
    attempts: 0, logs: [], solutionUnlockedAt: null,
    completedAt: x.ok ? mockTs : null,
  }));
  const batch = { id: `mock-${mockTs}`, d: today(), due: addDays(today(), 1), mockTs, mt: mockTs, name: '系統全真模考', entries };
  S.corrections = S.corrections || [];
  S.corrections.push(batch);
  return batch;
}
function mockFinal() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  const paper = mock.graded;
  const detail = paper.map((q) => {
    const a = mock.answers[q.id];
    const ms = mock.times[q.id] || 0;
    const result = mockAnswerResult(q, a);
    // 模考錯題由隔日訂正佇列接管，不進立即可看的舊錯題庫。
    if (a) recordAttempt(q, result.ok, ms, result.ok ? null : '概念不熟', 'mock', mock.proc[q.id] || null, mock.aiv && mock.aiv[q.id], { skipWrong: true });
    return { q, ms, answered: !!a, examDirection: (a && a.direction) || '', examStrokes: Number(mock.proc[q.id] && mock.proc[q.id].n) || 0, ...result };
  });
  const okN = detail.filter((x) => x.ok).length;
  const score = Math.round(detail.reduce((sum, x) => sum + x.points, 0) * 100) / 100;
  const acc = score / 100;
  const wrongNos = detail.filter((x) => !x.ok).map((x) => x.q.examNo);
  const unansweredNos = detail.filter((x) => !x.answered).map((x) => x.q.examNo);
  let mockTrend = '';
  if (!mock.partial && S.mocks.length >= 1) {
    const prev = S.mocks[S.mocks.length - 1];
    const prevScore = prev.score != null ? prev.score : Math.round(prev.acc * 100);
    mockTrend = `<p class="dim">上次 ${prevScore}/100 → 這次 ${score}/100</p>`;
  }
  const mockTs = Date.now();
  let batch = null;
  if (!mock.partial) {
    S.mocks.push({ d: today(), score, total: 100, ok: score, n: 100, questionOk: okN, questionN: paper.length, acc, mixedGroupId: mock.mixedGroupId || null, ts: mockTs });
    batch = queueMockCorrection(detail, mockTs);
  }
  save();
  const rows = detail.map((x) => `<tr><td>第 ${x.q.examNo} 題</td><td>${x.ok ? '對' : x.answered ? '錯' : '未作答'}</td><td>${x.points} / ${x.q.points}</td></tr>`).join('');
  app().innerHTML = `
    <h1>今日批改完成</h1>
    ${mock.partial ? '<div class="card warn">中途結束：只結算你作答過的題，不列入模擬成績走勢（每題紀錄與筆跡照樣保存）。</div>' : ''}
    <div class="card">
      <p class="big">得分 <b>${score} / 100</b>｜完全答對 ${okN} / ${paper.length} 題</p>
      ${mockTrend}
      <p>錯題號：<b>${wrongNos.length ? wrongNos.join('、') : '無'}</b>${unansweredNos.length ? `｜未作答：${unansweredNos.join('、')}` : ''}</p>
      <div class="tblwrap"><table class="tbl"><tr><th>題號</th><th>判定</th><th>得分</th></tr>${rows}</table></div>
      ${batch ? `<div class="warn"><b>今天到此為止，不訂正。</b>答案、章節與詳解都不在這頁顯示。答對的 ${okN} 題已列為「第一級：我會寫」；其餘 ${wrongNos.length} 題鎖到 <b>${batch.due}</b>，明天只看最終答案重新想方向。</div>` : ''}
      ${mock.partial ? '<p class="dim">中途結束不建立隔日訂正批次；完整 20 題交卷才納入新版模考走勢。</p>' : '<p class="dim">多選題依錯選項數給部分分數；非選擇題目前以人工／AI 對錯判定給該小題全分或零分。</p>'}
      <div class="actr"><button class="btn" onclick="nav('stats')">看模考走勢</button><button class="btn primary" onclick="nav('home')">回今日</button></div>
    </div>`;
}

/* ═══════════ 隔日盲訂正 ═══════════
   第一天只批分；到期後先只給最終答案。至少留下一次自己的重想紀錄，仍無收穫才可解鎖詳解。 */
let correction = null;
function correctionQuestion(entry) { return bankById(entry && entry.qid); }
function finalAnswerHTML(q) {
  if (!q) return '題目已不在目前題庫';
  return q.type === 'fill' ? mDispOpt(String(q.ans[0])) : q.ans.map((a) => `(${a + 1})`).join('');
}
function correctionLevel(entry) {
  return Number(entry && entry.level) || (entry && entry.outcome === 'direct' ? 1 : entry && entry.outcome === 'answer-only' ? 2 : entry && entry.outcome === 'solution' ? 3 : null);
}
function correctionCounts(batch) {
  const out = { open: 0, l1: 0, l2: 0, l3: 0 };
  for (const entry of (batch && batch.entries) || []) {
    const level = correctionLevel(entry);
    if (!entry.done) out.open++;
    else if (level) out[`l${level}`]++;
  }
  return out;
}
function renderCorrections() {
  const all = (S.corrections || []).slice().sort((a, b) => Number(b.mockTs || 0) - Number(a.mockTs || 0));
  const pending = all.filter((batch) => (batch.entries || []).some((x) => !x.done));
  const due = pending.filter((b) => String(b.due || '') <= today()).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const waiting = pending.filter((b) => String(b.due || '') > today());
  const dueCards = due.map((batch) => {
    const c = correctionCounts(batch);
    return `<div class="card"><h2>${escH(batch.name || '全真模考')}｜${batch.d}</h2>
      <p>尚待訂正 <b>${c.open}</b> 題｜第一級 ${c.l1}｜第二級 ${c.l2}｜第三級 ${c.l3}</p>
      <div class="actr"><button class="btn primary" onclick="startCorrection('${jsA(batch.id)}')">繼續盲訂正</button><button class="btn" onclick="renderTeacherReport('${jsA(batch.id)}')">給老師看這一回</button></div></div>`;
  }).join('');
  const waitingCards = waiting.map((batch) => { const c = correctionCounts(batch); return `<div class="card"><h2>${escH(batch.name || '全真模考')}｜${batch.d}</h2>
    <p>第一級 ${c.l1} 題；其餘 ${c.open} 題的<b>答案與詳解鎖到 ${batch.due}</b>，今天不訂正。</p><div class="actr"><button class="btn" onclick="renderTeacherReport('${jsA(batch.id)}')">查看目前紀錄</button></div></div>`; }).join('');
  const completed = all.filter((batch) => (batch.entries || []).length && (batch.entries || []).every((x) => x.done)).slice(0, 6);
  const completedCards = completed.map((batch) => { const c = correctionCounts(batch); return `<div class="report-row"><span>${batch.d}</span><b>第一級 ${c.l1}｜第二級 ${c.l2}｜第三級 ${c.l3}</b><button class="btn sm" onclick="renderTeacherReport('${jsA(batch.id)}')">老師檢視</button></div>`; }).join('');
  const sourceWaiting = (S.paperRuns || []).filter((run) => run && ['awaiting-key', 'awaiting-correction'].includes(run.status))
    .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
  const sourceWaitingCards = sourceWaiting.map((run) => {
    const dueNow = String(run.due || '') <= today();
    return `<div class="card paper-key-wait"><span class="eyebrow">原版紙本卷｜${dueNow ? '已到訂正日' : '尚未到期'}</span><h2>${escH(run.name || '原版模考')}｜${run.d}</h2>
      <p><b>${run.score}/100</b>｜錯題 ${Array.isArray(run.wrongNos) && run.wrongNos.length ? run.wrongNos.join('、') : '無'}。</p>
      <div class="notice"><b>${dueNow ? '今天直接在第一次紅筆卷上重新做；每一道錯題都可一按查看本題詳解。' : `逐題詳解鎖到 ${run.due}。`}</b><p>${dueNow ? '卷面先提示最終答案；請盡量在原題與留白處重新思考。需要時可直接按「看本題詳解」，看過後仍要重算並再次批改。' : '第一次批改已標出對錯、分數與正確答案；隔日才開放逐題詳解與重算。'}</p></div>
      <div class="actr"><button class="btn" onclick="openPaperGradeResult('${jsA(run.id)}')">查看第一次紅筆卷／輸出 PDF</button><button class="btn" onclick="renderPaperTeacherReport('${jsA(run.id)}')">給老師看逐題紀錄</button>${dueNow ? `<button class="btn primary" onclick="startPaperAnswerReview('${jsA(run.id)}')">在紅筆卷上開始訂正</button>` : ''}</div>
    </div>`;
  }).join('');
  const sourceCompleted = (S.paperRuns || []).filter((run) => run && run.status === 'completed' && run.aiGrade)
    .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0)).slice(0, 8);
  const sourceCompletedCards = sourceCompleted.map((run) => {
    const levels = paperRunLevelCounts(run);
    return `<div class="report-row"><span>${escH(run.d || '')}｜${escH(run.name || '原版模考')}</span><b>${run.score}/100｜第一級 ${levels.l1}・第二級 ${levels.l2}・第三級 ${levels.l3}</b><button class="btn sm" onclick="renderPaperTeacherReport('${jsA(run.id)}')">老師檢視</button></div>`;
  }).join('');
  app().innerHTML = `<h1>隔日訂正</h1>
    ${dueCards || (!sourceWaitingCards ? '<div class="card"><p>今天沒有到期的盲訂正。</p><div class="actr"><button class="btn primary" onclick="nav(\'mock\')">去做一整回混合訓練</button></div></div>' : '')}
    ${sourceWaitingCards ? `<h2>原版紙本卷</h2>${sourceWaitingCards}` : ''}
    ${waitingCards ? `<h2>尚未到期</h2>${waitingCards}` : ''}
    ${completedCards ? `<details class="card" open><summary>已完成的系統模考三級紀錄</summary><div class="report-list">${completedCards}</div></details>` : ''}
    ${sourceCompletedCards ? `<details class="card" open><summary>已完成的原版模考三級紀錄</summary><div class="report-list">${sourceCompletedCards}</div></details>` : ''}`;
}

function paperRunLevelCounts(run) {
  const counts = { l1: 0, l2: 0, l3: 0, open: 0 };
  const source = paperSourceById(run && run.sourceId);
  const grade = run && run.aiGrade;
  if (!source || !grade) return counts;
  for (let no = 1; no <= source.questions; no++) {
    const item = grade.questions.find((question) => Number(question.no) === no);
    const state = run.review && run.review[no];
    const level = item && item.status === 'correct' ? 1 : Number(state && state.level) || 0;
    if (level === 1) counts.l1++;
    else if (level === 2) counts.l2++;
    else if (level === 3) counts.l3++;
    else counts.open++;
  }
  return counts;
}
function renderPaperTeacherReport(runId) {
  const run = (S.paperRuns || []).find((item) => item && item.id === runId);
  const source = run && paperSourceById(run.sourceId);
  const grade = run && run.aiGrade;
  if (!run || !source || !grade) return renderCorrections();
  const levels = paperRunLevelCounts(run);
  const levelName = (level) => level === 1 ? '第一級｜考場會寫'
    : level === 2 ? '第二級｜只看答案能重算'
    : level === 3 ? '第三級｜需要詳解'
    : '尚未完成隔日訂正';
  const statusName = { correct:'正確', incorrect:'錯誤', unanswered:'未答', uncertain:'待人工確認' };
  const items = grade.questions.slice().sort((a, b) => Number(a.no) - Number(b.no)).map((item) => {
    const no = Number(item.no), state = run.review && run.review[no] || {};
    const level = item.status === 'correct' ? 1 : Number(state.level) || 0;
    const logs = (state.logs || []).filter((log) => String(log && log.kind || '') !== 'detail-gate').map((log, index) => `<div class="teacher-attempt"><b>第 ${index + 1} 次重想</b>
      <p>方向：${escH(log.direction || '尚未找到具體方向')}</p>
      ${log.topic || log.concept ? `<p>單元判斷：${escH(TOPICS[log.topic] || '未選單元')}${log.concept ? `／${escH(log.concept)}` : ''}</p>` : ''}
      ${log.errorKind ? `<p>自評卡點：${escH(log.errorKind)}</p>` : ''}</div>`).join('');
    const detail = state.aiDetail;
    return `<article class="teacher-q level-${level}"><header><span>第 ${no} 題｜${statusName[item.status] || item.status}｜${Number(item.points) || 0}/${Number(source.key[no - 1] && source.key[no - 1].points) || 0} 分</span><b>${levelName(level)}</b></header>
      <p class="teacher-answer">AI 讀到：${escH(item.read || '（未辨識）')}｜正確答案：${escH(paperFinalAnswerText(source.key[no - 1]))}</p>
      ${logs || (level === 1 ? '<p class="dim">考場直接答對，不需隔日重想。</p>' : '<p class="dim">尚未留下隔日重想紀錄。</p>')}
      ${detail ? `<div class="teacher-attempt"><b>逐題 AI 詳解</b>${state.detailFirstOpenedAt ? `<p>首次查看：${escH(new Date(Number(state.detailFirstOpenedAt)).toLocaleString('zh-TW', { timeZone:'Asia/Taipei', hour12:false }))}｜開啟 ${Number(state.detailViewCount) || 1} 次</p>` : ''}${detail.errorKind ? `<p>AI 錯因：${escH(detail.errorKind)}</p>` : ''}${detail.firstError ? `<p>第一個錯誤：${rtAi(detail.firstError)}</p>` : ''}${detail.nextTime ? `<p>下次訊號：${rtAi(detail.nextTime)}</p>` : ''}</div>` : ''}</article>`;
  }).join('');
  const calibration = source.calibrationEligible === false
    ? '本卷原始結構為 19 題，只作練習與訂正分析，不列入正式級分校準。'
    : '本卷為完整 20 題，可列入正式級分校準。';
  app().innerHTML = `<div class="report-head"><div><span class="eyebrow">老師檢視版｜原版模考</span><h1>${escH(source.title)}｜${escH(run.d || '')}</h1><p>${run.score}/100｜第一級 ${levels.l1}｜第二級 ${levels.l2}｜第三級 ${levels.l3}｜尚未完成 ${levels.open}</p><small>${calibration}</small></div>
    <div class="actr"><button class="btn" onclick="window.print()">列印／存成 PDF</button><button class="btn" onclick="openPaperGradeResult('${jsA(run.id)}')">查看紅筆卷</button><button class="btn primary" onclick="renderCorrections()">回隔日訂正</button></div></div>
    <div class="teacher-report">${items}</div>`;
  typesetIn(app()); scrollQuestionTop();
}

/* 原版紙本卷兩階段批改：
   第一次交卷只給對錯、分數與正式答案；隔日訂正時，每一道當前錯題都固定提供「看本題詳解」。
   詳解會保存查看時間與內容；看過後仍須在原卷訂正層重算並經 AI 再批改，才算完成第三級。 */
let paperReview = null;
function paperFinalAnswerText(q) {
  if (!q) return '答案資料不存在';
  if (q.type === 'single') return `(${q.ans[0] + 1})`;
  if (q.type === 'multi') return q.ans.map((opt) => `(${opt + 1})`).join('');
  return q.display || q.ans[0];
}
function paperQuestionScanIndex(source, no) {
  if (source.id === 'paper-mock-1') return no <= 5 ? 0 : no <= 8 ? 1 : no <= 11 ? 2 : no <= 14 ? 3 : no <= 17 ? 4 : 5;
  if (source.id === 'paper-mock-2') return no <= 4 ? 0 : no <= 7 ? 1 : no <= 10 ? 2 : no <= 13 ? 3 : no <= 17 ? 4 : 5;
  return no <= 5 ? 0 : no <= 8 ? 1 : no <= 13 ? 2 : 3;
}
async function paperReviewPageComposite(page) {
  if (!paperReview) throw new Error('隔日訂正工作階段不存在');
  return paperCompositeImage(
    paperReview.source,
    paperReview.urls,
    paperReview.baseInkPages,
    page,
    true,
    paperReview.inkPages,
    '#684d85',
  );
}
async function paperAiDetailCall(source, no, imageB64, logs) {
  const q = source.key[no - 1], answer = paperFinalAnswerText(q);
  const attempts = (logs || []).map((log, index) => ({
    attempt: index + 1,
    direction: String(log.direction || ''),
    topic: String(TOPICS[log.topic] || log.topic || ''),
    concept: String(log.concept || ''),
  }));
  const content = [{
    type: 'text',
    text: `你是台灣學測數學的訂正老師。使用者主動開啟「${source.title}」第 ${no} 題的逐題詳解。附圖已分層合成：原掃描與考試當天筆跡是底稿、紅筆是第一次簡批；如果卷面已有紫色筆跡，那是考生隔日新增的重算。

正式最終答案：${answer}
題型：${q.type}
考生隔日重想紀錄（可能尚未留下）：${JSON.stringify(attempts)}

請依序完成：
1. 先如實轉錄你看見的關鍵作答；看不清楚就明說，不可猜。
2. 若有紫色隔日訂正，優先從紫色筆跡找出「最早可證明不成立」的一步；沒有紫色筆跡時才對照考試當天底稿。若前面不是算錯，而是方向停在缺口，就精確指出缺少的推論；不可假裝看見圖上沒有的式子。
3. 不論考生是否已留下隔日重想，都要提供可完整走到正式答案、適合學測程度的詳解步驟。
4. 給一個下次看到相似條件時可立即辨識的短訊號。
5. marks 只框住第一個錯誤所在的卷面區域；若無法可靠定位，回傳空陣列。label 只寫「第一個錯誤」。

這是使用者主動要求的本題詳解，現在可以提供錯誤步驟分析與完整解法。`,
  }, {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 },
  }];
  const payload = await openAiInvoke({
    responseType: 'paper_detail',
    context: {
      paperRunId: paperReview && paperReview.run && paperReview.run.id,
      questionNo: no,
    },
    messages: [{ role: 'user', content }],
  }, 90000);
  if (!payload.json || typeof payload.json !== 'object') throw new Error('OpenAI 沒有回傳完整詳批資料');
  return { json: payload.json, model: String(payload.model || '') };
}
function paperNormalizeAiDetail(source, no, raw, model) {
  const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const marks = (Array.isArray(raw && raw.marks) ? raw.marks : []).slice(0, 2).map((mark) => {
    const box = Array.isArray(mark && mark.box) ? mark.box.map(Number) : [];
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
    return { box: box.map((n) => Math.max(0, Math.min(1, n))), label: '第一個錯誤' };
  }).filter(Boolean);
  return {
    no,
    model: model || 'gpt-5.5',
    generatedAt: Date.now(),
    readable: !!raw && raw.readable !== false,
    read: text(raw && raw.read, 300),
    firstError: !raw || raw.firstError == null ? null : text(raw.firstError, 300),
    errorKind: !raw || raw.errorKind == null ? null : text(raw.errorKind, 80),
    explanation: text(raw && raw.explanation, 1400),
    solution: (Array.isArray(raw && raw.solution) ? raw.solution : []).slice(0, 8).map((step) => text(step, 300)).filter(Boolean),
    answer: paperFinalAnswerText(source.key[no - 1]),
    nextTime: text(raw && raw.nextTime, 180),
    marks,
  };
}
async function startPaperAnswerReview(runId) {
  const run = (S.paperRuns || []).find((row) => row && row.id === runId);
  const source = run && paperSourceById(run.sourceId);
  if (!run || !source || String(run.due || '') > today()) return;
  const wrongNos = (run.wrongNos || []).filter((no) => Number.isInteger(no) && no >= 1 && no <= source.questions);
  if (!wrongNos.length) { run.status = 'completed'; run.mt = Date.now(); save(); renderCorrections(); return; }
  run.review = run.review || {};
  for (let no = 1; no <= source.questions; no++) {
    if (!wrongNos.includes(no) && !run.review[no]) run.review[no] = { done: true, level: 1, outcome: 'direct', completedAt: run.submittedAt };
  }
  app().innerHTML = `<div class="card"><h1>正在開啟 ${escH(source.title)}</h1><p class="dim">載入原卷，答案仍只會逐題顯示。</p></div>`;
  try {
    const urls = await paperSourceFiles(source);
    const baseInkPages = await paperInkLoadAll(run, source);
    const inkRun = paperReviewInkRun(run);
    const inkPages = await paperInkLoadAll(inkRun, source);
    const correctionMeta = { ...(paperInkLoadAll.lastMeta || {}) };
    const pending = wrongNos.filter((no) => !(run.review[no] && run.review[no].done));
    const nos = pending.length ? pending : wrongNos;
    const savedNoIndex = nos.indexOf(Number(run.reviewCurrentNo));
    const i = savedNoIndex >= 0 ? savedNoIndex : 0;
    const currentNo = nos[i];
    const savedPage = Number(run.reviewPage);
    const page = savedNoIndex >= 0 && Number.isFinite(savedPage)
      ? Math.max(0, Math.min(source.scans.length - 1, savedPage))
      : paperQuestionScanIndex(source, currentNo);
    paperReview = {
      run, source, urls, baseInkPages, inkPages, inkRun, nos, i,
      renderedNo: null, detailLoading: false, detailError: '', detailOpen: true,
      grading: false, gradeError: '',
    };
    paperSourceSession = {
      source, run, inkRun, urls, baseInkPages, inkPages, page, zoom: 1,
      inkMode: 'pen', reviewMode: true, recoveryRunId: inkRun.id,
      inkWidth: paperInkWidthValue(run.reviewInkWidth || run.paperInkWidth),
      inkColor: PAPER_INK_COLORS[run.reviewInkColor] ? run.reviewInkColor : 'blue',
      inkUserId: syncState.user ? syncState.user.id : null,
      inkClientIds: Object.fromEntries(source.scans.map((_, pageIndex) => [pageIndex, paperInkClientFor(inkRun, pageIndex)])),
      journalPromises: new Set(), journalRetry: new Map(),
      durability: {
        localAt: Number(correctionMeta.localAt) || null,
        cloudAt: Number(correctionMeta.cloudAt) || null,
        localError: false, cloudError: false,
        pendingClientIds: new Set(correctionMeta.pendingClientIds || []),
      },
    };
    sessionActive = true; sessionMode = 'paper-review';
    run.reviewCurrentNo = currentNo; run.reviewPage = page; run.mt = Date.now(); save();
    paperRecoveryWrite(true, paperSourceSession);
    renderPaperAnswerReview();
  } catch (e) {
    app().innerHTML = `<div class="card warn"><h2>原卷載入失敗</h2><p>${escH((e && e.message) || e)}</p><div class="actr"><button class="btn" onclick="renderCorrections()">返回</button><button class="btn primary" onclick="startPaperAnswerReview('${jsA(runId)}')">重試</button></div></div>`;
  }
}
function paperReviewRelease() {
  if (paperSourceSession && paperSourceSession.reviewMode) paperSourceRelease();
  else if (paperReview && Array.isArray(paperReview.urls)) for (const url of new Set(paperReview.urls)) try { URL.revokeObjectURL(url); } catch (_) {}
  paperReview = null;
}
async function paperReviewBack() {
  if (paperSourceSession && paperSourceSession.reviewMode) {
    const session = paperSourceSession;
    paperInkCommitCurrent();
    session.run.reviewPage = Number(session.page) || 0;
    session.run.mt = Date.now();
    paperRecoveryWrite(true, session);
    save();
    const [journalOk, snapshotOk] = await Promise.all([paperInkJournalDrain(session), paperInkPersist(true)]);
    if (!journalOk || (!snapshotOk && paperInkPage() && paperInkPage().dirty)) {
      if (paperReview) {
        paperReview.gradeError = '訂正筆跡尚未安全保存，系統已留在本頁並持續重試；請等右上顯示已保存後再離開。';
        renderPaperAnswerReview();
      }
      return false;
    }
  }
  paperReviewRelease(); sessionActive = false; sessionMode = null; sessionChrome(false); renderCorrections();
  return true;
}
function renderPaperAnswerReview() {
  return renderPaperAnswerReviewWorkspace();
}
function paperReviewRecordDetailOpen(state) {
  if (!state) return;
  const now = Date.now();
  state.detailFirstOpenedAt = Number(state.detailFirstOpenedAt) || now;
  state.detailLastOpenedAt = now;
  state.detailViewCount = (Number(state.detailViewCount) || 0) + 1;
  state.mt = now;
  if (paperReview && paperReview.run) {
    paperReview.run.mt = now;
    save();
  }
}
function paperReviewDetailLogs(state) {
  return (state && Array.isArray(state.logs) ? state.logs : [])
    .filter((log) => String(log && log.kind || '') !== 'detail-gate');
}
async function paperReviewDetailCallCompat(review, no, state, image) {
  try {
    return await paperAiDetailCall(review.source, no, image, paperReviewDetailLogs(state));
  } catch (error) {
    const message = String(error && error.message || error || '');
    const logs = state && Array.isArray(state.logs) ? state.logs : [];
    const alreadyMarked = logs.some((log) => String(log && log.kind || '') === 'detail-gate');
    if (!message.includes('本題詳解尚未開放') || alreadyMarked) throw error;

    // 舊版 Edge Function 仍要求 logs 非空。這筆只用於相容閘門，不算一次重想、也不顯示在老師報告。
    const now = Date.now();
    state.logs = [...logs, { kind:'detail-gate', ts:now, resolved:false }];
    state.detailGateCompatAt = now;
    state.mt = now;
    review.run.mt = now;
    save();
    await syncPush();
    return paperAiDetailCall(review.source, no, image, paperReviewDetailLogs(state));
  }
}
async function paperReviewDetailed(force = false) {
  if (!paperReview || paperReview.detailLoading) return;
  const review = paperReview;
  const no = review.nos[review.i], state = review.run.review[no];
  if (String(review.run.due || '') > today() || !state) {
    const msg = $('#paper-review-msg');
    if (msg) msg.textContent = '詳解會在隔日訂正開始後開放。';
    return;
  }
  if (state.aiDetail && !force) {
    paperReviewRecordDetailOpen(state);
    review.detailOpen = true;
    review.detailError = '';
    renderPaperAnswerReview();
    return;
  }
  review.detailLoading = true; review.detailError = ''; renderPaperAnswerReview();
  try {
    paperInkCommitCurrent();
    const [journalOk, snapshotOk] = await Promise.all([
      paperInkJournalDrain(paperSourceSession),
      paperInkPersist(true),
    ]);
    if (!journalOk || (!snapshotOk && paperInkPage() && paperInkPage().dirty)) throw new Error('訂正筆跡尚未安全保存，請稍後再試。');
    await syncPush();
    const page = paperQuestionScanIndex(review.source, no);
    const image = await paperReviewPageComposite(page);
    if (paperReview !== review) return;
    const response = await paperReviewDetailCallCompat(review, no, state, image);
    if (paperReview !== review) return;
    state.aiDetail = paperNormalizeAiDetail(review.source, no, response.json, response.model);
    state.solutionUnlockedAt = Number(state.solutionUnlockedAt) || Date.now();
    paperReviewRecordDetailOpen(state);
    review.detailOpen = true;
  } catch (error) {
    if (paperReview === review) review.detailError = (error && error.message) || String(error);
  } finally {
    if (paperReview === review) {
      review.detailLoading = false;
      renderPaperAnswerReview();
    }
  }
}
function paperReviewFinishDetailed() {
  if (!paperReview) return;
  const no = paperReview.nos[paperReview.i], state = paperReview.run.review[no];
  if (!state || !state.aiDetail) return;
  paperReviewGrade(3);
}
function paperReviewInkToolsHTML() {
  const session = paperSourceSession;
  return `<div class='paper-ink-tools' aria-label='訂正畫筆工具'><button id='paper-tool-pen' onclick="paperInkModeSet('pen')">${uiIcon('pencil')}筆</button><button id='paper-tool-erase' onclick="paperInkModeSet('erase')">${uiIcon('erase')}橡皮擦</button><button onclick='paperInkUndo()'>${uiIcon('undo')}復原</button><button onclick='paperInkClear()'>${uiIcon('x')}清空本頁訂正</button><div class='paper-color-group' role='group' aria-label='畫筆顏色'><button id='paper-color-black' class='paper-color-button' onclick="paperInkColorSet('black')" aria-label='黑色筆' aria-pressed='${session.inkColor === 'black'}'><i style='--ink:${PAPER_INK_COLORS.black}'></i><span>黑</span></button><button id='paper-color-blue' class='paper-color-button' onclick="paperInkColorSet('blue')" aria-label='藍色筆' aria-pressed='${session.inkColor === 'blue'}'><i style='--ink:${PAPER_INK_COLORS.blue}'></i><span>藍</span></button><button id='paper-color-green' class='paper-color-button' onclick="paperInkColorSet('green')" aria-label='綠色筆' aria-pressed='${session.inkColor === 'green'}'><i style='--ink:${PAPER_INK_COLORS.green}'></i><span>綠</span></button></div><label class='paper-pen-width' for='paper-pen-width'><span>筆粗 <b id='paper-pen-width-label'>${Math.round(paperInkWidthValue(session.inkWidth) * 100)}%</b></span><input id='paper-pen-width' type='range' min='35' max='200' step='5' value='${Math.round(paperInkWidthValue(session.inkWidth) * 100)}' oninput='paperInkWidthSet(this.value)' aria-label='調整畫筆粗細'></label></div>`;
}
function paperReviewDetailDrawerHTML(state) {
  const detail = state && state.aiDetail;
  if (!detail || !paperReview || paperReview.detailOpen === false) return '';
  const no = Number(detail.no) || Number(paperReview.nos[paperReview.i]);
  return `<aside class='paper-detail-drawer' aria-label='第 ${no} 題 AI 詳解'><div class='paper-detail-drawer-head'><div><span class='eyebrow'>第 ${no} 題詳解｜GPT‑5.5</span><h2>完整解法與第一個錯誤</h2></div><button class='paper-icon-btn' onclick='paperReviewDetailToggle(false)' aria-label='收起詳解'>${uiIcon('x')}</button></div><div class='paper-detail-drawer-body'><p class='paper-detail-view-note'>已記錄你查看過本題詳解；重算後仍可交給 AI 正常批改。</p><p class='${detail.firstError ? 'badc' : 'dim'}'>${detail.firstError ? rtAi(detail.firstError) : '目前無法可靠定位第一個錯誤，以下改說明方向缺口。'}</p>${detail.errorKind ? `<p class='paper-detail-kind'>錯誤類型：${escH(detail.errorKind)}</p>` : ''}${detail.read ? `<details><summary>AI 讀到的作答</summary><p>${rtAi(detail.read)}</p></details>` : ''}<h3>為什麼會卡住</h3><div>${rtAi(detail.explanation || '沒有足夠可讀資訊可分析。')}</div><h3>完整詳解</h3>${detail.solution.length ? `<ol class='paper-detail-steps'>${detail.solution.map((step) => `<li>${rtAi(step)}</li>`).join('')}</ol>` : '<p class="warnc">AI 沒有產生足夠步驟，請重新詳批。</p>'}<p class='blind-answer'>正式答案：<b>${escH(detail.answer)}</b></p>${detail.nextTime ? `<div class='next-step'><b>下次辨識訊號</b>${rtAi(detail.nextTime)}</div>` : ''}<div class='actr'><button class='btn primary' onclick='paperReviewFinishDetailed()'>看完詳解並重算，AI 再批改</button><button class='btn' onclick='paperReviewDetailed(true)' ${paperReview.detailLoading ? 'disabled' : ''}>${paperReview.detailLoading ? '重新產生中…' : '重新產生詳解'}</button></div></div></aside>`;
}
function paperReviewStatusHTML(state) {
  if (!paperReview) return '';
  if (paperReview.grading) return `<div class='paper-review-toast is-working'><b>正在批改這次訂正</b><span>只判斷你這次重算是否成立，不會偷給下一步。</span></div>`;
  if (paperReview.gradeError) return `<div class='paper-review-toast is-error'><b>這次沒有完成批改</b><span>${escH(paperReview.gradeError)}</span></div>`;
  if (paperReview.detailError) return `<div class='paper-review-toast is-error'><b>本題詳解尚未載入</b><span>${escH(paperReview.detailError)}</span></div>`;
  if (state && state.pendingLevel) return `<div class='paper-review-toast is-pass'><b>這次訂正已算對</b><span>紅勾已標在訂正卷面；確認後再進下一題。</span></div>`;
  const grade = state && state.correctionGrade;
  if (grade && !grade.correct) return `<div class='paper-review-toast is-retry'><b>這次訂正還沒完整成立</b><span>只標對錯與正確答案；你可以繼續在原位重算，或直接按「看本題詳解」。</span></div>`;
  return '';
}
function renderPaperAnswerReviewWorkspace() {
  if (!paperReview || !paperSourceSession || !paperSourceSession.reviewMode) return renderCorrections();
  while (paperReview.i < paperReview.nos.length) {
    const row = paperReview.run.review[paperReview.nos[paperReview.i]];
    if (!row || !row.done) break;
    paperReview.i++;
  }
  if (paperReview.i >= paperReview.nos.length) {
    const run = paperReview.run, title = paperReview.source.title, finishedRunId = run.id;
    run.status = 'completed'; run.reviewCurrentNo = null; run.reviewPage = null; run.mt = Date.now();
    paperRunRefreshLearningTags(run); paperSourceUpdateExtMock(paperReview.source, run); save();
    paperReviewRelease(); sessionActive = false; sessionMode = null; sessionChrome(false);
    app().innerHTML = `<h1>原卷訂正完成</h1><div class='card good'><p class='big'><b>${escH(title)}</b>的錯題已在原卷上重算並重新批改。</p><p>原始作答、第一次紅筆與隔日訂正筆跡分層保存，之後仍可交給老師查看。</p><div class='actr'><button class='btn' onclick="renderPaperTeacherReport('${jsA(finishedRunId)}')">給老師看這一回</button><button class='btn primary' onclick='renderCorrections()'>回隔日訂正</button></div></div>`;
    return;
  }
  const no = paperReview.nos[paperReview.i];
  const q = paperReview.source.key[no - 1];
  const state = paperReview.run.review[no] = paperReview.run.review[no] || { done:false, attempts:0, logs:[] };
  const scanIndex = paperQuestionScanIndex(paperReview.source, no);
  if (paperReview.renderedNo !== no) {
    paperInkCommitCurrent();
    paperReview.renderedNo = no;
    paperSourceSession.page = scanIndex;
    paperReview.run.reviewCurrentNo = no;
    paperReview.run.reviewPage = scanIndex;
    paperReview.run.mt = Date.now(); save();
  }
  const page = Number(paperSourceSession.page) || 0;
  const scan = paperReview.source.scans[page];
  const answer = paperFinalAnswerText(q);
  const detailAvailable = !!state.aiDetail;
  const detailButtonLabel = paperReview.detailLoading ? '正在產生詳解…' : detailAvailable ? `打開第 ${no} 題詳解` : `看第 ${no} 題詳解`;
  const detailShortcut = `<button id='paper-detail-shortcut' class='paper-detail-shortcut' onclick='paperReviewDetailed()' ${paperReview.detailLoading ? 'disabled' : ''}>${uiIcon('book')}<span>${detailButtonLabel}</span></button>`;
  let actions = '';
  if (state.pendingLevel) {
    actions = `<button class='btn primary' onclick='paperReviewAcceptCorrection()'>確認訂正完成，下一題</button>`;
  } else if (detailAvailable) {
    actions = `${paperReview.detailOpen === false ? `<button class='btn' onclick='paperReviewDetailed()'>顯示詳解</button>` : `<button class='btn' onclick='paperReviewDetailToggle(false)'>收起詳解，專心重算</button>`}<button class='btn primary' onclick='paperReviewGrade(3)' ${paperReview.grading ? 'disabled' : ''}>${paperReview.grading ? 'AI 批改中…' : '重算完，AI 再批改'}</button>`;
  } else {
    actions = `<button class='btn' onclick='paperReviewStuckWorkspace()'>仍沒算出，保存這次重想</button><button class='btn primary' onclick='paperReviewGrade(2)' ${paperReview.grading ? 'disabled' : ''}>${paperReview.grading ? 'AI 批改中…' : '寫完了，AI 再批改'}</button>`;
  }
  app().innerHTML = `<div class='paper-session-shell paper-review-session'><div class='paper-workbar'><div class='paper-work-title'><b>隔日訂正｜第 ${no} 題</b><small>${paperReview.i + 1} / ${paperReview.nos.length} 題錯題</small></div><div class='paper-review-quick-actions'><span class='paper-answer-chip'><small>只看答案</small><b>${escH(answer)}</b></span>${detailShortcut}</div><div class='paper-workgroup right'>${paperAiToggleButtonHTML()}<button id='paper-ink-status' class='paper-save-status' data-state='local' onclick='paperRecoveryOpen()' aria-label='查看訂正保存狀態'>${escH(paperInkStatusText(paperSourceSession))}</button><button class='paper-icon-btn' onclick='paperWorkspaceZoom(-.25)' aria-label='縮小題本'>−</button><span id='paper-zoom-label' class='paper-zoom-label'>${Math.round(paperSourceSession.zoom * 100)}%</span><button class='paper-icon-btn' onclick='paperWorkspaceZoom(.25)' aria-label='放大題本'>＋</button><span class='paper-page-label'><b>${page + 1} / ${paperReview.source.scans.length}</b><small>${escH(scan.label)}</small></span><button class='paper-icon-btn' onclick='paperWorkspacePage(-1)' ${page <= 0 ? 'disabled' : ''} aria-label='上一頁'>${uiIcon('arrow-left')}</button><button class='paper-icon-btn' onclick='paperWorkspacePage(1)' ${page >= paperReview.source.scans.length - 1 ? 'disabled' : ''} aria-label='下一頁'>${uiIcon('arrow-right')}</button><button class='paper-icon-btn' onclick='paperReviewBack()' aria-label='暫停訂正'>${uiIcon('x')}</button></div></div><div class='paper-workspace' aria-label='可直接書寫的隔日訂正卷'><section class='paper-source-pane'>${paperReviewInkToolsHTML()}<div class='paper-page-viewport'><div class='paper-spread'><div id='paper-write-sheet' class='paper-write-sheet' data-side='${scan.side}'><div class='paper-question-crop'><img id='paper-source-image' src='${paperReview.urls[page]}' alt='${escH(paperReview.source.title)} ${escH(scan.label)}'></div><div class='paper-note-margin' aria-hidden='true'></div><canvas id='paper-base-ink-canvas' aria-label='考試當天原筆跡'></canvas><canvas id='paper-ink-canvas' aria-label='整頁可直接書寫隔日訂正'></canvas><canvas id='paper-ai-canvas' aria-label='第一次與訂正批改紅筆'></canvas></div></div></div></section></div>${paperReviewStatusHTML(state)}${paperReviewDetailDrawerHTML(state)}<div class='paper-finish-bar paper-review-finish'><span>黑、藍、綠是你的訂正筆跡；紅色是 AI 批改。訂正筆跡獨立保存，不會改掉考試原稿。</span><div class='paper-result-actions'>${actions}</div></div><button id='paper-ui-toggle' class='paper-ui-toggle' onclick='paperUiToggle()' aria-label='收起工具' aria-pressed='false'>${uiIcon('pencil')}<span>收起</span></button></div>`;
  sessionChrome(true); paperInkAttach(); paperInkStatusRender();
  startTicker(() => {
    if (!paperReview || !paperSourceSession || sessionMode !== 'paper-review') return stopTicker();
    paperRecoveryHeartbeat();
  });
}
async function paperAiCorrectionCall(source, no, imageB64) {
  const q = source.key[no - 1], answer = paperFinalAnswerText(q);
  const content = [{
    type: 'image',
    source: { type:'base64', media_type:'image/jpeg', data:imageB64 },
  }, {
    type: 'text',
    text: `你是台灣學測數學的訂正閱卷老師。這張完整單頁已分層合成：印刷題目與考試當天筆跡是底稿、紅筆是第一次簡批、紫色筆跡才是學生今天新增的隔日訂正。請只判斷第 ${no} 題的紫色訂正，不要把舊作答或紅筆當成新答案。\n\n正式答案：${answer}\n題型：${q.type}\n\n規則：\n1. 紫色訂正只要方法與最終答案成立，即使寫法不同或未化成相同外觀也算對。\n2. 必須看到足夠的紫色重算或明確最終答案；只有抄正式答案、沒有可辨識推導時判錯。\n3. correct 只回傳這次訂正是否成立；read 簡短轉錄紫色作答。\n4. marks 只框紫色筆跡中的最終答案，答對標「訂正正確」，答錯標「答案未對」。此輪不要在圖上指出第一個算式錯誤，也不要提供下一步。\n5. firstError、errKind、praise、nextTime 仍依 schema 回傳，但介面在第二次詳批前不顯示錯誤分析；stuck 固定空陣列。`,
  }];
  return aiJSON(content, 'grade');
}
function paperNormalizeCorrectionGrade(source, no, raw) {
  const correct = aiCorrect(raw);
  const kind = correct ? 'check' : 'cross';
  let marks = (Array.isArray(raw && raw.marks) ? raw.marks : []).slice(0, 2).map((mark) => {
    const box = Array.isArray(mark && mark.box) ? mark.box.map(Number) : [];
    if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
    return { box:box.map((value) => Math.max(0, Math.min(1, value))), kind, option:0, label:correct ? '訂正正確' : '答案未對' };
  }).filter(Boolean);
  if (!marks.length) {
    const page = paperQuestionScanIndex(source, no) + 1;
    marks = [paperFallbackMark(source, no, page, correct ? '訂正正確' : '答案未對', kind, 0, 0)];
  }
  return {
    correct, uncertain:false, gradedAt:Date.now(),
    read:String(raw && raw.read || '').trim().slice(0, 240),
    errKind:String(raw && raw.errKind || '').trim().slice(0, 80),
    hiddenFirstError:raw && raw.firstError == null ? null : String(raw.firstError).trim().slice(0, 300),
    marks,
  };
}
function paperCorrectionErrorKind(value) {
  const text = String(value || '');
  if (/計算|正負|移項|代入|化簡|約分|符號/.test(text)) return '計算或符號失誤';
  if (/審題|條件|看錯/.test(text)) return '條件翻譯不完整';
  if (/公式|定義/.test(text)) return '定義或公式不熟';
  if (/方法|方向/.test(text)) return '建式方向錯誤';
  return '推理中間有缺口';
}
async function paperReviewGrade(targetLevel = 2) {
  if (!paperReview || !paperSourceSession || paperReview.grading) return;
  const review = paperReview, session = paperSourceSession;
  const no = review.nos[review.i], state = review.run.review[no];
  if (!state) return;
  review.grading = true; review.gradeError = ''; renderPaperAnswerReview();
  try {
    paperInkCommitCurrent();
    const [journalOk, snapshotOk] = await Promise.all([paperInkJournalDrain(session), paperInkPersist(true)]);
    if (!journalOk || (!snapshotOk && paperInkPage() && paperInkPage().dirty)) throw new Error('訂正筆跡尚未安全保存，請等右上顯示已保存後再批改。');
    const page = paperQuestionScanIndex(review.source, no);
    const image = await paperReviewPageComposite(page);
    if (paperReview !== review) return;
    const raw = await paperAiCorrectionCall(review.source, no, image);
    if (paperReview !== review) return;
    const grade = paperNormalizeCorrectionGrade(review.source, no, raw);
    state.correctionGrade = grade; state.correctionGradedAt = grade.gradedAt; state.mt = Date.now();
    if (grade.correct) {
      state.pendingLevel = Number(targetLevel) === 3 ? 3 : 2;
    } else {
      state.pendingLevel = null;
      state.logs = state.logs || [];
      state.logs.push({
        ts:Date.now(), kind:'retry',
        direction:'已在原卷訂正層留下手寫重算，AI 再批改仍未完整成立。',
        errorKind:paperCorrectionErrorKind(grade.errKind),
        aiRead:grade.read,
      });
      state.attempts = (Number(state.attempts) || 0) + 1;
      state.errorKind = state.errorKind || paperCorrectionErrorKind(grade.errKind);
    }
    review.run.reviewCurrentNo = no; review.run.reviewPage = page; review.run.mt = Date.now();
    paperRunRefreshLearningTags(review.run); paperSourceUpdateExtMock(review.source, review.run); save();
  } catch (error) {
    if (paperReview === review) review.gradeError = (error && error.message) || String(error);
  } finally {
    if (paperReview === review) { review.grading = false; renderPaperAnswerReview(); }
  }
}
function paperReviewAcceptCorrection() {
  if (!paperReview) return;
  const no = paperReview.nos[paperReview.i], state = paperReview.run.review[no];
  const level = Number(state && state.pendingLevel);
  if (!state || !state.correctionGrade || !state.correctionGrade.correct || ![2, 3].includes(level)) return;
  state.logs = state.logs || [];
  state.logs.push({
    ts:Date.now(), kind:'complete',
    direction:level === 3 ? '看過詳解後已在原卷訂正層重新算完，AI 再批改通過。' : '只看最終答案，在原卷訂正層重新算完並由 AI 再批改通過。',
    errorKind:state.errorKind || '',
  });
  state.done = true; state.level = level; state.pendingLevel = null;
  state.outcome = level === 3 ? 'ai-detail-verified' : 'answer-only-verified';
  state.completedAt = Date.now(); state.mt = state.completedAt;
  if (level === 3 && state.aiDetail) state.aiErrorKind = state.aiDetail.errorKind || '';
  paperReview.run.mt = Date.now();
  paperRunRefreshLearningTags(paperReview.run); paperSourceUpdateExtMock(paperReview.source, paperReview.run); save();
  paperReview.i++; paperReview.renderedNo = null; paperReview.detailOpen = true;
  paperReview.detailError = ''; paperReview.gradeError = ''; renderPaperAnswerReview();
}
async function paperReviewStuckWorkspace() {
  if (!paperReview || !paperSourceSession) return;
  const session = paperSourceSession;
  paperInkCommitCurrent();
  const [journalOk, snapshotOk] = await Promise.all([paperInkJournalDrain(session), paperInkPersist(true)]);
  if (!journalOk || (!snapshotOk && paperInkPage() && paperInkPage().dirty)) {
    paperReview.gradeError = '這次重想尚未安全保存，因此沒有解鎖詳批；請等右上顯示已保存後再試。';
    renderPaperAnswerReview();
    return;
  }
  const no = paperReview.nos[paperReview.i], state = paperReview.run.review[no];
  state.logs = state.logs || [];
  state.logs.push({ ts:Date.now(), kind:'retry', direction:'我已把目前想到的方向或算式留在原卷訂正層，但仍無法完成。', errorKind:state.errorKind || '看不出第一個切入點' });
  state.attempts = (Number(state.attempts) || 0) + 1;
  state.errorKind = state.errorKind || '看不出第一個切入點'; state.mt = Date.now();
  paperReview.run.mt = Date.now(); paperRunRefreshLearningTags(paperReview.run); paperSourceUpdateExtMock(paperReview.source, paperReview.run); save();
  paperReview.detailError = ''; paperReview.gradeError = ''; renderPaperAnswerReview();
}
function paperReviewDetailToggle(open) {
  if (!paperReview) return;
  paperReview.detailOpen = open !== false; renderPaperAnswerReview();
}
function startCorrection(batchId) {
  const batch = (S.corrections || []).find((b) => b.id === batchId);
  if (!batch || String(batch.due || '') > today()) return;
  const indexes = batch.entries.map((x, i) => (!x.done && correctionQuestion(x) ? i : -1)).filter((i) => i >= 0);
  if (!indexes.length) { renderCorrections(); return; }
  correction = { batch, indexes, i: 0, t0: 0 };
  sessionActive = true; sessionMode = 'correction';
  correctionNext();
}
function correctionNoop() {}
function correctionNext() {
  while (correction && correction.i < correction.indexes.length && correction.batch.entries[correction.indexes[correction.i]].done) correction.i++;
  if (!correction || correction.i >= correction.indexes.length) return correctionDone();
  renderCorrectionWork();
}
function correctionEffort() {
  if (!correction) return null;
  const note = (($('#cor-direction') || {}).value || '').trim();
  const alternate = (($('#cor-alt') || {}).value || '').trim();
  const topic = (($('#cor-topic') || {}).value || '').trim();
  const concept = (($('#cor-concept') || {}).value || '').trim();
  const t0 = correction.t0;
  const proc = inkStop();
  const hasDirection = note.length >= 8;
  const hasUnitPoint = !!topic && concept.length >= 2;
  if (!hasDirection && !hasUnitPoint) {
    alert('請留下可給老師看的紀錄：寫出一個具體破題方向；若真的沒有方向，至少選所屬單元並寫出可能卡住的觀念。');
    const entry = correction.batch.entries[correction.indexes[correction.i]];
    const q = correctionQuestion(entry);
    inkStart(q.id, t0, t0);
    return null;
  }
  const entry = correction.batch.entries[correction.indexes[correction.i]];
  syncInk(entry.qid, t0, Object.assign({ mode: 'correction', correctionId: correction.batch.id }, proc || {}));
  return { note, alternate: alternate.slice(0, 500), topic, concept: concept.slice(0, 160), proc, ms: Date.now() - t0 };
}
function renderCorrectionWork() {
  const entry = correction.batch.entries[correction.indexes[correction.i]];
  const q = correctionQuestion(entry);
  if (!q) { entry.done = true; save(); correction.i++; return correctionNext(); }
  const unlocked = !!entry.solutionUnlockedAt;
  const prior = (entry.logs || []).map((log, i) => `<li>第 ${i + 1} 次：${log.note ? escH(log.note) : `沒有方向；${escH(TOPICS[log.topic] || '')}${log.concept ? `／${escH(log.concept)}` : ''}`}${log.alternate ? `<span class="dim">（另一路：${escH(log.alternate)}）</span>` : ''}</li>`).join('');
  const actions = `<div class="blind-answer"><span class="eyebrow">本階段唯一可看的資料</span><p>最終答案：<b class="big">${finalAnswerHTML(q)}</b></p></div>
    ${prior ? `<details><summary class="dim">我前面已試過的方向</summary><ol>${prior}</ol></details>` : ''}
    <div class="correction-fields"><label>我這次重新嘗試的破題方向<textarea id="cor-direction" rows="3" placeholder="例如：先把條件改寫成內積，因為題目在問垂直；再用內積為 0 建式。"></textarea></label>
    <label>另一個可能方向（選填）<textarea id="cor-alt" rows="2" placeholder="現在先求至少一個；真的想到第二個再記。"></textarea></label>
    <div class="fallback-fields"><label>如果沒有方向，至少判斷所屬單元<select id="cor-topic">${visionTopicOptions('')}</select></label>
    <label>這題可能卡住的單元重點<input id="cor-concept" type="text" placeholder="例如：兩事件獨立的判定"></label></div></div>
    <div class="actr">
      ${unlocked
        ? '<button class="btn primary big" onclick="correctionComplete(true)">看過詳解並重算完，列為第三級</button>'
        : '<button class="btn primary big" onclick="correctionComplete(false)">只看答案就算出，列為第二級</button><button class="btn" onclick="correctionLogStuck()">仍沒算出，先保存方向／單元判斷</button>'}
    </div>
    ${!unlocked && entry.attempts > 0 ? '<div class="actr"><button class="btn" onclick="correctionUnlock()">努力後仍無收穫，解鎖詳解並重算</button></div>' : ''}`;
  app().innerHTML = `<div class="session-head"><span>隔日盲訂正｜第 ${entry.examNo} 題｜${correction.i + 1} / ${correction.indexes.length}</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></div>
    ${unlocked ? `<div class="card redo-sol"><p><b>已完成至少一次獨立重想，現在才開放詳解。</b></p>${rtTxt(q.sol)}${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}</div>` : ''}
    ${bkCard(q, `第 ${entry.examNo} 題`, 'correctionNoop', actions)}`;
  sessionChrome(true); scrollQuestionTop();
  correction.t0 = Date.now();
  inkStart(q.id, correction.t0);
}
function correctionLogStuck() {
  const effort = correctionEffort(); if (!effort) return;
  const entry = correction.batch.entries[correction.indexes[correction.i]];
  entry.attempts = (entry.attempts || 0) + 1;
  entry.logs = entry.logs || [];
  entry.logs.push({ ts: Date.now(), note: effort.note, alternate: effort.alternate, topic: effort.topic, concept: effort.concept, strokes: effort.proc ? effort.proc.n || 0 : 0, ms: effort.ms });
  correction.batch.mt = Date.now();
  save();
  renderCorrectionWork();
}
function correctionUnlock() {
  const entry = correction.batch.entries[correction.indexes[correction.i]];
  if (!entry || !entry.attempts) return;
  if (ink) inkStop();
  entry.solutionUnlockedAt = Date.now(); correction.batch.mt = Date.now(); save();
  renderCorrectionWork();
}
function correctionComplete(usedSolution) {
  const effort = correctionEffort(); if (!effort) return;
  const entry = correction.batch.entries[correction.indexes[correction.i]];
  if (usedSolution && !entry.solutionUnlockedAt) return;
  entry.logs = entry.logs || [];
  entry.logs.push({ ts: Date.now(), note: effort.note, alternate: effort.alternate, topic: effort.topic, concept: effort.concept, strokes: effort.proc ? effort.proc.n || 0 : 0, ms: effort.ms, resolved: true });
  entry.done = true; entry.completedAt = Date.now(); entry.outcome = usedSolution ? 'solution' : 'answer-only'; entry.level = usedSolution ? 3 : 2;
  correction.batch.mt = Date.now();
  const q = correctionQuestion(entry);
  if (q) recordAttempt(q, true, effort.ms, null, 'correction', effort.proc, null, { skipWrong: true });
  save();
  correction.i++;
  correctionNext();
}
function correctionDone() {
  sessionActive = false; sessionMode = null; sessionChrome(false);
  const batch = correction && correction.batch;
  correction = null;
  if (!batch) return renderCorrections();
  const c = correctionCounts(batch);
  app().innerHTML = `<h1>這回訂正完成</h1><div class="card good"><p class="big">第一級 <b>${c.l1}</b> 題｜第二級 <b>${c.l2}</b> 題｜第三級 <b>${c.l3}</b> 題</p>
    <p>第一級＝考場直接會寫；第二級＝只給最終答案就能自己算出；第三級＝努力重想後仍須看詳解。每題留下的方向與單元判斷都可交給老師檢視。</p>
    <div class="actr"><button class="btn" onclick="renderTeacherReport('${jsA(batch.id)}')">給老師看這一回</button><button class="btn primary" onclick="nav('mock')">回模考與破題</button></div></div>`;
}
function renderTeacherReport(batchId) {
  const batch = (S.corrections || []).find((x) => x.id === batchId); if (!batch) return renderCorrections();
  const c = correctionCounts(batch);
  const levelName = (level) => level === 1 ? '第一級｜我會寫' : level === 2 ? '第二級｜只看答案能算出' : level === 3 ? '第三級｜需要看詳解' : '尚未完成訂正';
  const items = (batch.entries || []).map((entry) => {
    const q = correctionQuestion(entry), level = correctionLevel(entry);
    const logs = (entry.logs || []).map((log, i) => `<div class="teacher-attempt"><b>第 ${i + 1} 次重想</b>
      ${log.note ? `<p>方向：${escH(log.note)}</p>` : '<p>方向：尚未找到</p>'}
      ${log.topic || log.concept ? `<p>判斷：${escH(TOPICS[log.topic] || '未選單元')}${log.concept ? `／${escH(log.concept)}` : ''}</p>` : ''}
      ${log.alternate ? `<p>另一方向：${escH(log.alternate)}</p>` : ''}</div>`).join('');
    return `<article class="teacher-q level-${level || 0}"><header><span>第 ${entry.examNo || '—'} 題</span><b>${levelName(level)}</b></header>
      ${q ? `<div class="teacher-stem">${q.stem ? rtTxt(q.stem) : ''}${rtTxt(q.q)}</div>` : '<p class="dim">題目已不在目前題庫</p>'}
      <p class="teacher-answer">模考作答：${escH(entry.yourAns || '（未作答）')}${entry.done && level > 1 && q ? `｜最終答案：${finalAnswerHTML(q)}` : ''}</p>
      ${entry.examDirection ? `<p class="teacher-answer">考場當下方向：${escH(entry.examDirection)}</p>` : entry.examStrokes ? `<p class="teacher-answer">考場當下已在手寫區留下 ${entry.examStrokes} 筆推導。</p>` : ''}
      ${logs || (level === 1 ? '<p class="dim">考場當下直接答對，不需隔日重想。</p>' : '<p class="dim">尚未留下重想紀錄。</p>')}</article>`;
  }).join('');
  app().innerHTML = `<div class="report-head"><div><span class="eyebrow">老師檢視版</span><h1>${escH(batch.name || '全真模考')}｜${batch.d}</h1><p>第一級 ${c.l1}｜第二級 ${c.l2}｜第三級 ${c.l3}｜尚未完成 ${c.open}</p></div>
    <div class="actr"><button class="btn" onclick="window.print()">列印／存成 PDF</button><button class="btn primary" onclick="nav('correct')">回隔日訂正</button></div></div>
    <div class="teacher-report">${items}</div>`;
  typesetIn(app()); scrollQuestionTop();
}

/* 指定單元直開一輪刷題（錯題卡「同單元加練」/數據頁攻擊清單/戰力地圖共用） */
function startPracTopics(topics, cnt) {
  if (!syncGate()) return;
  let pool = BANK.filter((q) => topics.includes(q.topic));
  if (!pool.length) { alert('這些單元目前沒有題目。'); return; }
  const ac = attCountMap();
  pool = shuffle(pool).sort((a, b) => (ac.get(a.id) || 0) - (ac.get(b.id) || 0));
  prac = { queue: dedupeStems(pool, Math.min(cnt || 8, pool.length)), i: 0, results: [], mode: 'topic-intervention', topics, cnt: cnt || 8 }; // topics/cnt 留給結果頁「再刷一輪」原樣重開
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pracNext();
}
function startTopicIntervention(k) {
  if (!severeWeakTopics().some((x) => x.k === k)) {
    alert('這個單元目前沒有達到分章介入門檻，先回混合練習取得真實診斷。');
    return;
  }
  startPracTopics([k], 6);
}

/* ═══════════ 數據 ═══════════ */
function paperLearningSummaryCard() {
  const runs = (S.paperRuns || []).filter((run) => run && run.aiGrade && run.status !== 'discarded')
    .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
  if (!runs.length) return `<section class="card paper-learning-summary"><span class="eyebrow">原版模考分析</span><h2>完成第一回後開始累積</h2><p class="dim">系統會分開統計正式 20 題校準卷與 19 題練習卷，並從隔日訂正整理常錯單元、卡點和三級分布。</p></section>`;
  const topicCount = {}, errorCount = {};
  let l1 = 0, l2 = 0, l3 = 0, open = 0;
  for (const run of runs) {
    const levels = paperRunLevelCounts(run);
    l1 += levels.l1; l2 += levels.l2; l3 += levels.l3; open += levels.open;
    for (const state of Object.values(run.review || {})) {
      if (!state || typeof state !== 'object') continue;
      const topic = state.topic || [...(state.logs || [])].reverse().find((log) => log && log.topic)?.topic;
      const error = state.aiErrorKind || state.errorKind || [...(state.logs || [])].reverse().find((log) => log && log.errorKind)?.errorKind;
      if (topic && TOPICS[topic]) topicCount[topic] = (topicCount[topic] || 0) + 1;
      if (error) errorCount[error] = (errorCount[error] || 0) + 1;
    }
  }
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topErrors = Object.entries(errorCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const maxTopic = Math.max(1, ...topTopics.map((item) => item[1]));
  const maxError = Math.max(1, ...topErrors.map((item) => item[1]));
  const bars = (items, max, label) => items.length ? items.map(([key, count]) =>
    `<div class="bar-row"><span class="bar-label">${escH(label(key))}</span><div class="bar"><div class="bar-fill y" style="width:${Math.round(count / max * 100)}%"></div></div><span class="bar-val">${count} 題</span></div>`).join('')
    : '<p class="dim">完成隔日訂正並選擇單元／卡點後，這裡會開始出現趨勢。</p>';
  const recent = runs.slice(0, 6).map((run) => {
    const source = paperSourceById(run.sourceId);
    const formal = source && source.questions === 20 && source.calibrationEligible !== false;
    return `<div class="report-row"><span>${escH(run.d || '')}｜${escH(run.name || '')}</span><b>${run.score}/100</b><small class="${formal ? 'okc' : 'dim'}">${formal ? '正式校準' : '練習分析'}</small><button class="btn sm" onclick="renderPaperTeacherReport('${jsA(run.id)}')">逐題</button></div>`;
  }).join('');
  return `<section class="card paper-learning-summary"><span class="eyebrow">原版模考分析</span><h2>從「錯幾分」追到「為何找不到方向」</h2>
    <div class="paper-level-summary"><span>第一級 <b>${l1}</b></span><span>第二級 <b>${l2}</b></span><span>第三級 <b>${l3}</b></span><span>待訂正 <b>${open}</b></span></div>
    <div class="paper-analysis-grid"><div><h3>較常失分的單元</h3>${bars(topTopics, maxTopic, (key) => TOPICS[key] || key)}</div><div><h3>較常出現的卡點</h3>${bars(topErrors, maxError, (key) => key)}</div></div>
    <h3>最近原版模考</h3><div class="report-list">${recent}</div></section>`;
}
function renderStats() {
  const entries = (S.corrections || []).flatMap((b) => b.entries || []);
  const done = entries.filter((x) => x.done);
  const levels = { l1: done.filter((x) => correctionLevel(x) === 1).length, l2: done.filter((x) => correctionLevel(x) === 2).length, l3: done.filter((x) => correctionLevel(x) === 3).length };
  for (const run of (S.paperRuns || []).filter((item) => item && item.aiGrade && item.status !== 'discarded')) {
    const paperLevels = paperRunLevelCounts(run);
    levels.l1 += paperLevels.l1; levels.l2 += paperLevels.l2; levels.l3 += paperLevels.l3;
  }
  const visionDone = (S.visionHistory || []).filter((x) => x.outcome !== 'obvious');
  const visionFirst = visionDone.filter((x) => Number(x.days || 0) === 1 && ['works', 'different', 'fails'].includes(x.outcome)).length;
  const visionTwoDay = visionDone.filter((x) => Number(x.days || 0) >= 2).length;
  const conceptsUnderstood = CONCEPT_CARDS.filter((x) => { const last = conceptLast(x.id); return last && last.understood; }).length;
  const outlineReady = outlineUnits().filter((x) => x.reference).length;
  app().innerHTML = `<div class="report-head"><div><span class="eyebrow">新版</span><h1>進度與設定</h1><p>只保留老師三大任務需要的資訊。</p></div><button class="btn" onclick="nav('home')">回今日</button></div>
    <div class="new-progress-grid">
      <section><span>大綱默寫</span><b>${(S.outlineAttempts || []).length}</b><small>次默寫｜對照大綱 ${outlineReady}/11</small></section>
      <section><span>模考三級</span><b>${levels.l1} / ${levels.l2} / ${levels.l3}</b><small>第一級／第二級／第三級</small></section>
      <section><span>破題方向</span><b>${visionFirst}</b><small>題第一天已有方向｜${visionTwoDay} 題用足兩天</small></section>
      <section><span>觀念理解</span><b>${conceptsUnderstood}/${CONCEPT_CARDS.length}</b><small>張能用自己的話說清楚</small></section>
    </div>
    ${paperLearningSummaryCard()}
    ${syncCard()}
    ${aiCard()}
    ${packCard()}
    ${backupCard()}`;
}
/* 📦 題庫內容管理：外部題包按來源分組，可停用（紀錄保留、重啟即回） */
function packCard() {
  const packs = Object.create(null); // src 是匯入欄位：null-proto 讓 "__proto__" 只是普通 key，索引不打原型鏈
  for (const q of extBankArr()) {
    const src = q.src || '（未標來源）';
    const p = (packs[src] = packs[src] || { n: 0, units: new Set(), d: { 1: 0, 2: 0, 3: 0 }, real: !!q.src });
    p.n++; p.units.add(q.topic); p.d[q.diff] = (p.d[q.diff] || 0) + 1;
  }
  const keys = Object.keys(packs);
  const checkedAt = curatedState.lastChecked
    ? new Date(curatedState.lastChecked).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
    : '尚未完成';
  const healthMeta = curatedState.count ? `<div class="bank-health" role="status">
      <div><b>內建</b><span>${BUILTIN_N} 題</span></div><div><b>私有</b><span>${curatedState.count} 題</span></div><div><b>目前可用</b><span>${BUILTIN_N + curatedState.count} 題</span></div>
      <div><b>資料包</b><span>${curatedState.packCount || '—'} 包</span></div><div><b>最近驗證</b><span>${escH(checkedAt)}</span></div><div><b>Manifest</b><span class="mono">${escH((curatedState.manifestSha || '').slice(0, 12) || '—')}</span></div>
    </div>` : '';
  const curatedLine = curatedState.status === 'ready'
    ? `<p class="okc fs13">私有題庫已通過完整性驗證並快取。</p>${healthMeta}`
    : curatedState.status === 'loading'
      ? `<p class="dim fs13">正在核對私有題庫與本機快取…</p>${healthMeta}`
      : curatedState.status === 'error'
        ? `<p class="warnc fs13">這次私有題庫核對失敗：${escH(curatedState.error)}。${curatedState.count ? '下方仍顯示上次成功驗證的快取資訊。' : `內建 ${BUILTIN_N} 題仍可正常練習。`}</p>${healthMeta}`
        : (supa && !syncState.user ? '<p class="dim fs13">登入後會載入受保護的完整題庫；未登入可先使用內建 363 題。</p>' : '');
  if (!keys.length) return curatedLine ? `<div class="card"><h2>私有題庫</h2>${curatedLine}</div>` : '';
  const rows = keys.map((src) => {
    const p = packs[src];
    const off = packIsOff(src);
    return `<tr><td>${escH(src)}${off ? ' <span class="badc">（停用中）</span>' : ''}</td><td>${p.n} 題</td><td>${p.units.size} 單元</td><td class="dim">易${p.d[1] || 0}/中${p.d[2] || 0}/難${p.d[3] || 0}</td>
      <td>${p.real ? `<button class="btn sm" onclick="togglePack('${jsA(src)}')">${off ? '啟用' : '停用'}</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>外部題庫 <span class="dim">共 ${extBankArr().length} 題${splitOn() ? '（已與作答狀態分家）' : ''}</span></h2>
    ${curatedLine}
    ${contentTableMissing ? '<p class="dim fs13">💡 到 Supabase Dashboard 跑一次 schema.sql 的 content_packs 段後，題庫將與作答狀態分家：每次作答不再整包上傳、20+ 本講義也放得下。</p>' : ''}
    <div class="tblwrap"><table class="tbl"><tr><th>來源</th><th>題數</th><th>覆蓋</th><th>難度分布</th><th></th></tr>${rows}</table></div></div>`;
}
function togglePack(src) {
  S.packOff = Object.assign(Object.create(null), S.packOff); // src 是匯入欄位：null-proto 讓 "__proto__" 只是普通 key（同 packCard）
  S.packOff[src] = { off: !packIsOff(src), ts: Date.now() }; // 永不 delete：顯式狀態＋時間戳才能在合併時分出新舊
  save();
  clearTimeout(syncTimer); // reload 會殺掉 4 秒 debounce——先直接推雲端再重載，別靠 unload 競速
  Promise.resolve(supa && syncState.user ? syncPush() : null).finally(() => location.reload());
}


/* ═══════════ ☁️ 雲端同步（Supabase） ═══════════
   離線優先：狀態以 IndexedDB 為權威本機副本、localStorage 為相容後備；登入後以 revision CAS 合併同步，
   手寫筆跡先逐題耐久寫入 IndexedDB，再冪等補傳 ink_sessions。只用 publishable key，資料由 RLS 保護。
   在封鎖外部連線的環境（claude.ai artifact）自動降級為純本機模式。 */
const SUPA_URL = 'https://rrihysbxhsbxjteqmtdu.supabase.co';
const SUPA_KEY = 'sb_publishable_p6ThWGf5DLp6XRCovZMVDQ_9vJG_Y41';
const AUTH_REDIRECT_URL = 'https://uqrqmmw.github.io/matha/';
let supa = null;
let syncState = { user: null, msg: '', last: null };
let syncTimer = null;
let syncPushPromise = null;
let syncPushAgain = false;
let authSwitchPromise = Promise.resolve();
let activeAuthUserId = '';
function supaInit() {
  if (!window.supabase) { syncPill(); return; } // CDN 被擋（artifact 環境）→ 純本機模式
  supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
  autoLoginFromHash();
  supa.auth.onAuthStateChange((ev, session) => {
    const nextUser = session ? session.user : null;
    const nextId = nextUser && nextUser.id || '';
    const was = activeAuthUserId;
    activeAuthUserId = nextId;
    authSwitchPromise = authSwitchPromise.then(async () => {
      syncState.user = nextUser;
      if (nextUser && nextId !== was) {
        await activateUserState(nextUser);
        await syncPull();
        probeContent();
        flushInkQueue();
        nav(document.body.dataset.view || 'home');
      } else if (!nextUser && was) {
        await deactivateUserState();
        syncState.revision = 0;
        nav('home');
      }
      syncPill();
    }).catch((error) => {
      syncState.msg = '切換帳號時本機資料載入失敗：' + ((error && error.message) || '請重新整理');
      syncPill();
    });
  });
  window.addEventListener('online', () => { if (syncState.user) { syncPush(); flushInkQueue(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && syncState.user) { clearTimeout(syncTimer); syncPush(); }
    // 切回前景：重新拉雲端狀態（拿到別台裝置剛存的 key／紀錄），做題中不打擾
    else if (document.visibilityState === 'visible' && syncState.user && !sessionActive) syncPull();
  });
  syncPill();
}
function syncQueue() {
  if (!supa || !syncState.user) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPush, 4000);
}
/* 裝置配對連結只帶 Supabase 一次性 magic-link token hash：不含帳密、access token 或 refresh token。
   讀到後先清網址，再以 verifyOtp 換取這台自己的 session；舊版 base64 帳密／session 連結一律不再接受。 */
async function autoLoginFromHash() {
  const m = location.hash.match(/^#pair=([A-Za-z0-9_-]{20,})$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { data: s } = await supa.auth.getSession();
    if (s && s.session) { syncState.msg = '這台裝置已配對過'; syncPill(); return; }
    const { error } = await supa.auth.verifyOtp({ token_hash: m[1], type: 'magiclink' });
    syncState.msg = error ? '配對連結已失效或使用過：' + error.message : '裝置配對完成，之後開頁自動同步';
    syncPill();
  } catch (e) { syncState.msg = '配對失敗，請從已登入裝置重新產生一次性連結'; syncPill(); }
}
/* Edge Function 只替目前已登入的帳號簽發一次性 magic-link token；有效一小時、使用後失效。 */
async function makePairLink() {
  if (!supa || !syncState.user) { alert('請先登入再產生配對連結'); return; }
  const { data } = await supa.auth.getSession();
  if (!data || !data.session) { alert('取不到目前的登入狀態，請重新登入後再試'); return; }
  syncState.msg = '正在建立一次性配對連結'; syncPill();
  try {
    const response = await fetch(`${SUPA_URL}/functions/v1/device-pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SUPA_KEY, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token_hash) throw new Error(body.message || `HTTP ${response.status}`);
    const url = location.origin + location.pathname + '#pair=' + body.token_hash;
    const note = '在另一台裝置貼到網址列開啟即可。這條連結一小時內有效，而且只能使用一次；不含你的密碼或長期登入權杖。';
    try { await navigator.clipboard.writeText(url); alert('配對連結已複製。\n' + note); }
    catch (_) { prompt('複製這條一次性配對連結：\n' + note, url); }
    syncState.msg = '一次性配對連結已建立'; syncPill();
  } catch (e) {
    syncState.msg = '建立配對連結失敗：' + ((e && e.message) || e);
    syncPill();
  }
}
/* 同步狀態燈（常駐右上角）＋開始做題前的登入攔檢 */
function syncPill() {
  let el = $('#syncpill');
  if (!el) {
    el = document.createElement('button');
    el.type = 'button';
    el.id = 'syncpill';
    el.onclick = () => nav('stats');
    document.body.appendChild(el);
  }
  const show = (message, className) => {
    const clean = uiTextOnly(message);
    el.className = className;
    el.title = clean;
    el.setAttribute('aria-label', clean + '；前往進度與設定');
    el.innerHTML = uiIcon('dot', 'sync-dot') + `<span class="sync-label">${escH(clean)}</span>`;
  };
  if (saveQuotaErr) { // 本機寫入失敗要看得見，不能無聲
    show(supa && syncState.user ? '本機存滿——雲端仍正常' : '本機存滿——資料存不下來！', supa && syncState.user ? 'mid' : 'warn');
    return;
  }
  if (!supa) { show('離線版（無法同步）', 'off'); return; }
  if (!syncState.user) { show('未登入——紀錄只存本機', 'warn'); return; }
  show(syncState.msg || '已登入', syncState.pushErr ? 'mid' : 'ok');
}
let syncGateAsked = false; // 一個 session 只更新一次提醒；不以原生確認框阻擋離線開練
function syncGate() {
  // 離線優先：右下角已永久顯示同步狀態，未登入不能再用 confirm 打斷每個訓練入口。
  if (!supa || syncState.user || syncGateAsked) return true;
  syncGateAsked = true;
  syncState.msg = '未登入——本次紀錄只存這台；點此可到進度與設定登入同步';
  try { syncPill(); } catch (_) {} // 啟動極早期或測試 DOM 尚未完整時也不阻擋開練
  return true;
}
async function syncPush() {
  if (!supa || !syncState.user) return;
  if (syncPushPromise) { syncPushAgain = true; return syncPushPromise; }
  syncPushPromise = (async () => {
    do {
      syncPushAgain = false;
      let committed = false;
      for (let attempt = 0; attempt < 5 && !committed; attempt++) {
        const uid = syncState.user && syncState.user.id;
        if (!uid) return;
        const remoteRes = await supa.from('app_state').select('data,revision').eq('user_id', uid).maybeSingle();
        if (remoteRes.error) throw remoteRes.error;
        const remote = remoteRes.data;
        const remoteRev = Number(remote && remote.revision) || 0;
        const merged = remote && remote.data ? mergeState(S, remote.data) : S;
        const nextRev = remoteRev + 1;
        let writeRes;
        if (remote) {
          writeRes = await supa.from('app_state')
            .update({ data: merged, revision: nextRev, updated_at: new Date().toISOString() })
            .eq('user_id', uid).eq('revision', remoteRev).select('revision').maybeSingle();
          if (!writeRes.error && !writeRes.data) continue; // 另一台搶先更新：重拉、合併、再試
        } else {
          writeRes = await supa.from('app_state')
            .insert({ user_id: uid, data: merged, revision: nextRev, updated_at: new Date().toISOString() })
            .select('revision').maybeSingle();
          if (writeRes.error && (writeRes.error.code === '23505' || /duplicate|unique/i.test(writeRes.error.message || ''))) continue;
        }
        if (writeRes.error) throw writeRes.error;
        S = mergeState(S, merged); // 網路等待期間本頁若又有新紀錄，也不能被剛提交的快照蓋掉
        S._mt = Date.now();
        try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {}
        await stateWrite(S).catch(() => { statePersistErr = true; });
        syncState.revision = nextRev;
        committed = true;
      }
      if (!committed) throw new Error('多裝置同時更新過於頻繁，已保留本機資料並等待下次重試');
    } while (syncPushAgain);
    syncState.pushErr = false;
    syncState.msg = '已同步 ' + new Date().toTimeString().slice(0, 5);
    flushInkQueue();
  })().catch((e) => {
    syncState.pushErr = true;
    syncState.msg = navigator.onLine === false
      ? '離線（資料已保存在本機，連上後自動補傳）'
      : '同步暫停：' + ((e && e.message) || '稍後自動重試');
  }).finally(() => {
    syncPushPromise = null;
    syncPill();
  });
  return syncPushPromise;
}
async function syncPull() {
  if (!supa || !syncState.user) return;
  try {
    const { data, error } = await supa.from('app_state').select('data,revision').eq('user_id', syncState.user.id).maybeSingle();
    if (error) { syncState.msg = '下載失敗：' + error.message; return; }
    if (data && data.data) {
      S = mergeState(S, data.data);
      S._mt = Date.now();
      syncState.revision = Number(data.revision) || 0;
      if (splitOn()) await migrateContentFromS(); // 另一台舊裝置 merge 進來的內容 → 搬進內容層、S 保持輕
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { saveQuotaErr = true; }
      await stateWrite(S).catch(() => { statePersistErr = true; });
      applyExtBank();
      syncState.msg = '已從雲端合併';
      updateBadge();
    }
    syncPush();
  } catch (e) { syncState.msg = '離線（資料在本機）'; syncPill(); }
}
function paperReviewRetryLogCount(logs, A, B) {
  const legacy = (logs || []).map((log, index) => ({ log, index }))
    .filter(({ log }) => !String(log && log.kind || ''));
  const excluded = new Set();
  for (const completedAt of [A && A.completedAt, B && B.completedAt].map(Number).filter(Boolean)) {
    let best = null;
    for (const row of legacy) {
      if (excluded.has(row.index)) continue;
      const distance = Math.abs(Number(row.log && row.log.ts || 0) - completedAt);
      if (distance <= 2000 && (!best || distance < best.distance)) best = { index:row.index, distance };
    }
    if (best) excluded.add(best.index);
  }
  return (logs || []).reduce((count, log, index) => {
    const kind = String(log && log.kind || '');
    if (kind === 'complete' || kind === 'detail-gate') return count;
    if (kind === 'retry') return count + 1;
    return count + (excluded.has(index) ? 0 : 1);
  }, 0);
}
function mergePaperReviewState(A, B) {
  const newer = Number(B && (B.mt || B.completedAt) || 0) >= Number(A && (A.mt || A.completedAt) || 0) ? B : A;
  const older = newer === A ? B : A;
  const detailOpenTimes = [A && A.detailFirstOpenedAt, B && B.detailFirstOpenedAt].map(Number).filter(Boolean);
  const logs = [], seen = new Set();
  for (const log of [...(older && older.logs || []), ...(newer && newer.logs || [])]) {
    const key = `${log && log.ts || ''}|${log && log.note || ''}|${log && log.resolved ? 1 : 0}`;
    if (!seen.has(key)) { seen.add(key); logs.push(log); }
  }
  logs.sort((x, y) => Number(x && x.ts || 0) - Number(y && y.ts || 0));
  return {
    ...(older || {}), ...(newer || {}),
    attempts: Math.max(
      Number(A && A.attempts || 0),
      Number(B && B.attempts || 0),
      paperReviewRetryLogCount(logs, A, B),
    ),
    logs,
    done: !!(A && A.done || B && B.done),
    completedAt: Math.max(Number(A && A.completedAt || 0), Number(B && B.completedAt || 0)) || null,
    solutionUnlockedAt: Math.max(
      Number(A && (A.solutionUnlockedAt || A.detailUnlockedAt) || 0),
      Number(B && (B.solutionUnlockedAt || B.detailUnlockedAt) || 0),
    ) || null,
    detailFirstOpenedAt: detailOpenTimes.length ? Math.min(...detailOpenTimes) : null,
    detailLastOpenedAt: Math.max(
      Number(A && A.detailLastOpenedAt || 0),
      Number(B && B.detailLastOpenedAt || 0),
    ) || null,
    detailViewCount: Math.max(
      Number(A && A.detailViewCount || 0),
      Number(B && B.detailViewCount || 0),
    ),
    mt: Math.max(Number(A && A.mt || 0), Number(B && B.mt || 0)),
  };
}
function paperGradeAuditShowsManualChange(audits, item, adjustedAt) {
  const limit = Number(adjustedAt) || Infinity;
  const candidates = (Array.isArray(audits) ? audits : [])
    .filter((audit) => audit && String(audit.reason || '').includes('人工覆核')
      && Number(audit.at || 0) <= limit
      && Array.isArray(audit.questions));
  let found = false;
  for (const audit of candidates) {
    const before = audit.questions.find((question) => Number(question && question.no) === Number(item && item.no));
    if (!before) continue;
    found = true;
    if (String(before.status || 'uncertain') !== String(item.status || 'uncertain')
      || Number(before.points || 0) !== Number(item.points || 0)) return true;
  }
  return found ? false : null;
}
function paperGradeMergeItemStamp(item, grade, audits) {
  const explicit = Number(item && (item.mt || item.manualAt) || 0);
  if (explicit) return explicit;
  const gradedAt = Number(grade && grade.gradedAt || 0);
  if (!item || !item.manual) return gradedAt;
  const adjustedAt = Number(grade && grade.adjustedAt || 0) || gradedAt;
  const changed = paperGradeAuditShowsManualChange(audits, item, adjustedAt);
  return changed === false ? gradedAt : adjustedAt;
}
function mergePaperGrade(A, B, auditsA, auditsB) {
  if (!A) return B;
  if (!B) return A;
  const gradeStamp = (grade) => Number(grade && (grade.adjustedAt || grade.gradedAt) || 0);
  const newer = gradeStamp(B) >= gradeStamp(A) ? B : A;
  const older = newer === A ? B : A;
  const byNo = new Map();
  const put = (item, grade, audits) => {
    const no = Number(item && item.no);
    if (!Number.isInteger(no)) return;
    const old = byNo.get(no);
    // 人工覆核只更新真的改過的題；未改題仍沿用原始 gradedAt，
    // 舊版沒有逐題時間時，使用「人工覆核前」快照判斷這題是否真的改過。
    const stamp = paperGradeMergeItemStamp(item, grade, audits);
    if (!old || stamp >= old.stamp) byNo.set(no, { item: { ...item }, stamp });
  };
  const olderAudits = older === A ? auditsA : auditsB;
  const newerAudits = newer === A ? auditsA : auditsB;
  for (const item of older.questions || []) put(item, older, olderAudits);
  for (const item of newer.questions || []) put(item, newer, newerAudits);
  const questions = [...byNo.values()].map((row) => row.item).sort((x, y) => Number(x.no) - Number(y.no));
  return paperGradeRecalculate({ ...older, ...newer, questions });
}
function mergePaperRunRecord(A, B) {
  if (!A) return B;
  if (!B) return A;
  const newer = Number(B.mt || B.submittedAt || B.createdAt || 0) >= Number(A.mt || A.submittedAt || A.createdAt || 0) ? B : A;
  const older = newer === A ? B : A;
  const review = {};
  for (const no of new Set([...Object.keys(A.review || {}), ...Object.keys(B.review || {})])) {
    review[no] = mergePaperReviewState((A.review || {})[no], (B.review || {})[no]);
  }
  const audits = [], auditIds = new Set();
  for (const audit of [...(A.gradeAudit || []), ...(B.gradeAudit || [])]) {
    const key = audit && (audit.id || `${audit.at || ''}|${audit.reason || ''}|${audit.score || ''}`);
    if (key && !auditIds.has(key)) { auditIds.add(key); audits.push(audit); }
  }
  audits.sort((x, y) => Number(x.at || 0) - Number(y.at || 0));
  const topics = [...new Set([...(A.topics || []), ...(B.topics || [])])];
  const errors = [...new Set([...(A.errors || []), ...(B.errors || [])])];
  const aiGrade = mergePaperGrade(A.aiGrade, B.aiGrade, A.gradeAudit, B.gradeAudit);
  const merged = {
    ...older, ...newer,
    mt: Math.max(Number(A.mt || 0), Number(B.mt || 0)),
    review,
    gradeAudit: audits.slice(-20),
    paperInkClients: { ...(older.paperInkClients || {}), ...(newer.paperInkClients || {}) },
    topics, errors, aiGrade,
  };
  if (aiGrade) {
    merged.score = aiGrade.score;
    merged.wrongNos = aiGrade.wrongNos.slice();
  }
  return merged;
}
function mergeState(a, b) {
  // 兩台裝置各自累積也不丟資料：紀錄類取聯集，其餘欄位取較「多」的一方
  const akey = (x) => `${x.ts || ''}|${x.qid}|${x.d}|${x.ms}|${x.ok}`; // 一律含 qid：同一毫秒的兩筆不同題（模考批改常見）不可塌成一筆
  const seen = new Set(); const attempts = [];
  for (const x of [...(a.attempts || []), ...(b.attempts || [])]) {
    const k = akey(x);
    if (!seen.has(k)) { seen.add(k); attempts.push(x); }
  }
  attempts.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  const extbank = unionById(a.extbank, b.extbank);
  const wrong = { ...(b.wrong || {}), ...(a.wrong || {}) };
  const witv = (w) => (w.grad ? 99 : (w.itv || 0)); // 畢業視為最高進度（無時間戳時的舊規則）
  for (const q of Object.keys(b.wrong || {})) {
    const A = (a.wrong || {})[q], B = b.wrong[q];
    if (!A || !B) continue;
    // 先比修改時間戳（能分辨「畢業後回鍋」vs「畢業殘影」）；兩邊都沒 mt（舊資料）才退回進度比較
    if ((A.mt || 0) !== (B.mt || 0)) { wrong[q] = (B.mt || 0) > (A.mt || 0) ? B : A; continue; }
    // 取「間隔進度較前面」的一方（itv 越大＝越接近畢業）；同 itv 才比嘗試次數。別讓落後裝置把 itv14 打回 itv1、due 拉回今天。
    wrong[q] = (witv(B) > witv(A)) ? B : (witv(A) > witv(B)) ? A : ((B.fails + B.wins > A.fails + A.wins) ? B : A);
  }
  const drills = { ...(b.drills || {}) };
  for (const k of Object.keys(a.drills || {})) {
    if (!drills[k]) { drills[k] = a.drills[k]; continue; }
    const have = new Set(drills[k].map((h) => JSON.stringify(h)));
    for (const h of a.drills[k]) if (!have.has(JSON.stringify(h))) drills[k].push(h);
  }
  const mset = new Set((a.mocks || []).map((m) => JSON.stringify(m)));
  const mocks = [...(a.mocks || [])];
  for (const m of b.mocks || []) if (!mset.has(JSON.stringify(m))) mocks.push(m);
  const mergeCorrectionBatch = (A, B) => {
    const newer = Number(A.mt || A.mockTs || 0) >= Number(B.mt || B.mockTs || 0) ? A : B;
    const older = newer === A ? B : A;
    const entryMap = new Map();
    const entryKey = (e) => `${e.qid || ''}|${e.examNo || ''}`;
    for (const entry of [...(older.entries || []), ...(newer.entries || [])]) {
      const key = entryKey(entry), old = entryMap.get(key);
      if (!old) { entryMap.set(key, entry); continue; }
      const logMap = new Map();
      for (const log of [...(old.logs || []), ...(entry.logs || [])]) {
        const logKey = `${log.ts || ''}|${log.note || ''}|${log.strokes || 0}|${log.resolved ? 1 : 0}`;
        logMap.set(logKey, log);
      }
      const oldCompleted = Number(old.completedAt || 0), newCompleted = Number(entry.completedAt || 0);
      const completed = newCompleted >= oldCompleted ? entry : old;
      entryMap.set(key, {
        ...old, ...entry,
        attempts: Math.max(Number(old.attempts || 0), Number(entry.attempts || 0)),
        logs: [...logMap.values()].sort((x, y) => Number(x.ts || 0) - Number(y.ts || 0)),
        solutionUnlockedAt: Math.max(Number(old.solutionUnlockedAt || 0), Number(entry.solutionUnlockedAt || 0)) || null,
        done: !!(old.done || entry.done),
        completedAt: Math.max(oldCompleted, newCompleted) || null,
        outcome: completed.outcome || old.outcome || entry.outcome || null,
      });
    }
    return {
      ...older, ...newer,
      mt: Math.max(Number(A.mt || A.mockTs || 0), Number(B.mt || B.mockTs || 0)),
      entries: [...entryMap.values()].sort((x, y) => Number(x.examNo || 0) - Number(y.examNo || 0)),
    };
  };
  const correctionMap = new Map();
  for (const batch of [...(b.corrections || []), ...(a.corrections || [])]) {
    if (!batch || !batch.id) continue;
    const old = correctionMap.get(batch.id);
    correctionMap.set(batch.id, old ? mergeCorrectionBatch(old, batch) : batch);
  }
  const corrections = [...correctionMap.values()].sort((x, y) => Number(x.mockTs || 0) - Number(y.mockTs || 0));
  const extMockMap = new Map();
  for (const row of [...(b.extMocks || []), ...(a.extMocks || [])]) {
    if (!row) continue;
    const key = row.paperRunId || row.id || `${row.d || ''}|${row.name || ''}|${row.ts || ''}`;
    const old = extMockMap.get(key);
    if (!old) { extMockMap.set(key, row); continue; }
    const newer = Number(row.mt || row.ts || 0) >= Number(old.mt || old.ts || 0) ? row : old;
    const older = newer === row ? old : row;
    extMockMap.set(key, {
      ...older, ...newer,
      topics: [...new Set([...(older.topics || []), ...(newer.topics || [])])],
      errors: [...new Set([...(older.errors || []), ...(newer.errors || [])])],
    });
  }
  const extMocks = [...extMockMap.values()].sort((x, y) => Number(x.ts || x.mt || 0) - Number(y.ts || y.mt || 0));
  const daily = { ...(b.daily || {}) };
  for (const d of Object.keys(a.daily || {})) daily[d] = { ...(daily[d] || {}), ...a.daily[d] };
  // 🎯 類題支線紀錄：兩裝置聯集（以 ts 去重），別讓其中一方蓋掉另一方
  const spkey = (x) => `${x.ts}|${x.qid}`; // 含 qid，跟 attempts 一致：同毫秒兩台裝置的類題紀錄不塌成一筆
  const spset = new Set((a.sidePractice || []).map(spkey));
  const sidePractice = [...(a.sidePractice || [])];
  for (const x of b.sidePractice || []) if (!spset.has(spkey(x))) sidePractice.push(x);
  const unionRecords = (left, right, keyFn) => {
    const out = [], keys = new Set();
    for (const x of [...(left || []), ...(right || [])]) {
      const k = keyFn(x);
      if (!keys.has(k)) { keys.add(k); out.push(x); }
    }
    return out.sort((x, y) => Number(x.ts || x.mt || 0) - Number(y.ts || y.mt || 0));
  };
  const outlineAttempts = unionRecords(a.outlineAttempts, b.outlineAttempts, (x) => `${x.id || ''}|${x.ts || ''}|${x.unitId || ''}`);
  const conceptAttempts = unionRecords(a.conceptAttempts, b.conceptAttempts, (x) => `${x.id || ''}|${x.ts || ''}|${x.conceptId || ''}`);
  const visionHistory = unionRecords(a.visionHistory, b.visionHistory, (x) => `${x.id || ''}|${x.ts || ''}|${x.qid || ''}`);
  const visionMap = new Map();
  for (const x of [...(b.visionQueue || []), ...(a.visionQueue || [])]) {
    if (!x || !x.id) continue;
    const old = visionMap.get(x.id);
    if (!old || Number(x.mt || x.ts || 0) >= Number(old.mt || old.ts || 0)) visionMap.set(x.id, x);
  }
  const visionQueue = [...visionMap.values()].sort((x, y) => Number(x.ts || 0) - Number(y.ts || 0));
  const paperMap = new Map();
  for (const run of [...(b.paperRuns || []), ...(a.paperRuns || [])]) {
    if (!run || !run.id) continue;
    const old = paperMap.get(run.id);
    paperMap.set(run.id, old ? mergePaperRunRecord(old, run) : run);
  }
  const paperRuns = [...paperMap.values()].sort((x, y) => Number(x.createdAt || 0) - Number(y.createdAt || 0));
  const merged = { ...b, ...a, attempts, wrong, drills, mocks, corrections, extMocks, daily, extbank, sidePractice,
    outlineAttempts, conceptAttempts, visionHistory, visionQueue, paperRuns };
  // 內容包（公式卡/重點整理）：兩裝置聯集、rev 大者勝
  if ((a.extflash || []).length || (b.extflash || []).length) merged.extflash = unionById(a.extflash, b.extflash);
  if ((a.extnotes || []).length || (b.extnotes || []).length) merged.extnotes = unionById(a.extnotes, b.extnotes);
  if ((a.extoutlines || []).length || (b.extoutlines || []).length) merged.extoutlines = unionById(a.extoutlines, b.extoutlines);
  if (a.packOff || b.packOff) { // 逐 key 取時間戳較新的一方（舊格式 true 視為 ts=0）
    const norm = (v) => (v === true ? { off: true, ts: 0 } : v);
    const po = {};
    for (const k of new Set([...Object.keys(a.packOff || {}), ...Object.keys(b.packOff || {})])) {
      const A = norm((a.packOff || {})[k]), B = norm((b.packOff || {})[k]);
      po[k] = !A ? B : !B ? A : ((B.ts || 0) > (A.ts || 0) ? B : A);
    }
    merged.packOff = po;
  }
  // 舊版曾把供應商金鑰同步進 app_state；遷移後一律剔除，下一次 syncPush 會清掉雲端殘留。
  delete merged.aikey;
  delete merged.aikeyTs;
  // 手機專區數據：days 逐日取較大者、hist 聯集、卡片記憶取看過較多的一方
  const pa = a.phone || {}, pb = b.phone || {};
  if (Object.keys(pa).length || Object.keys(pb).length) {
    const pdays = { ...(pb.days || {}) };
    for (const d of Object.keys(pa.days || {})) {
      const x = pa.days[d], y = pdays[d];
      pdays[d] = !y || x.n >= y.n ? x : y;
    }
    const phist = [...(pa.hist || [])];
    const hs = new Set(phist.map((h) => JSON.stringify(h)));
    for (const h of pb.hist || []) if (!hs.has(JSON.stringify(h))) phist.push(h);
    const pcards = { ...(pb.cards || {}) };
    for (const k of Object.keys(pa.cards || {})) {
      const x = pa.cards[k], y = pcards[k];
      pcards[k] = !y || x.s >= y.s ? x : y;
    }
    merged.phone = { days: pdays, hist: phist.slice(-200), cards: pcards };
  }
  // 必背事實的間隔複習記憶：逐事實取「最後作答時間較新」的一方（跨裝置接續複習進度）
  const fa = a.facts || {}, fb = b.facts || {};
  if (Object.keys(fa).length || Object.keys(fb).length) {
    const facts = { ...fb };
    for (const k of Object.keys(fa)) {
      if (!facts[k] || (fa[k].last || 0) > (facts[k].last || 0)) facts[k] = fa[k];
    }
    merged.facts = facts;
  }
  return merged;
}
let inkFlushBusy = false;
let inkFlushRetryTimer = null;
async function flushInkQueue() {
  if (!supa || !syncState.user || inkFlushBusy) return false;
  inkFlushBusy = true;
  let shouldContinue = false;
  let uploadedAny = false;
  try {
    const pending = await inkRecordPending(80);
    if (pending.length) {
      const rows = pending.map((local) => ({
        client_id: local.client_id,
        user_id: syncState.user.id,
        qid: local.qid,
        t0: local.t0,
        proc: local.proc || null,
        strokes: local.strokes,
        updated_at: new Date(Number(local.updatedAt) || Date.now()).toISOString(),
      }));
      const { error } = await supa.from('ink_sessions').upsert(rows, { onConflict: 'user_id,client_id' });
      if (error) {
        syncState.msg = '筆跡已保存在本機，雲端補傳尚未成功';
        syncState.pushErr = true;
        if (paperSourceSession && paperSourceSession.durability) {
          paperSourceSession.durability.cloudError = true;
          paperInkStatusRender();
        }
      } else {
        const markedIds = [];
        for (const local of pending) {
          if (await inkRecordMarkUploaded(local.client_id, local.updatedAt, syncState.user.id)) markedIds.push(local.client_id);
        }
        uploadedAny = markedIds.length > 0;
        paperInkCloudStored(markedIds);
        syncState.pushErr = false;
        shouldContinue = pending.length >= 80;
      }
    }
  } catch (_) {
    syncState.msg = '筆跡已保存在本機，連線後會自動補傳';
    syncState.pushErr = true;
  } finally {
    inkFlushBusy = false;
    await refreshInkLocalStatus();
    syncPill();
    if (inkLocalStatus.pending > 0 && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      clearTimeout(inkFlushRetryTimer);
      inkFlushRetryTimer = setTimeout(() => {
        inkFlushRetryTimer = null;
        flushInkQueue();
      }, syncState.pushErr ? 5000 : 250);
      if (inkFlushRetryTimer && typeof inkFlushRetryTimer.unref === 'function') inkFlushRetryTimer.unref();
    }
  }
  if (shouldContinue && !inkFlushRetryTimer) setTimeout(() => flushInkQueue(), 0);
  return uploadedAny;
}
function syncInk(qid, t0, proc) {
  const st = sessionInk[qid]; if (!st) return;
  // 先永久寫入 IndexedDB，再嘗試雲端；重新整理、離線或上傳失敗都不會讓原始筆畫消失。
  const strokes = st.s.filter((s) => s.t0 >= t0);
  const eras = st.e.filter((t) => t >= t0);
  if (!strokes.length && !eras.length) return;
  const sessionKey = `${qid}|${t0}`;
  const clientId = inkSessionIds.get(sessionKey) || inkClientId(qid, t0);
  inkSessionIds.set(sessionKey, clientId);
  inkRecordPut({
    client_id: clientId,
    user_id: syncState.user ? syncState.user.id : null,
    qid,
    t0,
    proc: { ...(proc || {}), draft: false },
    strokes: { s: strokes, e: eras },
    uploaded: false,
  }).then(() => {
    refreshInkLocalStatus();
    if (syncState.user) flushInkQueue();
    else { syncState.msg = '筆跡已永久保存在這台；登入後自動同步'; syncPill(); }
  }).catch(() => {
    statePersistErr = true;
    saveQuotaErr = true;
    syncState.msg = '筆跡無法寫入本機，請立刻匯出備份';
    syncPill();
  });
}
async function syncLogin(isSignup) {
  let email = $('#sy-email').value.trim();
  if (email && !email.includes('@')) email += '@gmail.com'; // 打帳號就好，自動補網域
  const pass = $('#sy-pass').value;
  if (!email || pass.length < 6) { syncState.msg = '帳號或密碼格式不對（密碼至少 6 碼）'; renderStats(); return; }
  syncState.msg = '處理中…'; renderStats();
  const { data, error } = isSignup
    ? await supa.auth.signUp({ email, password: pass, options: { emailRedirectTo: AUTH_REDIRECT_URL } })
    : await supa.auth.signInWithPassword({ email, password: pass });
  if (error) syncState.msg = (isSignup ? '註冊' : '登入') + '失敗：' + error.message;
  else if (isSignup && !data.session) syncState.msg = '註冊成功——去收信點確認連結後回來登入（或到 Supabase 後台 Auth 設定關掉 Confirm email）';
  else {
    syncState.msg = '登入成功，同步啟動';
    try { localStorage.setItem('mathA13_email', email); } catch (e) {}
  }
  renderStats();
}
async function syncLogout(all) {
  if (!supa) return;
  if (all && !confirm('要撤銷所有裝置的登入與所有已產生的配對連結嗎？\n\n其他裝置會在目前 access token 到期後登出；這台也會立刻登出。')) return;
  const scope = all ? 'global' : 'local';
  const { error } = await supa.auth.signOut({ scope });
  syncState.msg = error ? '登出失敗：' + error.message : '';
  renderStats();
}
function syncPushNow() { syncState.msg = '上傳中…'; renderStats(); syncPush().then(() => renderStats()); }
function syncCard() {
  if (!supa) return `<div class="card"><h2>☁️ 雲端同步</h2>
    <p class="dim">這個網頁環境封鎖外部連線（claude.ai artifact），雲端同步自動停用——資料照常存本機，可用下方備份匯出。
    要用同步版請開本機版 index.html 或自架網址。</p></div>`;
  if (!syncState.user) return `<div class="card"><h2>☁️ 雲端同步</h2>
    <p class="dim">帳號打使用者名稱就好。這台已保存 ${inkLocalStatus.total} 份筆跡${inkLocalStatus.pending ? `，其中 ${inkLocalStatus.pending} 份會在登入後補傳` : ''}。</p>
    <label for="sy-email" class="field-label">帳號</label>
    <input id="sy-email" class="ans-input" autocomplete="username" aria-describedby="sy-email-hint" placeholder="不用打 @gmail.com" value="${escH((() => { try { return (localStorage.getItem('mathA13_email') || '').replace(/@gmail\.com$/, ''); } catch (e) { return ''; } })())}">
    <small id="sy-email-hint" class="dim">輸入 Gmail 使用者名稱即可。</small>
    <label for="sy-pass" class="field-label">密碼</label>
    <input id="sy-pass" class="ans-input" type="password" autocomplete="current-password" placeholder="至少 6 碼" onkeydown="if(event.key==='Enter')syncLogin(false)">
    <div class="actr">
      <button class="btn" onclick="syncLogin(true)">註冊</button>
      <button class="btn primary" onclick="syncLogin(false)">登入</button>
    </div>
    ${syncState.msg ? `<p class="dim">${escH(syncState.msg)}</p>` : ''}</div>`;
  return `<div class="card"><h2>☁️ 雲端同步 <span class="okc">已登入</span></h2>
    <p class="dim">${escH(syncState.user.email || '')}｜${escH(syncState.msg || '自動同步中：每次做完題幾秒內上傳')}</p>
    <p class="dim fs13">本機筆跡 ${inkLocalStatus.total} 份｜待同步 ${inkLocalStatus.pending} 份｜雲端狀態 revision ${syncState.revision == null ? '—' : syncState.revision}</p>
    <div class="actr"><button class="btn" onclick="syncLogout(false)">登出這台</button>
    <button class="btn err" onclick="syncLogout(true)">撤銷所有登入／配對連結</button>
    <button class="btn" onclick="makePairLink()">產生一次性配對連結</button>
    <button class="btn" onclick="syncPushNow()">立即同步</button></div></div>`;
}

/* ═══════════ 啟動 ═══════════ */
/* KaTeX 自動排版：監看 #app，內容一變就把 \(…\) / $$…$$ 的數學排成正式二維樣式。
   引擎沒載入（離線 artifact）時整段跳過，內容維持 LaTeX 原文（不炸）。 */
let mjTimer = null;
function typesetMath() {
  const el = app(); if (!el) return;
  if (window.renderMathInElement) {
    try {
      renderMathInElement(el, {
        delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }],
        throwOnError: false, ignoredTags: ['script', 'noscript', 'style', 'textarea', 'canvas'],
      });
    } catch (e) {}
  } else {
    deLatexNode(el); // 離線 artifact（CDN 被擋、KaTeX 沒載）：把 \(…\) 降級成可讀純文字
  }
}
/* KaTeX 缺席時的後備：把常見 LaTeX 指令還原成可讀文字（√、分數 a/b、C(n,k)、矩陣…） */
function deLatexBody(b) {
  return b
    .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, '$1√$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\binom\{([^{}]*)\}\{([^{}]*)\}/g, 'C($1,$2)')
    .replace(/\{\}\^\{([^{}]*)\}\\!?P_\{([^{}]*)\}/g, 'P($1,$2)')
    .replace(/\\begin\{[bvp]matrix\}([\s\S]*?)\\end\{[bvp]matrix\}/g, (m, x) => '[' + x.replace(/\s*&\s*/g, ',').replace(/\\\\/g, '; ').trim() + ']')
    .replace(/\^\{([^{}]*)\}/g, '^$1').replace(/_\{([^{}]*)\}/g, '_$1')
    .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\pm/g, '±')
    .replace(/\\le\b/g, '≤').replace(/\\ge\b/g, '≥').replace(/\\ne\b/g, '≠')
    .replace(/\\(sin|cos|tan|log)\b/g, '$1').replace(/\\circ/g, '°')
    .replace(/\\[!,]/g, '').replace(/\\ /g, ' ').replace(/\\left|\\right/g, '').replace(/[{}]/g, '');
}
function deLatexNode(root) {
  if (!document.createTreeWalker) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) { return /\\\(|\$\$/.test(n.nodeValue) && n.parentElement && !n.parentElement.closest('script,style,textarea,canvas') ? 1 : 2; },
  });
  const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
  for (const nd of nodes) nd.nodeValue = nd.nodeValue
    .replace(/\\\(([\s\S]*?)\\\)/g, (m, b) => deLatexBody(b))
    .replace(/\$\$([\s\S]*?)\$\$/g, (m, b) => deLatexBody(b));
}
function initMathObserver() {
  const el = app(); if (!el || !window.MutationObserver) return;
  const mo = new MutationObserver(() => { clearTimeout(mjTimer); mjTimer = setTimeout(typesetMath, 30); });
  mo.observe(el, { childList: true, subtree: true });
  typesetMath();
}
async function boot() {
  const navEl = $('nav');
  navEl.innerHTML = Object.keys(VIEWS).map((v) =>
    `<button data-view="${v}" onclick="nav('${v}')">${uiIcon(VIEWS[v].icon)}<span>${VIEWS[v].label}</span></button>`).join('');
  installUiDialogCleaners();
  initUiObserver();
  if (!document.getElementById('day-counter')) { const dc = document.createElement('div'); dc.id = 'day-counter'; document.body.appendChild(dc); }
  renderDayCounter(); // 右上角常駐今日計數表
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // 爭取持久儲存：手寫是高優先資料，別讓瀏覽器在空間壓力下清掉
  await stateInit(); // IndexedDB 是本機權威副本；先救回 localStorage 配額滿或上次崩潰前已提交的狀態
  await refreshInkLocalStatus();
  await contentInit(); // 分家啟用時從 IndexedDB 載內容（毫秒級；未啟用是 no-op）
  // 舊版 errshots 縮圖相簿已整組移除（從無顯示介面）：清掉殘留縮圖釋放配額；store 本身保留，避免 IDB 版本遷移
  idbOpen().then((db) => { try { db.transaction('errshots', 'readwrite').objectStore('errshots').clear(); } catch (_) {} }).catch(() => {});
  applyExtBank();
  aiCredentialCleanup();
  supaInit();
  nav('home');
  decorateUi(document.body);
  initMathObserver();
  // KaTeX 是 defer 載入，可能比 app.js 晚就緒：載到就補排一次
  if (!window.renderMathInElement) window.addEventListener('load', () => setTimeout(typesetMath, 50));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
