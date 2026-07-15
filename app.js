/* 數A特訓 — 核心邏輯
   設計原則：每一題都帶碼表、每一個錯都分類、用數據決定練什麼。 */
'use strict';

const APP_VER = '0713u'; // 版本戳：顯示在做題畫面右上，用來確認裝置載到的是不是最新版

/* ═══════════ 狀態 ═══════════ */
const KEY = 'mathA13';
let S = load();
function load() {
  const def = { attempts: [], wrong: {}, drills: {}, mocks: [], daily: {}, ver: 1 };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) return { ...def, ...p }; // 補齊缺欄位，防首屏 S.attempts 之類 deref 白屏
      try { localStorage.setItem(KEY + '_corrupt', raw); } catch (e) {} // 合法 JSON 但形狀不對（被竄改/舊格式寫成 null/陣列/純值）：備份壞值後回乾淨預設，避免磚化且無法自癒
    }
  } catch (e) {}
  return { ...def };
}
let saveQuotaErr = false; // 本機 localStorage 滿了（QuotaExceeded）：不炸作答流程，雲端照常同步
function save() {
  let ok = true;
  try { localStorage.setItem(KEY, JSON.stringify(S)); saveQuotaErr = false; }
  catch (e) { saveQuotaErr = true; ok = false; if (typeof syncPill === 'function') try { syncPill(); } catch (_) {} }
  syncQueue();
  if (typeof renderDayCounter === 'function') try { renderDayCounter(); } catch (_) {} // 作答/速訓/類題記錄後，右上角今日計數即時更新
  return ok; // 匯入等大寫入要檢查回傳，別在存失敗時報「完成」
}
function exportData() {
  // 分家後備份也要帶內容層（__content 欄位；匯入時會還原並剔除，不會污染 S）
  // 匯出備份不帶 API 金鑰：aikey 是 sk-ant 明文金流憑證，備份 .json 常被 email/貼除錯/雲端硬碟自動同步而外流
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
/* 題目 schema 驗證：壞一題就可能炸掉整個做題 session，量產內容必混壞題，入庫前逐題過檢 */
function validateQ(q) {
  if (!q || typeof q.id !== 'string' || !q.id) return 'id 缺漏';
  if (!/^[\w.:-]+$/.test(q.id)) return 'id 含不合法字元'; // id 會進 inline onclick（jsA），限字元集斷絕注入面（現有題 id 全是英數/-/_/:/. ）
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
let CONTENT = { packs: {} }; // pack_id → { kind:'qpack'|'notes'|'flash', name, rev, items:[…] }
let contentTableMissing = false;
function splitOn() { try { return localStorage.getItem(SPLIT_LS) === '1'; } catch (e) { return false; } }
function extBankArr() { return splitOn() ? contentByKind('qpack') : (S.extbank || []); }
function extFlashArr() { return splitOn() ? contentByKind('flash') : (S.extflash || []); }
function extNotesArr() { return splitOn() ? contentByKind('notes') : (S.extnotes || []); }
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
    const rq = indexedDB.open('mathA13Content', 2);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs'); if (!db.objectStoreNames.contains('errshots')) db.createObjectStore('errshots'); };
    rq.onsuccess = () => { _idb = rq.result; res(_idb); }; // 快取單一連線：反覆 open 不關會累積連線、可能互相 block
    rq.onerror = () => rej(rq.error);
  });
}
async function idbReadAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const st = db.transaction('packs').objectStore('packs');
    const out = {}; const rq = st.openCursor();
    rq.onsuccess = () => { const c = rq.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    rq.onerror = () => rej(rq.error);
  });
}
async function idbWriteAll(packs) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('packs', 'readwrite');
    const st = tx.objectStore('packs');
    st.clear(); // 以傳入的 packs 為權威全集：先清再寫，還原/停用備份時舊包才不會殘留復活（唯一呼叫者 persistContent 傳完整 CONTENT.packs）
    for (const k of Object.keys(packs)) st.put(packs[k], k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
/* ── 錯題手寫存檔（IndexedDB errshots）：這是最高優先資料之一，「不設 400 張硬上限」──
   平時一張都不刪、盡量全留；只有本機儲存配額真的吃緊(>90%)才刪最舊的挪空間，並標記 errShotWarn 提醒升級。
   （雲端 ink_sessions 才是永久無上限的權威檔案；本機這份是快取縮圖，供數據頁快速瀏覽。）
   key＝qid|ts（對得回 S.attempts 那一筆）；圖大→放 IDB 不塞 localStorage。 */
let errShotWarn = false; // 本機配額吃緊：數據頁提示「該升級/清空間」
async function errShotSave(key, data) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => { const tx = db.transaction('errshots', 'readwrite'); tx.objectStore('errshots').put(data, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    errShotPrune(false).catch(() => {});
  } catch (e) {
    errShotWarn = true; // 寫失敗＝多半配額爆了：挪空間後重試一次；仍失敗雲端 ink_sessions 照樣有這題手寫
    try { await errShotPrune(true); const db = await idbOpen(); await new Promise((res) => { const tx = db.transaction('errshots', 'readwrite'); tx.objectStore('errshots').put(data, key); tx.oncomplete = res; tx.onerror = res; }); } catch (_) {}
  }
}
async function errShotCount() { try { const db = await idbOpen(); return await new Promise((res) => { const rq = db.transaction('errshots').objectStore('errshots').count(); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(0); }); } catch (e) { return 0; } }
async function errShotAll() {
  try {
    const db = await idbOpen();
    return await new Promise((res) => { const out = []; const rq = db.transaction('errshots').objectStore('errshots').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out.push({ key: c.key, ...(c.value || {}) }); c.continue(); } else res(out); }; rq.onerror = () => res(out); });
  } catch (e) { return []; }
}
async function storageInfo() {
  let usage = 0, quota = 0;
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } } catch (_) {}
  return { usage, quota, count: await errShotCount(), warn: errShotWarn };
}
/* 只有配額真的吃緊(或寫爆 force)才刪；否則全留。HARD 只是防 cursor 無限長的保險，不是刻意上限。 */
async function errShotPrune(force) {
  let over = !!force;
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); if (e.quota && e.usage / e.quota > 0.9) over = true; } } catch (_) {}
  const HARD = 20000;
  if (!over) { const c = await errShotCount(); if (c <= HARD) return; } // 空間夠：一張都不刪、全留
  errShotWarn = true;
  const all = await errShotAll();
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const keep = over ? Math.floor(all.length * 0.85) : HARD; // 配額吃緊：只刪最舊 15% 挪空間
  const delN = all.length - keep;
  if (delN <= 0) return;
  const db = await idbOpen();
  const tx = db.transaction('errshots', 'readwrite'); const st = tx.objectStore('errshots');
  for (let i = 0; i < delN; i++) st.delete(all[i].key);
}
async function contentInit() {
  if (!splitOn()) return;
  // 取「較新」的來源，別因 IDB 讀成功就短路——IDB 可讀但寫失敗時，剛匯入的內容只在 localStorage 後備裡
  let idb = null, ls = null;
  try { idb = await idbReadAll(); } catch (e) {}
  try { const raw = localStorage.getItem(CONTENT_LS); if (raw) ls = JSON.parse(raw); } catch (e) {}
  const packRev = (p) => Math.max(0, ...Object.values(p || {}).map((x) => x.rev || 0));
  CONTENT.packs = (ls && packRev(ls) > packRev(idb)) ? ls : (idb || ls || {});
}
function persistContent() {
  // 回傳 promise<boolean>：true=已落地（IDB 或 localStorage 後備成功），false=兩者皆失敗（空間不足/隱私模式）。
  // 匯入/停用後要「等寫完再 reload」，否則 IDB 交易還沒 commit 就重載＝內容遺失；遷移前要靠回傳值確認落地才敢刪舊副本。
  return idbWriteAll(CONTENT.packs).then(() => true).catch(() => {
    try { localStorage.setItem(CONTENT_LS, JSON.stringify(CONTENT.packs)); return true; }
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
/* 舊資料遷移：S 裡的 extbank/extflash/extnotes 搬進內容層（跨裝置 merge 進來的舊包也走這裡） */
async function migrateContentFromS() {
  let moved = false; const changedPids = [];
  const doPack = (pid, kind, nm, items) => { if (upsertPack(pid, kind, nm, items)) changedPids.push(pid); moved = true; };
  if (Array.isArray(S.extbank) && S.extbank.length) {
    const bySrc = {};
    for (const q of S.extbank) (bySrc[q.src || '未標來源'] = bySrc[q.src || '未標來源'] || []).push(q);
    for (const src of Object.keys(bySrc)) doPack('legacy-' + strHash(src), 'qpack', src, bySrc[src]);
  }
  if (Array.isArray(S.extflash) && S.extflash.length) doPack('legacy-flash', 'flash', '匯入公式卡', S.extflash);
  if (Array.isArray(S.extnotes) && S.extnotes.length) doPack('legacy-notes', 'notes', '匯入重點', S.extnotes);
  if (moved) {
    if (changedPids.length) { // 先確認新副本真的落地，再刪舊的——否則 IDB 不可用又 localStorage 配額滿時會兩頭皆空
      const durable = await persistContent();
      if (!durable) { try { alert('這台裝置存不下匯入的內容（空間不足或隱私模式），已保留在原位置不清除、避免遺失。請釋放空間或換裝置後再登入。'); } catch (e) {} return moved; }
    }
    delete S.extbank; delete S.extflash; delete S.extnotes;
    save(); // S 瘦身上雲（此時內容已在本機內容層 durable）
    for (const pid of changedPids) pushPack(pid); // 只在內容真的變了才重傳
  }
  return moved;
}
function pushPack(pid) {
  if (!supa || !syncState.user || !splitOn()) return;
  const p = CONTENT.packs[pid];
  if (!p) return;
  supa.from('content_packs')
    .upsert({ user_id: syncState.user.id, pack_id: pid, kind: p.kind, name: p.name, rev: p.rev, items: p.items, updated_at: new Date().toISOString() })
    .then(({ error }) => { if (error) { syncState.msg = '內容包上傳失敗：' + error.message; syncPill(); } });
}
/* 登入後：偵測 content_packs 表 → 啟用分家＋遷移；已啟用則做內容差異同步 */
async function probeContent() {
  if (!supa || !syncState.user) return;
  if (!splitOn()) {
    const { error } = await supa.from('content_packs').select('pack_id').limit(1);
    if (error) { contentTableMissing = true; return; } // 表未建：維持舊行為，隨時可補
    try { localStorage.setItem(SPLIT_LS, '1'); } catch (e) { return; }
    contentTableMissing = false;
  }
  await migrateContentFromS();
  await pullContent();
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
      const remote = data.find((r) => r.pack_id === pid);
      if (!remote || (remote.rev || 0) < (CONTENT.packs[pid].rev || 0)) pushPack(pid);
    }
    if (changed) { persistContent(); applyExtBank(); updateBadge(); }
  } catch (e) {}
}
function applyExtBank() {
  BANK.length = BUILTIN_N; // 冪等重建：內容更新（rev 覆蓋/停用切換/雲端拉回）直接重灌外部段
  const ext = extBankArr();
  const have = new Set(BANK.map((q) => q.id));
  for (const q of ext) {
    if (!q || !q.id || have.has(q.id)) continue;
    if (q.needsFigure && !q.fig) continue; // 需要圖才能解、圖還沒補上的題不出（避免無圖硬解）
    if (q.dup) continue; // 內容重複題（講義收錄的歷屆題等）：只出正主，不出分身
    if (q.src && packIsOff(q.src)) continue; // 使用者停用的內容包
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
      // 內容信封 v2：{kind:'qpack'|'flash'|'notes', name, items:[…]}
      if (d && d.kind && !Array.isArray(d.items)) { alert(`內容包格式不對：items 必須是陣列（kind=${escH(String(d.kind))}）。`); return; }
      if (d && d.kind && Array.isArray(d.items)) {
        if (d.kind === 'qpack') { importQPack(d.items, d.name); return; }
        if (d.kind === 'flash' || d.kind === 'notes') {
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
        alert(`不認得的內容包 kind：「${d.kind}」（支援 qpack / flash / notes）。`);
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
          const f = p.kind === 'flash' ? 'extflash' : p.kind === 'notes' ? 'extnotes' : 'extbank';
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
    <p class="dim">雲端同步就是主備份；這裡是額外的離線副本。「匯入」也吃<b>題包／重點包／公式卡包</b>（qpack / notes / flash 格式的 .json）。</p>
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
let inkColor = 'k';
let ink = null;
let replaying = false;
const sessionInk = {}; // qid → { s:筆畫, e:塗改時間, m:批改標記 }

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
    </span>`;
}
function inkHTML(opts) {
  const small = opts && opts.small;
  const phone = opts && opts.phone;
  return `<div class="card ink-card">
    <div class="ink-bar"><b>${phone ? '✍️ 筆記區' : '✍️ 計算區'}</b>${inkToolsHTML()}</div>
    <div id="ink-flash" class="ink-flash" style="display:none"></div>
    <div class="ink-scroll"><canvas id="ink-cv" data-h="${phone ? 170 : small ? 240 : 0}"${phone ? ' data-touch="1"' : ''}></canvas></div>
    <p class="dim ink-hint">${phone
      ? '手指直接畫；隨手算用，不批改。'
      : '兩指捲動；<b>答案寫在最後、圈起來</b>。'}</p>
  </div>`;
}
function inkSurface(key, cv, h) {
  // allowTouch＝手機筆記卡：手指就是筆（單指畫、第二指加入改捲動）；平板題卡維持只認筆、手掌免疫
  const sur = { key, cv, ctx: cv.getContext('2d'), h, cur: null, touches: new Map(), allowTouch: cv.dataset.touch === '1' };
  cv.style.pointerEvents = '';
  cv.onpointerdown = (e) => inkDown(e, sur);
  cv.onpointermove = (e) => inkMove(e, sur);
  cv.onpointerup = cv.onpointercancel = cv.onlostpointercapture = (e) => inkUp(e, sur); // lostpointercapture：系統邊緣手勢搶走已捕捉的指、不發 pointerup 時也清掉幽靈觸點，避免手機筆記卡卡在捲動模式（死指）。inkUp 冪等，正常收筆多跑一次無害
  cv.oncontextmenu = (e) => e.preventDefault();
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
  ink = { qid, t0, penAt: 0, sur: {} };
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
function inkDown(e, sur) {
  if (!ink || replaying) return;
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
  if (!sur.cur) return;
  e.preventDefault();
  ink.penAt = Date.now();
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
      if (cur.pts.length > 1) { cur.t1 = Date.now(); delete cur.tid; inkArr(sur).push(cur); }
      return;
    }
    sur.touches.delete(e.pointerId);
    if (sur.touches.size === 0) sur.scroll = false; // 所有指離開才結束捲動手勢
    return; // 按鈕/選項都以 z-index 浮在畫布上層，觸點會直接落在它們身上，不需要穿透
  }
  if (!sur.cur) return;
  const cur = sur.cur; sur.cur = null;
  if (cur.pts.length > 1) { cur.t1 = Date.now(); inkArr(sur).push(cur); } // 單點＝誤觸，不留筆畫
}
function inkUndo() {
  if (!ink) return;
  const st = inkStore(ink.qid);
  let best = null;
  for (const s of st.s) if (!s.dead && !s.arch && (!best || s.t0 > best.t0)) best = s;
  if (!best) return;
  best.dead = Date.now();
  st.e.push(Date.now());
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
  const { qid, t0 } = ink;
  if (ink.ro) ink.ro.disconnect();
  for (const k of Object.keys(ink.sur)) {
    const cv = ink.sur[k].cv;
    cv.onpointerdown = cv.onpointermove = cv.onpointerup = cv.onpointercancel = cv.onlostpointercapture = null;
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
      <div class="stuck-body">${s.ph ? `<span class="stuck-ph">${escH(s.ph)}</span>` : ''}<p>${escH(s.what)}</p>
      ${s.fix ? `<p class="stuck-fix">💡 ${escH(s.fix)}</p>` : ''}</div></div>`).join('')}</div>`;
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

/* ═══════════ 🤖 AI 批改（Anthropic API） ═══════════
   key 存進 S.aikey → 跟著雲端 app_state 同步（RLS 保護、只有本人登入讀得到）：
   桌機/手機/平板任一台填一次，全部裝置都能用。離線版（artifact）只存本機。 */
const AI_LS = 'mathA13_aikey'; // 舊版本機儲存位置，boot 時自動搬進 S.aikey
const AI_MODEL_LS = 'mathA13_aimodel';
function aiKey() {
  if (S.aikey) return S.aikey;
  try { return localStorage.getItem(AI_LS) || ''; } catch (e) { return ''; }
}
function aiKeyMigrate() {
  try {
    const lk = localStorage.getItem(AI_LS);
    if (!lk) return;
    localStorage.removeItem(AI_LS); // 搬一次就清掉，避免舊值反覆還魂
    // 舊版留下的 OAuth token（sk-ant-oat）會過期，直接丟棄不搬
    if (/^sk-ant-oat/.test(lk)) return;
    // 用最舊的時間戳搬入：只有在雲端完全沒 key 時才會被採用，絕不蓋掉使用者後來存的 key
    if (!S.aikey) { S.aikey = lk; S.aikeyTs = 1; save(); }
  } catch (e) {}
}
function aiKeySave() {
  const v = $('#aikey').value.trim();
  if (!v || v.startsWith('••')) { alert('沒有變更。'); return; }
  S.aikey = v;
  S.aikeyTs = Date.now();
  try { localStorage.removeItem(AI_LS); } catch (e) {} // 清掉舊版殘留，防止還魂
  save(); // → 雲端同步，所有裝置生效
  alert('已儲存，全裝置生效。記得按「測試連線」。');
  renderStats();
}
function aiKeyClear() {
  S.aikey = '';
  S.aikeyTs = Date.now();
  try { localStorage.removeItem(AI_LS); } catch (e) {}
  save();
  renderStats();
}
function aiCard() {
  if (aiKey()) {
    return `<div class="card"><h2>🤖 AI 批改</h2>
      <p class="dim">key 已設定，全裝置同步生效。</p>
      <p id="aitest-msg" class="dim"></p>
      <div class="actr"><button class="btn" onclick="aiKeyClear()">清除 key</button>
      <button class="btn primary" onclick="aiTest()">測試連線</button></div></div>`;
  }
  return `<div class="card"><h2>🤖 AI 批改</h2>
    <p class="dim">填 platform.claude.com 的正式 key（sk-ant-api03 開頭、Billing 要有儲值），一台填全裝置生效。</p>
    <input id="aikey" class="ans-input" type="password" autocomplete="off" placeholder="sk-ant-api03-...">
    <p id="aitest-msg" class="dim"></p>
    <div class="actr"><button class="btn primary" onclick="aiKeySave()">儲存</button></div></div>`;
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escH(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// 放進 inline onclick 單引號字串裡的 id（extbank 題 id 來源不可控，要跳脫）
function jsA(s) { return String(s).replace(/&/g, '&amp;').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
// AI 可能回非布林（字串 "false"、"no"…）；!!"false" 會變 true。嚴格判定：只有真正的 true / "true" / 1 才算對。
function aiCorrect(v) { const c = v && v.correct; return c === true || c === 1 || String(c).trim().toLowerCase() === 'true'; }
// 難度星星：clamp 到 0..3，避免髒資料 diff（如 4 或 undefined）讓 '☆'.repeat(3-diff) 丟 RangeError 把整個 render 打爆
function stars(d) { d = Math.max(0, Math.min(3, d | 0)); return '★'.repeat(d) + '☆'.repeat(3 - d); }
function starF(d) { return '★'.repeat(Math.max(0, Math.min(3, d | 0))); }
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
只回傳 JSON（不要其他文字）：{"read":"辨識出的答案","correct":true或false,"firstError":"哪一步開始錯（答對時 null）","errKind":"這次錯在哪種機制、用一個詞（答對填 null；從『正負號、公式套錯、化簡約分、移項、代入計算、審題看錯、範圍邊界、方法選錯、沒寫完』擇一最貼切，方便日後統整趨勢）","praise":"他做得好的地方（必填，答錯也要有）","nextTime":"一句可記住的下次這樣做","marks":[{"box":[0.10,0.42,0.55,0.52],"label":"6-2 應為 4"}]${hasShots ? ',"stuck":[{"phase":"想公式","what":"他卡在什麼","unstick":"下次怎麼解卡"}]' : ''}}`,
  });
  if (hasShots) for (let i = 0; i < shots.length; i++) {
    content.push({ type: 'text', text: `【停頓快照 ${i + 1}】他寫到第 ${shots[i].sec} 秒時停筆思考了 ${shots[i].dur} 秒。圖中原色＝停頓當下已寫的；藍色＝停頓結束後他接著寫的頭幾筆。` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shots[i].b64 } });
  }
  return aiJSON(content);
}
/* 共用：把 content 丟給 Anthropic API、回傳解析後的 JSON（60 秒逾時、錯誤帶可讀訊息） */
async function aiJSON(content) {
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: aiAuthHeaders(),
      body: JSON.stringify({
        model: (localStorage.getItem(AI_MODEL_LS) || 'claude-opus-4-8'),
        max_tokens: 1500,
        thinking: { type: 'disabled' }, // 批改不需要長思考；也避免思考吃掉 max_tokens 讓 JSON 截斷
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (_) {}
      if (res.status === 401) msg = 'key 無效——需要 platform.claude.com 的 API key（sk-ant-api03 開頭）；訂閱的 OAuth token 會過期';
      else if (res.status === 429) msg = '額度不足或被限流（' + msg + '）';
      throw new Error(msg);
    }
    const j = await res.json();
    const txt = (j.content || []).map((c) => c.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : txt);
  } catch (e) {
    throw (e && e.name === 'AbortError') ? new Error('逾時（60 秒沒回應）') : e;
  } finally { clearTimeout(tmr); }
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
只回傳 JSON（不要其他文字）：{"firstError":"哪步開始錯（沒有就 null）","errKind":"錯在哪種機制、用一個詞（沒錯填 null；從『正負號、公式套錯、化簡約分、移項、代入計算、審題看錯、範圍邊界、方法選錯、沒寫完』擇一，方便日後統整趨勢）","praise":"他做得好的地方（必填）","nextTime":"一句可記住的下次這樣做","marks":[]${hasShots ? ',"stuck":[{"phase":"想公式","what":"他卡在什麼","unstick":"下次怎麼解卡"}]' : ''}}` },
  ];
  if (hasShots) for (let i = 0; i < shots.length; i++) {
    content.push({ type: 'text', text: `【停頓快照 ${i + 1}】第 ${shots[i].sec} 秒起停了 ${shots[i].dur} 秒。原色＝停頓當下已寫；藍色＝之後接著寫的頭幾筆。` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shots[i].b64 } });
  }
  return aiJSON(content);
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
        ${v.praise ? `<p class="praise">🎉 你做得好：${escH(v.praise)}</p>` : ''}
        ${v.firstError ? `<p class="badc"><b>你這裡跑掉了：</b>${escH(v.firstError)}</p>` : ''}
        ${stuckHTML(stuck)}
        ${v.nextTime ? `<div class="next-step"><b>🎯 下次這樣做：</b>${escH(v.nextTime)}</div>` : ''}
        ${!v.praise && !v.firstError && !v.nextTime && !stuck.length ? '<p class="dim">過程乾淨，沒什麼好挑的——這題你穩。</p>' : ''}</div>`);
      if (qsess === sess) resumeWithMarks(q.id, v.marks, sess.markBox); // 把 AI 框畫在原字上、恢復書寫層可繼續加寫
    })
    .catch((e) => { paint(`<p class="dim">（AI 過程分析失敗：${escH((e && e.message) || e)}）</p>`); });
}
/* ═══════════ 💬 追問這題（多輪、有 context 記憶的對話） ═══════════
   位置：批改結果「AI 看手寫過程」下方。帶入題目/正解/對錯/詳解/剛才 AI 點評＋手寫圖為脈絡，
   之後每輪只追加問答；API 是 stateless→每次送完整 messages（第一則 user 夾手寫圖），故 AI 記得整段對話。 */
async function aiChatCall(system, messages) {
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal, headers: aiAuthHeaders(),
      body: JSON.stringify({
        model: (localStorage.getItem(AI_MODEL_LS) || 'claude-opus-4-8'),
        max_tokens: 1000, thinking: { type: 'disabled' }, system, messages,
      }),
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (_) {}
      if (res.status === 401) msg = 'key 無效（需 platform.claude.com 的 API key）';
      else if (res.status === 429) msg = '額度不足或被限流';
      throw new Error(msg);
    }
    const j = await res.json();
    return (j.content || []).map((c) => c.text || '').join('').trim();
  } catch (e) {
    throw (e && e.name === 'AbortError') ? new Error('逾時（60 秒沒回應）') : e;
  } finally { clearTimeout(tmr); }
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
  const system = '你是這位學測數學考生的一對一家教，正跟他討論「他剛做的這一題」。用繁體中文、口語、簡短好懂地回答他的追問；要寫算式時一律用 \\(…\\) 或 $…$ 把數學包起來（介面用 KaTeX 渲染），不要用 markdown 粗體/標題語法。只聚焦這一題與相關概念，別扯遠、別長篇大論。\n\n【這一題】\n題目：' + stripTags(q.q) + '\n正確答案：' + (correctTxt || '（未提供）') + '\n他這次' + (sess.lastOk ? '答對' : '答錯') + '了。\n' + (q.sol ? '參考詳解：' + stripTags(q.sol) + '\n' : '') + prior + (sess.calcImg ? '\n（第一則訊息附了他的手寫過程圖，請對照他實際寫法回答。）' : '');
  const imgB64 = sess.calcImg ? sess.calcImg.replace(/^data:image\/[a-z]+;base64,/, '') : null;
  return { system, imgB64 };
}
function mountChat(sess) {
  const el = document.getElementById('ai-chat');
  if (!el) return;
  if (!aiKey()) { el.innerHTML = ''; return; } // 沒設 AI key＝不顯示追問
  const turns = (sess.chat && sess.chat.turns) || [];
  const log = turns.map((t) => t.role === 'user'
    ? '<div class="cm cm-u">' + escH(t.text) + '</div>'
    : '<div class="cm cm-a">' + rtTxt(t.text) + '</div>').join('')
    + (sess.chatBusy ? '<div class="cm cm-a dim">🤖 想一下…</div>' : '');
  el.innerHTML = '<div class="ai-chat"><p class="chat-head">💬 <b>追問這題</b> <span class="dim">（可連續問，AI 記得前面的對話）</span></p>'
    + '<div class="chat-log">' + log + '</div>'
    + '<div class="chat-in"><textarea id="chatq" rows="1" placeholder="打字問這題任何問題…例如「第二步為什麼可以這樣約分？」"' + (sess.chatBusy ? ' disabled' : '') + '></textarea>'
    + '<button class="btn primary" onclick="chatSend()"' + (sess.chatBusy ? ' disabled' : '') + '>送出</button></div></div>';
  el.querySelectorAll('.cm-a').forEach((n) => { try { renderMathInElement(n, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: true }], throwOnError: false }); } catch (e) {} });
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
  if (!sess || sess.chatBusy || !aiKey()) return;
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
/* 兩種憑證都支援：sk-ant-api03（API key → x-api-key）與 sk-ant-oat（OAuth token → Bearer） */
function aiAuthHeaders() {
  const k = aiKey();
  const h = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (/^sk-ant-oat/.test(k)) {
    h['Authorization'] = 'Bearer ' + k;
    h['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    h['x-api-key'] = k;
  }
  return h;
}
async function aiTest() {
  const el = $('#aitest-msg');
  if (!aiKey()) { if (el) el.textContent = '還沒設定 key。'; return; }
  if (el) el.textContent = '測試中…';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: aiAuthHeaders(),
      body: JSON.stringify({
        model: (localStorage.getItem(AI_MODEL_LS) || 'claude-opus-4-8'),
        max_tokens: 20, thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: '回覆 OK 兩字' }],
      }),
    });
    if (res.ok) { if (el) el.innerHTML = '<span class="okc">✅ 連線成功——AI 批改可以用了</span>'; return; }
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (_) {}
    if (res.status === 401) msg = 'key 無效。需要 platform.claude.com 建立的 API key（sk-ant-api03 開頭，要先在 Billing 儲值）——訂閱帳號的 OAuth token（sk-ant-oat 開頭）會過期、也常被限流。';
    if (res.status === 429) msg = '驗證通過但被限流/額度不足：' + msg + '。若你填的是 sk-ant-oat 開頭的 token，它跟 Claude 訂閱共用額度且幾小時就過期，建議改用正式 API key。';
    if (el) el.innerHTML = `<span class="badc">❌ ${escH(msg)}</span>`;
  } catch (e) {
    if (el) el.innerHTML = `<span class="badc">❌ 連不到 API：${escH(e.message || e)}（離線 artifact 版無法使用 AI 批改，請用正式站）</span>`;
  }
}
function aiFeedbackHTML(v) {
  if (!v) return '';
  return `<div class="ai-fb"><p><b>🤖 AI 批改：</b>讀到你的答案「<b>${v.read != null ? escH(v.read) : '—'}</b>」→ 判定 ${aiCorrect(v) ? '<span class="okc">答對 ✔</span>' : '<span class="badc">答錯 ✘</span>'}</p>
    ${v.firstError ? `<p class="badc"><b>從這裡開始錯：</b>${escH(v.firstError)}</p>` : ''}
    ${v.praise ? `<p class="praise">🎉 ${escH(v.praise)}</p>` : ''}
    ${v.nextTime ? `<div class="next-step"><b>🎯 下次這樣做：</b>${escH(v.nextTime)}</div>` : ''}</div>`;
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
  if (!supa) return '離線版無法載入方法庫——請用正式站 yen-2cats.github.io/matha13。';
  if (!syncState.user) return '登入雲端同步後，才能載入老師方法庫。';
  if (MLIB_ERR) return `雲端連線暫時失敗（${MLIB_ERR}）——通常是網路不穩，按重試就好。`;
  return '這次查回來是空的——1662 條資料確定在雲端，多半是暫時性網路問題，按重試就好。';
}
function mlibCard() {
  return `<div class="card"><h2>🧑‍🏫 老師方法庫 <span class="dim">1662 條</span></h2>
      <div class="chips r">${Object.keys(TOPICS).map((k) => `<button class="btn sm" onclick="showMethods('${k}')">${TOPICS[k]}</button>`).join('')}</div>
      <div id="mlib-box"></div></div>`;
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
function sanitizeContent(s) { const parts = String(s).split(/(\\\([\s\S]*?\\\))/); for (let i = 0; i < parts.length; i += 2) parts[i] = sanitizeProse(parts[i]); return parts.join(''); }
/* literal Unicode 數學符號救援：匯入的官方試題常把「向量、上下標」寫成純字元
   （v→、AB→ 應是 \overrightarrow；x₁ 應是 x_1；10ⁿ 應是 10^n），字型沒該字就變方框/或顯示成字母後一個箭頭。
   這裡在 render 前一律轉成正規渲染，任何來源的內容都救得到（不用改內容檔）。 */
const U_SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')' };
const U_SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x', 'ʸ': 'y', 'ᵏ': 'k', 'ᵐ': 'm', 'ᵃ': 'a', 'ᵇ': 'b', 'ᵗ': 't' };
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
    if (i % 2 === 1) { // 島內：HTML 實體還原給 KaTeX（<,>,& 是關係/對齊符號，被匯入流程 escape 成 &lt;/&gt;/&amp; 會讓 KaTeX 紅字報錯）＋ literal 上下標 → _{}/^{}
      parts[i] = parts[i]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
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
function rtTxt(s) {
  s = normUnicodeMath(String(s)); // literal 向量箭頭/上下標 → 正規渲染（救匯入內容的方框/箭頭跑位）
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

const ERR_TYPES = ['概念不熟', '計算失誤', '看錯題意', '用猜的', '超時'];
const EXAM_DATE = '2027-01-22'; // 116 學年度學測（暫定）

/* ═══════════ 工具 ═══════════ */
const $ = (sel) => document.querySelector(sel);
const app = () => $('#app');
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
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
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
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
function bankById(id) {
  if (BANK_MAP) return BANK_MAP.get(id);
  return BANK.find((q) => q.id === id);
}
/* 每題作答次數表：一次掃 attempts 建表，取代排序比較子裡的 attemptsOf 全表掃描（O(題×紀錄)→O(紀錄)） */
function attCountMap() {
  const m = new Map();
  for (const a of S.attempts) m.set(a.qid, (m.get(a.qid) || 0) + 1);
  return m;
}
function teachProfileCard() {
  const p = S.teachProfile;
  if (!p) return '';
  const nEnrich = S.teach ? Object.keys(S.teach).length : 0;
  return `<details class="card teach-profile"><summary class="dim">🧑‍🏫 老師的教法總覽（做題時會自動出現，不用來這裡看）</summary>
    <p class="dim">對得上的題（${nEnrich} 題）詳解區顯示「老師這樣教」；答錯自動端出該單元方法庫。</p>
    <details><summary>他鋪陳觀念的固定順序</summary><p>${p.sequence || ''}</p></details>
    <details><summary>他反覆強調什麼</summary><p>${p.emphasis || ''}</p></details>
    <details><summary>語氣與比喻風格</summary><p>${p.voice || ''}</p></details>
    <details><summary>各單元他特別強調的重點</summary><p style="white-space:pre-wrap">${p.perUnitFocus || ''}</p></details>
    <p style="margin-top:8px"><b>標誌性口訣：</b></p>
    <div>${(p.catchphrases || []).map((c) => `<span class="cp">${c}</span>`).join('')}</div>
  </details>`;
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
  if (!v || (!v.firstError && !v.nextTime && !v.errKind)) return null;
  const a = {};
  if (v.firstError) a.fe = String(v.firstError).slice(0, 160);
  if (v.nextTime) a.nt = String(v.nextTime).slice(0, 160);
  if (v.errKind && !/^null$/i.test(String(v.errKind).trim())) a.k = String(v.errKind).slice(0, 20); // 錯法機制分類：統整趨勢用
  a.d = today();
  return a;
}
function recordAttempt(q, ok, ms, err, mode, proc, ai, opts) {
  const rec = { qid: q.id, ok, ms, err: err || null, d: today(), mode, ts: Date.now() };
  if (proc) rec.p = proc;
  const adv = advFrom(ai);
  if (adv) rec.ai = adv;
  S.attempts.push(rec);
  if ((!ok || err === '超時') && !(opts && opts.skipWrong)) {
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
/* 錯題重測結果。pass=過關（超時題還要求速度達標）；slow=答對但不夠快（不記 fails、間隔照樣打回）。
   畢業改「標記不刪」：w.grad=日期——戰果看得見、日後再錯前科不歸零。回傳 'grad'|'up'|'back'。 */
function reviewResult(qid, pass, err, slow) {
  const w = S.wrong[qid];
  if (!w) return null;
  let res;
  if (pass) {
    w.wins += 1;
    const next = { 1: 3, 3: 7, 7: 14 }[w.itv] || 0;
    if (next === 0) { w.grad = today(); res = 'grad'; } // 🎓 畢業：1→3→7→14 四關全過
    else { w.itv = next; w.due = addDays(today(), next); res = 'up'; }
  } else {
    if (!slow) w.fails += 1;
    if (err) w.err = err;
    w.itv = 1; w.due = addDays(today(), 1);
    res = 'back';
  }
  w.mt = Date.now();
  save();
  return res;
}
function dueWrong() {
  const t = today();
  return Object.keys(S.wrong).filter((id) => !S.wrong[id].grad && S.wrong[id].due <= t);
}
function gradCount() { return Object.keys(S.wrong).filter((id) => S.wrong[id].grad).length; }

/* ═══════════ 🍅 番茄鐘（25 分鐘自動配餐） ═══════════
   當下該練的，一顆番茄裝滿：到期錯題 → 速訓一輪（挑最該練的）→ 弱單元刷題；
   每做完一題自動補下一題，直到 25 分鐘滿（提早做完＝自動加菜，不會沒事做）。 */
let pomo = null;
const POMO_MIN = 25;
function startPomo() {
  if (!syncGate()) return;
  pomo = { tEnd: Date.now() + POMO_MIN * 60e3, expired: false, seen: new Set(),
           wrongIds: shuffle(dueWrong().filter((id) => bankById(id))), n: 0, pq: null, iv: null,
           stats: { wrong: 0, wrongOk: 0, drillRounds: 0, prac: 0, pracOk: 0 } };
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pomoPill();
  pomoServe();
}
function pomoPill() {
  let el = $('#pomopill');
  if (!el) { el = document.createElement('div'); el.id = 'pomopill'; el.className = 'pomo-pill'; document.body.appendChild(el); }
  const tick = () => {
    if (!pomo) return;
    const left = pomo.tEnd - Date.now();
    if (left <= 0 && !pomo.expired) {
      pomo.expired = true;
      el.classList.add('done');
      flashOnce('🍅 25 分鐘到——做完手上這題就收工');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    el.textContent = left > 0 ? `🍅 ${fmtClock(left)}` : '🍅 收尾中';
    if (left <= 180000 && left > 0) el.classList.add('warn');
  };
  tick();
  pomo.iv = setInterval(tick, 1000);
}
function pomoCancel() {
  if (!pomo) return;
  clearInterval(pomo.iv);
  const el = $('#pomopill'); if (el) el.remove();
  pomo = null;
}
function pomoServe() {
  if (!pomo) return;
  if (pomo.expired) return pomoDone();
  // ① 到期錯題（投報率最高，先清）
  const wid = pomo.wrongIds.shift();
  if (wid) {
    const q = bankById(wid);
    if (!q) return pomoServe();
    pomo.n++;
    renderQuestion(q, {
      head: `🍅 第 ${pomo.n} 題｜錯題重測`,
      review: true,
      onDone(res) {
        if (pomo && !res.excluded) { pomo.stats.wrong++; if (res.grad ? res.grad !== 'back' : res.ok) pomo.stats.wrongOk++; }
        if (pomo && !pomo.wrongIds.length) pomoMarkDaily('wrongq');
        pomoServe();
      },
    });
    return;
  }
  // ② 速訓一輪（挑最該練的；drillDone 裡的掛鉤會接回來）
  if (!pomo.stats.drillRounds) { startDrill(dailyPick().key); return; }
  // ③ 弱單元刷題：4 題一批、做完自動補下一批
  if (!pomo.pq || !pomo.pq.length) pomo.pq = pomoRefill();
  const q = pomo.pq.shift();
  if (!q) return pomoDone(); // 可用題真的被掃光
  pomo.seen.add(q.id);
  pomo.n++;
  renderQuestion(q, {
    head: `🍅 第 ${pomo.n} 題｜${TOPICS[q.topic]}`,
    onDone(res) {
      if (pomo && !res.excluded) { pomo.stats.prac++; if (res.ok) pomo.stats.pracOk++; }
      if (pomo && pomo.stats.prac >= 8) pomoMarkDaily('prac');
      pomoServe();
    },
  });
}
function pomoRefill() {
  const byTopic = {};
  for (const a of S.attempts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (byTopic[q.topic] = byTopic[q.topic] || { n: 0, ok: 0 });
    t.n++; t.ok += a.ok ? 1 : 0;
  }
  const pr = topicPriority();
  const worst = [...pr.unseen.slice(0, 2), ...pr.weak.slice(0, 2)].slice(0, 3);
  let pool = worst.length ? BANK.filter((q) => worst.includes(q.topic)) : BANK.slice();
  pool = pool.filter((q) => !pomo.seen.has(q.id));
  if (pool.length < 4) pool = BANK.filter((q) => !pomo.seen.has(q.id));
  pool = shuffle(pool).sort((a, b) => attemptsOf(a.id).length - attemptsOf(b.id).length);
  return dedupeStems(pool, 4);
}
function pomoMarkDaily(k) {
  const t = today();
  S.daily[t] = S.daily[t] || {};
  if (!S.daily[t][k]) { S.daily[t][k] = true; save(); }
}
function pomoDone() {
  if (!pomo) return;
  const st = pomo.stats;
  clearInterval(pomo.iv);
  const el = $('#pomopill'); if (el) el.remove();
  pomo = null;
  sessionActive = false; sessionMode = null; sessionChrome(false);
  app().innerHTML = `<h1>🍅 番茄鐘完成</h1>
    ${goalCrossBanner()}
    <div class="card good">
      <p class="big">錯題重測 <b>${st.wrongOk}/${st.wrong}</b>｜速訓 <b>${st.drillRounds}</b> 輪｜刷題 <b>${st.pracOk}/${st.prac}</b></p>
      <p class="praise">🎉 25 分鐘全力輸出——休息 5 分鐘再回來。</p>
      <div class="actr"><button class="btn" onclick="nav('home')">回首頁</button>
      <button class="btn primary" onclick="startPomo()">🍅 再來一顆</button></div>
    </div>`;
}

/* ═══════════ ▶ 今日菜單一鍵啟動 ═══════════
   自動排程：速度特訓（挑最該練的）→ 清到期錯題 → 主題刷題 8 題（挑最弱單元），
   每段完成自動打勾，不用自己對照清單、選單元、回頭打勾。 */
let dailyFlow = null;
function dailyPick() {
  // 挑最該練的特訓：沒練過 > 上次未達標 > 達標最久沒碰的。回 {key, why}——為什麼挑它要講得出來。
  const keys = Object.keys(DRILLS);
  const rank = (k) => {
    const h = S.drills[k] || [];
    const last = h[h.length - 1];
    if (!last) return [0, ''];
    const passed = last.med / 1000 <= DRILLS[k].target && last.acc === 100;
    return [passed ? 2 : 1, last.d];
  };
  keys.sort((a, b) => {
    const [pa, da] = rank(a), [pb, db] = rank(b);
    return pa - pb || (da < db ? -1 : da > db ? 1 : 0);
  });
  const k = keys[0];
  const tier = rank(k)[0];
  return { key: k, why: tier === 0 ? '還沒練過' : tier === 1 ? '上次未達標' : '達標最久沒複驗' };
}
/* 優先攻擊清單（首頁菜單預覽與數據頁共用）：單元＋看得見的理由 */
function attackList() {
  const pr = topicPriority();
  const out = [];
  for (const k of pr.unseen.slice(0, 3)) out.push({ k, reason: (pr.by[k] && pr.by[k].n ? `樣本只有 ${pr.by[k].n} 筆` : '沒摸過') });
  for (const k of pr.weak.slice(0, 2)) {
    const t = pr.by[k];
    const spd = t.ms / Math.max(1, t.target);
    out.push({ k, reason: `答對率 ${(100 * t.ok / t.n).toFixed(0)}%${spd > 1.2 ? '、耗時 ' + spd.toFixed(1) + '×' : ''}` });
  }
  return out.slice(0, 4);
}
/* 模擬節奏提醒：診斷數據的主要來源是模擬，斷供時要講 */
function mockDueHint() {
  if (!S.mocks.length) return S.attempts.length >= 10 ? '還沒打過系統模擬——打一場 36 分鐘，體感級分與診斷才會準' : '';
  const last = S.mocks[S.mocks.length - 1].d;
  const days = Math.round((new Date(today() + 'T00:00:00') - new Date(last + 'T00:00:00')) / 86400000);
  return days >= 4 ? `距上次模擬已 ${days} 天——建議今天打一場（36 分）` : '';
}
function startPracAuto() {
  // 自動挑最弱單元（答對率最低/耗時比最高），沒數據就全範圍
  const byTopic = {};
  for (const a of S.attempts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (byTopic[q.topic] = byTopic[q.topic] || { n: 0, ok: 0, ms: 0, target: 0 });
    t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms; t.target += qTarget(q);
  }
  const pr = topicPriority();
  const worst = [...pr.unseen.slice(0, 2), ...pr.weak.slice(0, 2)].slice(0, 3);
  let pool = worst.length ? BANK.filter((q) => worst.includes(q.topic)) : BANK.slice();
  if (pool.length < 8) pool = BANK.slice();
  const ac = attCountMap();
  pool = shuffle(pool).sort((a, b) => (ac.get(a.id) || 0) - (ac.get(b.id) || 0));
  prac = { queue: dedupeStems(pool, 8), i: 0, results: [], mode: 'practice' };
  // 挑單元的理由記下來：結果頁要能回答「為什麼是這 3 個單元」
  prac.picked = worst.map((k) => {
    const t = pr.by[k];
    return { k, reason: !t || t.n < 3 ? '沒摸過/樣本少' : `答對率 ${(100 * t.ok / t.n).toFixed(0)}%${t.ms / Math.max(1, t.target) > 1.2 ? '、耗時 ' + (t.ms / t.target).toFixed(1) + '×' : ''}` };
  });
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pracNext();
}
function startDaily() {
  // 先給看得見的菜單再開火：不然「菜單」二字點下去直接進第 1 題像被突襲
  const dp = dailyPick();
  const due = dueWrong().length;
  const atk = attackList().slice(0, 3).map((a) => TOPICS[a.k]).join('、');
  modal(`<h2>▶ 今日菜單</h2><ol style="margin:8px 0 0 20px">
      <li>⚡ 速訓：<b>${DRILLS[dp.key].name}</b> 12 題<span class="dim">（${dp.why}；幕後計時）</span></li>
      <li>📓 到期錯題 <b>${due}</b> 題${due ? '' : '<span class="dim">（今天沒有，自動跳過）</span>'}</li>
      <li>🎯 弱項刷題 8 題<span class="dim">（${atk || '全範圍'}）</span></li>
    </ol><p class="dim">每段結束自動接下一段；中途 ✕ 可退出。</p>`, [
    ['開始 →', () => { dailyFlow = { stage: 0 }; dailyNext(); }, 'primary'],
    ['🍅 只有 25 分鐘？改用番茄鐘（同菜單、時間到收工）', startPomo],
    ['先不要', null],
  ]);
}
function dailyNext() {
  if (!dailyFlow) return;
  const t = today();
  S.daily[t] = S.daily[t] || {};
  const st = dailyFlow.stage;
  if (st === 0) { dailyFlow.stage = 1; startDrill(dailyPick().key); return; }
  if (st === 1) {
    S.daily[t].drill = true; save();
    const due = dueWrong();
    if (due.length) { dailyFlow.stage = 2; startReview(due); return; }
    S.daily[t].wrongq = true; save();
    dailyFlow.stage = 3; startPracAuto(); return;
  }
  if (st === 2) { S.daily[t].wrongq = true; save(); dailyFlow.stage = 3; startPracAuto(); return; }
  if (st === 3) {
    S.daily[t].prac = true; S.daily[t].log = true; save();
    dailyFlow = null;
    nav('stats');
  }
}
function dailyBanner(stage) {
  if (!dailyFlow || dailyFlow.stage !== stage) return '';
  if (stage === 3) return `<div class="card good"><b>🎉 今日菜單全部完成！</b>四項任務已自動打勾。
    <div class="actr"><button class="btn primary" onclick="dailyNext()">看今天的數據 →</button></div></div>`;
  const due = dueWrong().length;
  const next = stage === 1
    ? (due ? `清到期錯題（${due} 題）` : '主題刷題 8 題（自動挑最弱單元）')
    : '主題刷題 8 題（自動挑最弱單元）';
  return `<div class="card good"><b>▶ 今日菜單進度 ${stage}/3 ✅</b>
    <div class="actr"><button class="btn primary" onclick="dailyNext()">下一項：${next}</button></div></div>`;
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
    for (const h of S.drills[k]) add(h.d, 12, Math.round(12 * (h.acc || 0) / 100), (h.med || 0) * 12, 3); // 速訓一輪=3點
  }
  if (S.phone && S.phone.days) {
    for (const d of Object.keys(S.phone.days)) { const p = S.phone.days[d]; add(d, p.n || 0, p.ok || 0, p.ms || 0, p.n || 0); } // 手機專區每題算 1 點；全欄位 NaN-proof（防外部污染的 localStorage/雲端列）
  }
  return days;
}
function streakOf(days) {
  let s = 0, d = today();
  if (!days[d] || !days[d].n) d = addDays(d, -1); // 今天還沒練不斷 streak，從昨天往回數
  while (days[d] && days[d].n > 0) { s++; d = addDays(d, -1); }
  return s;
}
function dailyChartSVG(days) {
  const ds = [];
  for (let i = 13; i >= 0; i--) ds.push(addDays(today(), -i));
  const vals = ds.map((d) => (days[d] ? Math.round(days[d].pts) : 0));
  const accs = ds.map((d) => (days[d] && days[d].n ? days[d].ok / days[d].n : null));
  const max = Math.max(10, DAY_GOAL, ...vals);
  const W = 700, top = 18, bh = 104, axY = top + bh, accY = 158, accH = 42, H = 216;
  const bw = 34, gap = 16;
  const xc = (i) => i * (bw + gap) + gap / 2 + bw / 2;
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="近14天每日訓練點數與答對率">`;
  s += `<text x="0" y="11" font-size="11" fill="var(--dim)">每日點數（易1／中2／難4，速訓一輪3）</text>`;
  s += `<line x1="0" y1="${axY}" x2="${W}" y2="${axY}" stroke="var(--border)"/>`;
  const gy = axY - Math.round(bh * DAY_GOAL / max); // 目標線：哪幾天達標一眼可見
  s += `<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="var(--warn)" stroke-dasharray="4 4" stroke-width="1"/>`;
  s += `<text x="${W - 2}" y="${gy - 4}" text-anchor="end" font-size="10" fill="var(--warn)">目標 ${DAY_GOAL}</text>`;
  ds.forEach((d, i) => {
    const x = i * (bw + gap) + gap / 2;
    if (vals[i] > 0) {
      const h = Math.max(3, Math.round(bh * vals[i] / max));
      s += `<rect x="${x}" y="${axY - h}" width="${bw}" height="${h}" rx="4" fill="var(--accent)" fill-opacity="${i === 13 ? 1 : 0.55}"><title>${d}：${vals[i]} 點、答對率 ${accs[i] != null ? (accs[i] * 100).toFixed(0) + '%' : '—'}</title></rect>`;
      s += `<text x="${xc(i)}" y="${axY - h - 5}" text-anchor="middle" font-size="11" fill="var(--dim)">${vals[i]}</text>`;
    } else {
      s += `<rect x="${x}" y="${axY - 2}" width="${bw}" height="2" rx="1" fill="var(--border)"/>`;
    }
    if (i % 2 === 1) s += `<text x="${xc(i)}" y="${axY + 15}" text-anchor="middle" font-size="11" fill="var(--dim)">${+d.slice(8)}日</text>`;
  });
  s += `<text x="0" y="${accY - 8}" font-size="11" fill="var(--dim)">答對率</text>`;
  s += `<line x1="0" y1="${accY + accH}" x2="${W}" y2="${accY + accH}" stroke="var(--border)"/>`;
  let prev = null;
  ds.forEach((d, i) => {
    if (accs[i] == null) { prev = null; return; }
    const x = xc(i), y = accY + accH - accs[i] * accH;
    if (prev) s += `<line x1="${prev[0]}" y1="${prev[1]}" x2="${x}" y2="${y}" stroke="var(--dim)" stroke-width="2"/>`;
    prev = [x, y];
  });
  ds.forEach((d, i) => {
    if (accs[i] == null) return;
    const x = xc(i), y = accY + accH - accs[i] * accH;
    s += `<circle cx="${x}" cy="${y}" r="4" fill="var(--dim)" stroke="#fff" stroke-width="2"><title>${d}：${(accs[i] * 100).toFixed(0)}%</title></circle>`;
  });
  s += '</svg>';
  return s;
}
/* ═══════════ 📊 今日計數表（右上角常駐；速度特訓＋易/中/難，含類題） ═══════════
   標準：速訓 20、易/中/難各 15，不限章節。速訓＝今日各速訓輪題數加總；易中難＝今日
   主題刷/錯題複習(S.attempts)＋類題(S.sidePractice) 按題目難度分桶（速訓題非 BANK→天然不入難度桶）。 */
const DAY_STD = { drill: 20, e: 20, m: 20, h: 20 };
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
  if (localStorage.getItem('mathA13_dayctr_collapsed') === '1') {
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
  const cur = localStorage.getItem('mathA13_dayctr_collapsed') === '1';
  localStorage.setItem('mathA13_dayctr_collapsed', cur ? '0' : '1');
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
/* 🏅 里程碑：可累積的戰果一字排開（全部由現有紀錄現算，零新資料） */
function milestoneCard() {
  const autoN = Object.keys(DRILLS).filter((k) => {
    const l = (S.drills[k] || []).slice(-1)[0];
    return l && l.med / 1000 <= DRILLS[k].target && l.acc === 100;
  }).length;
  const grads = gradCount();
  const days = dayAgg();
  const cur = streakOf(days);
  const ds = Object.keys(days).filter((d) => days[d].n > 0).sort();
  let maxStreak = 0, run = 0, prev = null;
  for (const d of ds) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; if (run > maxStreak) maxStreak = run; prev = d; }
  const totalMin = Math.round(Object.values(days).reduce((x, y) => x + y.ms, 0) / 60000);
  const bestMock = S.mocks.length ? Math.max(...S.mocks.map((m) => m.acc)) : null;
  if (!autoN && !grads && !maxStreak && !totalMin) return '';
  const timeStr = totalMin >= 90 ? `${Math.floor(totalMin / 60)} 時 ${totalMin % 60} 分` : `${totalMin} 分`; // 與每日投入卡同一種讀法，別讓人拿計算機對單位
  return `<div class="card"><h2>🏅 里程碑</h2><div class="mstones">
    <div class="ms"><b>${autoN}<span class="dim">/12</span></b><span>速訓自動化</span></div>
    <div class="ms"><b>${grads}</b><span>錯題畢業</span></div>
    <div class="ms"><b>${maxStreak}<span class="dim"> 天</span></b><span>最長連續${cur && cur === maxStreak ? '（進行中🔥）' : ''}</span></div>
    <div class="ms"><b>${timeStr}</b><span>累計投入</span></div>
    <div class="ms"><b>${bestMock != null ? Math.round(bestMock * 100) + '<span class="dim">%</span>' : '—'}</b><span>模擬最佳</span></div>
  </div></div>`;
}
function dailyCard() {
  const days = dayAgg();
  if (!Object.keys(days).length) return '';
  const t = today();
  const tn = days[t] ? Math.round(days[t].pts) : 0;
  const streak = streakOf(days);
  let w1 = 0, w0 = 0;
  for (let i = 0; i < 7; i++) { const a = days[addDays(t, -i)]; if (a) w1 += a.pts; }
  for (let i = 7; i < 14; i++) { const a = days[addDays(t, -i)]; if (a) w0 += a.pts; }
  w1 = Math.round(w1); w0 = Math.round(w0);
  const totalMin = Math.round(Object.values(days).reduce((x, y) => x + y.ms, 0) / 60000);
  const best = Object.entries(days).sort((a, b) => b[1].pts - a[1].pts)[0];
  const cheers = [];
  if (streak >= 3) cheers.push(`🔥 連續 <b>${streak}</b> 天有練——持續性比單日爆量更值錢`);
  if (best && best[0] === t && tn > 0 && Object.keys(days).length > 1) cheers.push(`🏆 今天是至今訓練量最高的一天（${tn} 點）`);
  if (w0 > 0 && w1 > w0) cheers.push(`📈 近 7 天 ${w1} 點，比前 7 天多 <b>${Math.round(100 * (w1 - w0) / w0)}%</b>`);
  else if (w0 > 0 && w1 > 0 && w1 < w0) cheers.push(`近 7 天 ${w1} 點、前 7 天 ${w0} 點——再 <b>${w0 - w1 + 1}</b> 點就超車自己`);
  return `<div class="card"><h2>📈 每日投入（近 14 天）</h2>
    <div class="today-row"><span>🔥 連續 <b>${streak}</b> 天</span><span>今日 <b>${tn}</b> / ${DAY_GOAL} 點</span><span class="dim">累計投入約 ${totalMin} 分鐘</span></div>
    <div class="goalbar"><div style="width:${Math.min(100, Math.round(100 * tn / DAY_GOAL))}%"></div></div>
    <div class="chartwrap">${dailyChartSVG(days)}</div>
    ${cheers.length ? `<div class="praise">${cheers.join('<br>')}</div>` : '<p class="dim">連續執行一兩週，這裡就會長出你的趨勢線——目標是讓長條圖不斷檔。</p>'}
  </div>`;
}
function todayCard() {
  const days = dayAgg();
  const t = today();
  const tn = days[t] ? Math.round(days[t].pts) : 0;
  const streak = streakOf(days);
  const goalDone = tn >= DAY_GOAL;
  const due = dueWrong().length;
  const dp = dailyPick();
  const atk = attackList().slice(0, 3);
  // streak 保衛戰：今天還沒開張時，顯示的連續天數其實「今晚不練就歸零」——要講明
  const streakLine = tn === 0 && streak > 0
    ? `<span>🔥 連續 <b>${streak}</b> 天保衛戰<span class="dim">——今天還沒開張</span></span>`
    : `<span>🔥 連續 <b>${streak}</b> 天｜今日 <b>${tn}</b> / ${DAY_GOAL} 點${goalDone ? ' <b class="okc">✅</b>' : ''}</span>`;
  const hint = mockDueHint();
  return `<div class="card"><div class="today-row">
      ${streakLine}
      <span class="shr"><button class="btn" onclick="nav('phone')">📱 零碎時間</button>
      <button class="btn primary" onclick="startDaily()">▶ 今日菜單</button></span>
    </div>
    <div class="goalbar${goalDone ? ' done' : ''}"><div style="width:${Math.min(100, Math.round(100 * tn / DAY_GOAL))}%"></div></div>
    <div class="menu-prev">
      <div class="mp-row"><span>⚡ 速訓：<b>${DRILLS[dp.key].name}</b> <span class="dim">（${dp.why}）</span></span><button class="btn sm" onclick="startDrill('${dp.key}')">單練</button></div>
      <div class="mp-row"><span>📓 到期錯題 <b class="${due ? 'warnc' : 'okc'}">${due}</b> 題${due ? ' <span class="dim">（投報率最高）</span>' : ' ✅'}</span>${due ? '<button class="btn sm" onclick="reviewDue()">單清</button>' : ''}</div>
      <div class="mp-row"><span>🎯 弱項刷題：${atk.length ? atk.map((a) => `<b>${TOPICS[a.k]}</b><span class="dim">(${a.reason})</span>`).join('、') : '<span class="dim">數據不足→全範圍</span>'}</span><button class="btn sm" onclick="startPracAuto()">單刷</button></div>
    </div>
    ${hint ? `<p class="warnc fs13" style="margin:6px 0 0">📅 ${hint}　<button class="btn sm" onclick="nav('mock')">去模擬</button></p>` : ''}</div>`;
}
/* 級分梯：9~15 一格一級，目前級分實心、13 級掛 🎯 描邊——數字有了形狀才有拉力 */
function gradeLadder(acc) {
  const lv = parseInt(gradeOf(acc), 10) || 0;
  let cells = '';
  for (let g = 9; g <= 15; g++) cells += `<span class="${lv === g ? 'cur' : ''}${g === 13 ? ' goal' : ''}">${g === 13 ? '🎯13' : g}</span>`;
  return `<div class="glad">${cells}</div>`;
}
/* 🗺️ 十四單元戰力地圖：範圍可視、點了就練 */
function masteryMap() {
  const by = topicPriority().by;
  const bankCnt = {};
  for (const q of BANK) bankCnt[q.topic] = (bankCnt[q.topic] || 0) + 1; // 各單元題庫實有題數
  let anyThin = false;
  const tiles = Object.keys(TOPICS).map((k) => {
    const t = by[k];
    const acc = t && t.n ? t.ok / t.n : null;
    const slow = t && t.target > 0 && t.ms / t.target > 1.2;
    const thin = t && t.n > 0 && t.n < 3;
    const nq = bankCnt[k] || 0;
    const scarce = nq < 6; // 題庫湊不滿一輪：別給「專攻 6 題」的空頭承諾
    if (scarce) anyThin = true;
    const cls = acc == null ? 'na' : acc >= 0.8 ? 'g' : acc >= 0.6 ? 'y' : 'r';
    return `<div class="tile ${cls}${thin ? ' thin' : ''}${scarce ? ' scarce' : ''}" onclick="startPracTopic('${k}')" title="${scarce ? TOPICS[k] + '：題庫僅 ' + nq + ' 題' : '專攻 ' + TOPICS[k] + ' 6 題'}">
      <button class="tile-notes" onclick="event.stopPropagation();showUnitNotes('${k}')" title="單元重點">📚</button>
      <span class="tile-name">${TOPICS[k]}</span>
      <span class="tile-val">${acc == null ? '—' : Math.round(acc * 100) + '%'}${slow ? ' ⏱' : ''}</span>
      <span class="tile-n">${scarce ? `<span class="warnc">庫存 ${nq} 題</span>` : (t && t.n ? t.n + ' 筆' : '沒數據')}</span>
    </div>`;
  }).join('');
  return `<div class="card"><h2>🗺️ 戰力地圖 <span class="dim">點單元＝專攻該單元</span></h2>
    <div class="tiles">${tiles}</div>
    <p class="dim fs12">灰＝沒數據；<span class="badc">紅&lt;60%</span>、<span class="warnc">黃 60~79%</span>、<span class="okc">綠 ≥80%</span>；⏱＝耗時比&gt;1.2；📚＝單元重點。${anyThin ? '<br><span class="warnc">「庫存 N 題」的單元題庫還很薄——這些單元的講義還沒匯入，之後補齊。</span>' : ''}</p></div>`;
}
/* 📚 單元重點 modal：匯入的參考書重點 + 該單元必背卡 + 老師方法庫入口 */
function typesetIn(el) {
  if (el && window.renderMathInElement) {
    try {
      renderMathInElement(el, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$$', right: '$$', display: true }], throwOnError: false });
    } catch (e) {}
  }
}
function showUnitNotes(k) {
  const notes = extNotesArr().filter((x) => x.topic === k).sort((a, b) => (a.order || 0) - (b.order || 0));
  const flash = FLASH.concat(extFlashArr()).filter((f) => f.unit === k);
  modal(`<h2>📚 ${TOPICS[k]} 重點</h2>
    <div class="notes-scroll">
      ${notes.length ? notes.map((n) => `<details class="note"><summary>${escH(n.title)}</summary><div>${rtTxt(n.html)}</div></details>`).join('') : '<p class="dim">參考書重點還沒匯入——之後把重點包（kind:notes）從 📊 數據頁匯入就會出現在這裡。</p>'}
      ${flash.length ? `<p style="margin-top:8px"><b>🧠 這單元的必背卡 ${flash.length} 張：</b></p>${flash.map((f) => `<details class="note"><summary>${rtTxt(f.front)}</summary><div>${rtTxt(f.back)}</div></details>`).join('')}` : ''}
    </div>`, [['🧑‍🏫 老師方法庫', () => { nav('wrong'); setTimeout(() => showMethods(k), 80); }], ['關閉', null, 'primary']]);
  typesetIn($('#modalov'));
}
/* 首頁洞察列：畢業戰果 + 最近的腦袋卡點（需求5 的成果要天天看得到） */
function homeInsights() {
  const g = gradCount();
  const stuck = [];
  for (let i = S.attempts.length - 1; i >= 0 && stuck.length < 2; i--) {
    const a = S.attempts[i];
    if (a.p && a.p.stuck && a.p.stuck.length) {
      const q = bankById(a.qid);
      const s = a.p.stuck[0];
      stuck.push(`<li>${q ? TOPICS[q.topic] + '：' : ''}${escH(s.what)}${s.fix ? `　<span class="okc">💡 ${escH(s.fix)}</span>` : ''}</li>`);
    }
  }
  if (!g && !stuck.length) return '';
  return `<div class="card">${g ? `<p>🎓 已畢業錯題 <b class="okc">${g}</b> 題<span class="dim">（連過 1→3→7→14 四關）</span></p>` : ''}
    ${stuck.length ? `<p class="fs13" style="margin-top:${g ? 6 : 0}px"><b>🧠 最近的卡點：</b></p><ul class="fs13">${stuck.join('')}</ul>` : ''}</div>`;
}

/* ═══════════ 導覽 ═══════════ */
const VIEWS = {
  home:  { label: '📋 診斷', fn: renderHome },
  phone: { label: '📱 手機專區', fn: renderPhone },
  drill: { label: '⚡ 速度特訓', fn: renderDrillMenu },
  prac:  { label: '🎯 主題刷題', fn: renderPracConfig },
  mock:  { label: '⏱️ 模擬實戰', fn: renderMockIntro },
  wrong: { label: '📓 錯題本', fn: renderWrong },
  tutor: { label: '🧑‍🏫 AI 老師', fn: renderTutor },
  stats: { label: '📊 數據', fn: renderStats },
  plan:  { label: '🗓️ 作戰計畫', fn: renderPlan },
};
let sessionActive = false;
let sessionMode = null; // 'prac' | 'review' | 'mock' | 'drill'
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
  dailyFlow = null; // 中途離開＝取消今日菜單接力
  pomoCancel();     // 中途離開＝番茄鐘作廢
  stopTicker();
  lastTickerFn = null; // session 終結＝碼錶 fn 作廢；否則之後在無碼錶模式（衝刺複習/背卡）按「繼續」會把殭屍碼錶叫回來對 null qsess 拋錯
  if (ink) inkStop();
  if (drill && drill.nextTimer) { clearTimeout(drill.nextTimer); drill.nextTimer = null; }
  if (phone && phone.nextTimer) clearTimeout(phone.nextTimer);
  phone = null; // 手機專區進行中的輪次作廢
  mnq = null; // 口訣快答同理
  wflash = null; // 衝刺複習中途離開即作廢（無紀錄可丟）
  qsess = null; // 讓遲到的 AI 批改回呼認得出「這一題已經結束了」
  sessionChrome(false);
  modalClose();
}
/* 中途退出：讓飼主自己選「已作答的要不要留紀錄」，不預設丟掉 */
function exitFlow(view) {
  // 誤觸離開後回到出發的入口頁，不要一律丟回首頁（想馬上重來一輪不用重新導航）
  const backTo = { drill: 'drill', phone: 'phone', wflash: 'wrong', prac: 'prac', review: 'wrong' };
  const goto = view || backTo[sessionMode] || 'home';
  if (!sessionActive) { nav(goto); return; }
  // 開著確認框的時間不算作答時間：按「繼續」時把計時起點往後平移
  const pausedAt = Date.now();
  // 開著確認框時凍結所有計時：碼錶 ticker 停、速訓/手機的自動跳題 timer 清掉（否則題目會在框後面自己跳掉、時間警示亂閃）
  stopTicker();
  const drillTimerWas = !!(drill && drill.nextTimer); if (drillTimerWas) { clearTimeout(drill.nextTimer); drill.nextTimer = null; }
  const phoneTimerWas = !!(phone && phone.nextTimer); if (phoneTimerWas) { clearTimeout(phone.nextTimer); phone.nextTimer = null; }
  const resume = () => {
    const d = Date.now() - pausedAt;
    if (sessionMode === 'mock' && mock) { mock.t0 += d; mock.tEnd += d; }
    else if (sessionMode === 'drill' && drill) drill.t0 += d;
    else if (sessionMode === 'phone' && phone) phone.t0 += d;
    else if (mnq) mnq.t0 += d; // 口訣快答暫停時間不算進本題耗時
    else if (qsess) qsess.t0 += d;
    if (ink) ink.t0 += d; // 書寫時間軸一起平移：否則暫停後 fi/停頓/卡點秒數會跟耗時對不上
    if (lastTickerFn) startTicker(lastTickerFn); // 恢復碼錶顯示
    if (drillTimerWas && drill && sessionMode === 'drill') drill.nextTimer = setTimeout(drillNext, 500); // 恢復待跳的下一題
    if (phoneTimerWas && phone && sessionMode === 'phone') phone.nextTimer = setTimeout(() => { if (phone && sessionMode === 'phone') { phone.i++; phoneQuizNext(); } }, 450);
  };
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
  if (sessionMode === 'prac' || sessionMode === 'review') {
    const nDone = sessionMode === 'review'
      ? (review ? review.i : 0)
      : S.attempts.length - (sessSnap ? sessSnap.att : S.attempts.length);
    modal(`<h2>要中途離開嗎？</h2><p>這一輪已完成 <b>${Math.max(0, nDone)}</b> 題（已記錄），進行中的這題不會保留。</p>`, [
      ['繼續作答', resume, 'primary'],
      ['保留已作答紀錄，離開', () => { endSession(); nav(goto); }],
      ['不保留（這輪全部作廢），離開', () => { rollbackSession(); endSession(); nav(goto); }],
    ]);
    return;
  }
  // drill / 手機專區 / 衝刺複習：整輪結果尚未寫入，離開即不保留本輪
  const leaveMsg = sessionMode === 'drill'
    ? '<h2>要中途離開嗎？</h2><p>離開＝本輪 12 題成績<b>全部作廢</b>（已答的也不算）。</p>'
    : sessionMode === 'wflash'
      ? '<h2>要中途離開嗎？</h2><p>衝刺複習不留紀錄，隨時可以再開。</p>'
      : '<h2>要中途離開嗎？</h2><p>這一輪還沒結束，離開不會保留本輪成績。</p>';
  modal(leaveMsg, [
    ['繼續', resume, 'primary'],
    ['離開', () => { endSession(); nav(goto); }],
  ]);
}
/* ═══ 跳出 App 保護：平板返回鍵/手勢、關分頁——一律先確認，不讓誤觸吃掉作答 ═══ */
let leavingApp = false;
window.addEventListener('beforeunload', (e) => {
  if (sessionActive && !leavingApp) { e.preventDefault(); e.returnValue = ''; }
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
  if (dailyFlow) dailyFlow = null; // 離開結果頁去任何 view＝脫離今日菜單接力（否則之後每輪結算都冒殭屍橫幅）
  sessionMode = null;
  stopTicker();
  if (ink) inkStop();
  sessionChrome(false);
  document.querySelectorAll('nav button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.scrollIntoView({ inline: 'center', block: 'nearest' }); // 手機 8 分頁橫捲時，切到右側分頁把當前分頁捲進可視範圍，別讓高亮落在畫面外
  });
  VIEWS[view].fn();
  updateBadge();
}
function updateBadge() {
  const n = dueWrong().length;
  const b = $('nav button[data-view="wrong"]');
  b.innerHTML = '📓 錯題本' + (n ? ` <span class="badge">${n}</span>` : '');
}

/* ═══════════ 首頁：作戰儀表板 ═══════════
   一眼回答三件事：①今天練什麼、練多少、為什麼（todayCard 菜單預覽）
   ②我現在在哪、離 13 級多遠（級分梯＋差距翻成題數）③哪個單元弱、點了就練（戰力地圖）。 */
function renderHome() {
  const days = Math.ceil((new Date(EXAM_DATE) - new Date()) / 86400000);
  const attempts = S.attempts.length;
  const mocks = S.mocks.length;
  let status;
  if (mocks === 0 && attempts < 10) {
    status = `<div class="card warn"><b>先做一次模擬摸底</b>，產生第一筆耗時×錯因數據。
      <div class="actr"><button class="btn primary" onclick="nav('mock')">開始 →</button></div></div>`;
  } else {
    const recent = S.attempts.slice(-30);
    const acc = recent.length ? recent.filter((a) => a.ok).length / recent.length : 0;
    const prev = S.attempts.slice(-60, -30);
    const prevAcc = prev.length >= 30 ? prev.filter((a) => a.ok).length / prev.length : null;
    const goalAcc = acc >= 0.78 ? null : (acc >= 0.72 ? 0.78 : 0.72);
    const trend = prevAcc == null ? ''
      : acc > prevAcc ? ` <span class="okc">↑ 比前 30 題 +${Math.round((acc - prevAcc) * 100)}%</span>`
      : ` <span class="dim">前 30 題 ${(prevAcc * 100).toFixed(0)}%</span>`;
    status = `<div class="card">
      <p><b>體感級分：${gradeOf(acc)}</b> <span class="dim">（近 ${recent.length} 題 ${(acc * 100).toFixed(0)}%）</span>${trend}</p>
      ${gradeLadder(acc)}
      ${goalAcc
        ? `<p class="fs13 dim">距 ${goalAcc === 0.78 ? '14 級門檻（78%）' : '13 級門檻（72%）'}差 ${Math.max(1, Math.round((goalAcc - acc) * 100))} 個百分點 ≈ 近 30 題再多對 <b>${Math.max(1, Math.ceil((goalAcc - acc) * 30))}</b> 題</p>`
        : '<p class="fs13 okc">已站上 14 級線——用錯題本與模擬把它釘穩。</p>'}
    </div>`;
  }
  const fresh = mocks === 0 && attempts < 10; // 零數據新手：摸底卡放最頂、最大聲
  app().innerHTML = `
  <div class="hero">
    <h1>數A特訓 <span class="dim" style="font-size:12px">${APP_VER}</span></h1>
    <p>距離 116 學測還有 <b class="accent">${days} 天</b></p>
  </div>
  ${fresh ? status + todayCard() : todayCard() + status}
  ${masteryMap()}
  ${homeInsights()}
  ${teachProfileCard()}
  <details class="card"><summary class="dim">為什麼這樣練</summary>
    <ul>
      <li>「看懂」≠「限時寫出」——練輸出速度與考試工程，不是再上一輪課。</li>
      <li>先量測：揪出耗時 2~3 倍的題型，不要籠統的「時間不夠」。</li>
      <li>基本運算練到反射，工作記憶留給難題。</li>
      <li>跳題紀律＋兩輪作答：會的題 100% 拿到。</li>
      <li>目標雙線：保底 73%（穩拿 13 級，門檻 72%）、進攻 80%（穩拿 14 級，門檻 78%）——缺口大半是把「會但失分」收回來。</li>
      <li>歷屆你全寫過、已失真 → 重製成類題在系統裡練；全真模擬＝補習班四次模考。本系統用到考前。</li>
    </ul>
  </details>`;
}

/* ═══════════ 速度特訓 ═══════════ */
const TRI_VAL = {
  sin: { 0:'0',30:'1/2',45:'√2/2',60:'√3/2',90:'1',120:'√3/2',135:'√2/2',150:'1/2',180:'0',210:'-1/2',225:'-√2/2',240:'-√3/2',270:'-1',300:'-√3/2',315:'-√2/2',330:'-1/2' },
  cos: { 0:'1',30:'√3/2',45:'√2/2',60:'1/2',90:'0',120:'-1/2',135:'-√2/2',150:'-√3/2',180:'-1',210:'-√3/2',225:'-√2/2',240:'-1/2',270:'0',300:'1/2',315:'√2/2',330:'√3/2' },
  tan: { 0:'0',30:'√3/3',45:'1',60:'√3',120:'-√3',135:'-1',150:'-√3/3',180:'0',210:'√3/3',225:'1',240:'√3',300:'-√3',315:'-1',330:'-√3/3' },
};
const POWERS = [['8','2/3',4],['27','2/3',9],['16','3/4',8],['32','2/5',4],['4','3/2',8],['9','3/2',27],['8','4/3',16],['27','1/3',3],['125','2/3',25],['64','2/3',16],['81','3/4',27],['16','1/2',4]];
const PYTH = [[3,4,5],[6,8,10],[5,12,13],[8,15,17],[7,24,25],[9,12,15]];

const DRILLS = {
  tri: { name: '三角函數值', desc: '特殊角 sin/cos/tan，看到就要有答案', target: 7,
    gen() {
      const cands = [];
      for (const fn of ['sin', 'cos', 'tan']) for (const a of Object.keys(TRI_VAL[fn])) cands.push({ key: `tri:${fn}:${a}`, fn, a: Number(a) });
      const c = factPick(cands); // 間隔複習：忘記的優先回鍋、連對的暫時退場
      const correct = TRI_VAL[c.fn][c.a];
      const pool = [...new Set(Object.values(TRI_VAL[c.fn]))].filter((v) => v !== correct);
      const opts = shuffle([correct, ...shuffle(pool).slice(0, 3)]);
      return { q: `${c.fn} ${c.a}° = ?`, kind: 'opts', opts, ans: opts.indexOf(correct), fk: c.key };
    } },
  logexp: { name: '指對數速算', desc: 'log 與分數指數', target: 9,
    gen() {
      const t = rint(1, 3);
      if (t === 1) { const b = pick([2, 3, 5]); const k = rint(2, 5); return { q: T('\\log_{' + b + '}(' + (b ** k) + ')') + ' = ?', kind: 'num', ans: String(k) }; }
      if (t === 2) {
        const p = factPick(POWERS.map((x) => ({ key: `pow:${x[0]}^${x[1]}`, x }))).x;
        const [fn, fd] = p[1].split('/');
        const exp = fd ? '\\frac{' + fn + '}{' + fd + '}' : p[1]; // 指數裡的分數 → 正式上下疊
        return { q: T(p[0] + '^{' + exp + '}') + ' = ?', kind: 'num', ans: String(p[2]), fk: `pow:${p[0]}^${p[1]}` };
      }
      const x = rint(2, 4), y = rint(2, 4);
      return pick([
        { q: T('2^{' + x + '}\\times 2^{' + y + '}=2^{?}'), kind: 'num', ans: String(x + y) },
        { q: T('(2^{' + x + '})^{' + y + '}=2^{?}'), kind: 'num', ans: String(x * y) },
      ]);
    } },
  quad: { name: '二次函數最小值', desc: 'y = x²+bx+c 直接讀出最小值', target: 12,
    gen() {
      const b = pick([-8, -6, -4, -2, 2, 4, 6, 8]); const c = rint(-9, 9);
      const min = c - (b * b) / 4;
      const cs = c === 0 ? '' : ` ${c < 0 ? '−' : '+'} ${Math.abs(c)}`; // 常數項 0 就別印「+ 0」
      return { q: `y = x² ${b < 0 ? '−' : '+'} ${Math.abs(b)}x${cs} 的最小值 = ?`, kind: 'num', ans: String(min) };
    } },
  rem: { name: '餘式定理', desc: 'f(x) 除以 (x−k)，答案就是 f(k)', target: 15,
    gen() {
      const a = rint(1, 3), b = rint(-5, 5), c = rint(-5, 5);
      const k = pick([-3, -2, -1, 1, 2, 3]);
      const val = a * k * k + b * k + c;
      const bs = b === 0 ? '' : ` ${b < 0 ? '−' : '+'} ${Math.abs(b)}x`;
      const cs = c === 0 ? '' : ` ${c < 0 ? '−' : '+'} ${Math.abs(c)}`;
      return { q: `${a === 1 ? '' : a}x²${bs}${cs} 除以 (x ${k < 0 ? '+' : '−'} ${Math.abs(k)}) 的餘式 = ?`, kind: 'num', ans: String(val) };
    } },
  cnk: { name: 'C 與 P 速算', desc: '組合數/排列數小數字，考場不許卡', target: 12,
    gen() {
      if (Math.random() < 0.6) {
        const n = rint(5, 10), k = rint(2, 4);
        let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1);
        return { q: `${cpH('C', n, k)} = ?`, kind: 'num', ans: String(Math.round(v)) };
      }
      const n = rint(4, 8), k = rint(2, 3);
      let v = 1; for (let i = 0; i < k; i++) v *= (n - i);
      return { q: `${cpH('P', n, k)} = ?`, kind: 'num', ans: String(v) };
    } },
  dot: { name: '向量內積與長度', desc: '內積、畢氏長度，全部心算', target: 9,
    gen() {
      if (Math.random() < 0.7) {
        const v = [rint(-6, 6), rint(-6, 6), rint(-6, 6), rint(-6, 6)];
        return { q: `(${v[0]}, ${v[1]}) · (${v[2]}, ${v[3]}) = ?`, kind: 'num', ans: String(v[0] * v[2] + v[1] * v[3]) };
      }
      const p = pick(PYTH);
      return { q: `|(${p[0]}, ${p[1]})| = ?`, kind: 'num', ans: String(p[2]) };
    } },
  seqd: { name: '等差等比速算', desc: '第 n 項與求和公式即代即出', target: 12,
    gen() {
      const t = rint(1, 3);
      if (t === 1) { const a = rint(-5, 5), d = rint(2, 6), n = rint(5, 12); return { q: `等差：a₁=${a}、d=${d}，a${String(n).split('').map(c=>'₀₁₂₃₄₅₆₇₈₉'[+c]).join('')} = ?`, kind: 'num', ans: String(a + (n - 1) * d) }; }
      if (t === 2) { const a = rint(1, 3), r = pick([2, 3]), n = rint(3, 6); return { q: `等比：a₁=${a}、r=${r}，第 ${n} 項 = ?`, kind: 'num', ans: String(a * r ** (n - 1)) }; }
      const n = rint(5, 15);
      return { q: `1 + 2 + … + ${n} = ?`, kind: 'num', ans: String(n * (n + 1) / 2) };
    } },
  mul: { name: '兩位數心算', desc: '乘法與平方——計算慢，全卷都慢', target: 15,
    gen() {
      if (Math.random() < 0.5) { const a = rint(12, 29), b = rint(11, 19); return { q: `${a} × ${b} = ?`, kind: 'num', ans: String(a * b) }; }
      const a = rint(11, 25);
      return { q: `${a}² = ?`, kind: 'num', ans: String(a * a) };
    } },
  quadroot: { name: '解一元二次', desc: '十字交乘直接報兩根——全卷最高頻的機械步驟（近5年約10題用到）', target: 15,
    gen() {
      const eq = (b, c) => `x²${b ? (b > 0 ? ` + ${b}x` : ` − ${-b}x`) : ''}${c ? (c > 0 ? ` + ${c}` : ` − ${-c}`) : ''} = 0`;
      if (Math.random() < 0.2) {
        const r = rint(-6, 6) || 3;
        return { q: `${eq(-2 * r, r * r)}，重根 x = ?`, kind: 'num', ans: String(r) };
      }
      let p = rint(-9, 9) || 2;
      let q2 = rint(-9, 9) || -3;
      if (p === q2) q2 = p + rint(1, 4);
      const lo = Math.min(p, q2), hi = Math.max(p, q2);
      return { q: `${eq(-(p + q2), p * q2)}，兩根 = ?（逗號分隔、順序不拘，如 5,-1）`, kind: 'num', ans: `${lo},${hi}` };
    } },
  frac: { name: '分數四則', desc: '機率、期望值的隱形時間殺手兼粗心大戶——答案一律最簡分數', target: 10,
    gen(easy) { // easy → 手機模式：分母壓小，確保純心算
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const red = (p, q) => {
        if (q < 0) { p = -p; q = -q; }
        const d = gcd(Math.abs(p), q) || 1;
        p /= d; q /= d;
        return q === 1 ? String(p) : `${p}/${q}`;
      };
      const t = rint(1, 4);
      const cap = easy ? 6 : 9;
      const a = rint(1, cap - 1), b = rint(2, cap), c = rint(1, cap - 1), d = rint(2, cap);
      if (t === 1) {
        const plus = Math.random() < 0.5;
        return { q: `${fracH(a, b)} ${plus ? '+' : '−'} ${fracH(c, d)} = ?（最簡分數）`, kind: 'num', ans: red(plus ? a * d + c * b : a * d - c * b, b * d) };
      }
      if (t === 2) return { q: `${fracH(a, b)} × ${fracH(c, d)} = ?（最簡分數）`, kind: 'num', ans: red(a * c, b * d) };
      if (t === 3) return { q: `${fracH(a, b)} ÷ ${fracH(c, d)} = ?（最簡分數）`, kind: 'num', ans: red(a * d, b * c) };
      const k = rint(2, easy ? 4 : 6), p = rint(2, easy ? 7 : 9), q2 = rint(p + 1, easy ? 9 : 12);
      return { q: `約分到最簡：${fracH(p * k, q2 * k)} = ?`, kind: 'num', ans: red(p, q2) };
    } },
  root: { name: '根式化簡', desc: '√48 要一眼變 4√3——所有距離、長度計算的收尾動作', target: 8,
    gen() {
      const t = rint(1, 3);
      if (t === 1) {
        const k = rint(2, 9), m = pick([2, 3, 5, 6, 7, 10]);
        const right = `${k}√${m}`;
        const opts = shuffle([right, `${k + 1}√${m}`, `${k}√${m === 10 ? 5 : m + (m === 3 ? 2 : 1)}`, `${k * 2}√${m}`]);
        return { q: `化簡：√${k * k * m} = ?`, opts, ans: opts.indexOf(right) };
      }
      if (t === 2) {
        const b = pick([2, 3, 5]), tt = rint(1, 4);
        const right = tt === 1 ? `√${b}` : `${tt}√${b}`;
        const cand = [right, `${tt}/√${b}`, `${tt * b}√${b}`, `${tt + 1}√${b}`, `${tt + 2}√${b}`, `${tt * b}/√${b}`];
        const opts = shuffle([...new Set(cand)].slice(0, 4));
        const ai = opts.indexOf(right);
        return { q: `有理化：${fracH(tt * b, '√' + b)} = ?`, opts, ans: ai };
      }
      // 距離計算收尾：√(x²+y²)
      const cases = [
        [6, 2, '2√10', ['4√10', '2√5', '√38']],
        [4, 2, '2√5', ['4√5', '2√10', '√18']],
        [6, 3, '3√5', ['9√5', '3√10', '2√5']],
        [5, 5, '5√2', ['2√5', '25√2', '5']],
        [4, 4, '4√2', ['2√4', '8', '4']],
        [8, 4, '4√5', ['2√5', '4√2', '8√5']],
        [3, 4, '5', ['7', '√7', '5√2']],
        [6, 8, '10', ['14', '2√7', '10√2']],
        [5, 12, '13', ['17', '√17', '13√2']],
        [9, 3, '3√10', ['9√3', '3√3', '27']],
      ];
      const cc = factPick(cases.map((x) => ({ key: `rootc:${x[0]},${x[1]}`, x })));
      const [x, y, right, wrongs] = cc.x;
      const opts = shuffle([right, ...wrongs]);
      return { q: `√(${x}² + ${y}²) = ?（距離計算的收尾）`, opts, ans: opts.indexOf(right), fk: cc.key };
    } },
  mat2: { name: '2×2 矩陣速算', desc: 'det、面積、矩陣作用——112 起連三年必考的新主角', target: 10,
    gen(maxT) { // maxT=2 → 手機模式只出 det/面積（矩陣作用心算負荷太重）
      const t = rint(1, maxT || 3);
      for (let tries = 0; tries < 8; tries++) {
        const a = rint(-6, 6), b = rint(-6, 6), c = rint(-6, 6), d = rint(-6, 6);
        if (t === 1) return { q: `二階行列式 ${m2H(a, b, c, d, 1)} = ?`, kind: 'num', ans: String(a * d - b * c) };
        if (t === 2) {
          const x1 = rint(-5, 5), y1 = rint(-5, 5), x2 = rint(-5, 5), y2 = rint(-5, 5);
          if (x1 * y2 - x2 * y1 === 0) continue;
          return { q: `向量 (${x1}, ${y1}) 與 (${x2}, ${y2}) 張出的平行四邊形面積 = ?`, kind: 'num', ans: String(Math.abs(x1 * y2 - x2 * y1)) };
        }
        const x = rint(-4, 4), y = rint(-4, 4);
        if (!x && !y) continue;
        const right = `(${a * x + b * y}, ${c * x + d * y})`;
        const opts = [...new Set([right, `(${a * x + c * y}, ${b * x + d * y})`, `(${a * x - b * y}, ${c * x - d * y})`, `(${c * x + d * y}, ${a * x + b * y})`])];
        if (opts.length < 4) continue;
        const sh = shuffle(opts);
        return { q: `矩陣 A = ${m2H(a, b, c, d)}，A 作用在向量 (${x}, ${y}) 的結果 = ?`, opts: sh, ans: sh.indexOf(right) };
      }
      return { q: `二階行列式 ${m2H(2, 3, 1, 4, 1)} = ?`, kind: 'num', ans: '5' };
    } },
};
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
function texVal(s) { return T(texBody(s)); }
/* 2×2：det→行列式直線 vmatrix，否則矩陣方括號 bmatrix */
function m2H(a, b, c, d, det) { const L = det ? 'vmatrix' : 'bmatrix'; return T('\\begin{' + L + '}' + a + ' & ' + b + ' \\\\ ' + c + ' & ' + d + '\\end{' + L + '}'); }
function fracH(n, d) { return T('\\frac{' + texBody(String(n)) + '}{' + texBody(String(d)) + '}'); }
function cpH(L, n, k) { return T(L + '^{' + n + '}_{' + k + '}'); } // 台灣寫法：C/P 右上 n、右下 k（非美式 \binom 括號）
/* 選項/正解字串 → LaTeX 島（給程式產生的選項與答案；DB 內容已是 LaTeX，不要再過這裡） */
function mDispOpt(s) { return typeof s === 'string' ? texVal(s) : s; }

/* ═══════════ 📱 手機專區 ═══════════
   零碎時間、單手、全按鈕作答（不手寫不打字）。內容＝學測數A該背/該心算的：
   公式、定理、幾何原則、特殊值＋老師 42 堂課強調的口訣。紀錄存 S.phone → 雲端同步。 */
const FLASH = [
  { id: "f1", unit: "num", front: "算幾不等式", back: "\\(\\frac{a+b}{2} \\ge \\sqrt{ab}\\)（\\(a,b \\gt 0\\)；等號成立 \\(\\iff a=b\\)）" },
  { id: "f2", unit: "num", front: "\\(|x-a| \\lt r\\) 拆開來是？", back: "\\(a-r \\lt x \\lt a+r\\)（絕對值＝到 \\(a\\) 的距離小於 \\(r\\)）" },
  { id: "f3", unit: "num", front: "和/差的立方公式 \\(a^3 \\pm b^3\\)", back: "\\(a^3 \\pm b^3 = (a \\pm b)(a^2 \\mp ab + b^2)\\)" },
  { id: "f4", unit: "poly", front: "根與係數（\\(ax^2+bx+c=0\\)）", back: "兩根和 \\(= -\\frac{b}{a}\\)、兩根積 \\(= \\frac{c}{a}\\)" },
  { id: "f5", unit: "poly", front: "判別式判根", back: "\\(b^2-4ac\\)：\\(\\gt 0\\) 兩相異實根、\\(=0\\) 重根、\\(\\lt 0\\) 無實根" },
  { id: "f6", unit: "poly", front: "拋物線 \\(y=ax^2+bx+c\\) 的頂點 \\(x\\) 座標", back: "\\(x = -\\frac{b}{2a}\\)（最大/最小值發生處）" },
  { id: "f7", unit: "poly", front: "餘式定理", back: "\\(f(x)\\) 除以 \\((x-a)\\) 的餘式 \\(= f(a)\\)" },
  { id: "f8", unit: "poly", front: "因式定理", back: "\\(f(a) = 0 \\iff (x-a)\\) 是 \\(f(x)\\) 的因式" },
  { id: "f9", unit: "line", front: "點 \\((x_0,y_0)\\) 到直線 \\(ax+by+c=0\\) 的距離", back: "\\(\\frac{|ax_0+by_0+c|}{\\sqrt{a^2+b^2}}\\)" },
  { id: "f10", unit: "line", front: "兩直線垂直的斜率條件", back: "\\(m_1 \\cdot m_2 = -1\\)（平行則 \\(m_1 = m_2\\)）" },
  { id: "f11", unit: "line", front: "圓 \\(x^2+y^2+dx+ey+f=0\\) 的圓心", back: "\\(\\left(-\\frac{d}{2}, -\\frac{e}{2}\\right)\\)，半徑 \\(= \\sqrt{\\frac{d^2}{4}+\\frac{e^2}{4}-f}\\)" },
  { id: "f12", unit: "line", front: "直線與圓的位置關係怎麼判？", back: "比圓心到直線距離 \\(d\\) 與半徑 \\(r\\)：\\(d \\lt r\\) 交兩點、\\(d=r\\) 相切、\\(d \\gt r\\) 不相交" },
  { id: "f13", unit: "line", front: "圓外一點的切線長", back: "\\(\\sqrt{d^2-r^2}\\)（\\(d=\\)點到圓心距離）" },
  { id: "f14", unit: "line", front: "三角形的外心／內心／重心是什麼線的交點？", back: "外心＝中垂線交點（到三頂點等距）；內心＝角平分線交點（到三邊等距）；重心＝中線交點（分中線 2:1）" },
  { id: "f15", unit: "exp", front: "指數律三條", back: "\\(a^m\\cdot a^n = a^{m+n}\\)；\\((a^m)^n = a^{mn}\\)；\\(a^m/a^n = a^{m-n}\\)" },
  { id: "f16", unit: "exp", front: "對數律三條", back: "\\(\\log(ab)=\\log a+\\log b\\)；\\(\\log(a/b)=\\log a-\\log b\\)；\\(\\log a^n = n\\cdot\\log a\\)" },
  { id: "f17", unit: "exp", front: "換底公式", back: "\\(\\log_a b = \\log b / \\log a\\)（任何新底都行）；\\(\\log_a b \\cdot \\log_b a = 1\\)" },
  { id: "f18", unit: "exp", front: "正整數 N 的位數", back: "位數 \\(= \\lfloor\\log_{10}N\\rfloor + 1\\)" },
  { id: "f19", unit: "exp", front: "\\(y=a^x\\) 與 \\(y=\\log_a x\\) 必過的點", back: "\\(a^x\\) 過 \\((0,1)\\)；\\(\\log_a x\\) 過 \\((1,0)\\)；兩圖形對 \\(y=x\\) 對稱" },
  { id: "f20", unit: "seq", front: "等差數列 \\(a_n\\) 與前 \\(n\\) 項和", back: "\\(a_n = a_1+(n-1)d\\)；\\(S_n = n(a_1+a_n)/2\\)" },
  { id: "f21", unit: "seq", front: "等比數列 \\(a_n\\) 與前 \\(n\\) 項和", back: "\\(a_n = a_1\\cdot r^{n-1}\\)；\\(S_n = a_1(1-r^n)/(1-r)\\)（\\(r\\ne 1\\)）" },
  { id: "f22", unit: "seq", front: "\\(1+2+\\cdots+n\\) 與 \\(1^2+2^2+\\cdots+n^2\\)", back: "\\(n(n+1)/2\\)；\\(n(n+1)(2n+1)/6\\)" },
  { id: "f24", unit: "comb", front: "\\(C(n,k)\\) 與 \\(P(n,k)\\) 的公式", back: "\\(C(n,k)=n!/(k!(n-k)!)\\)；\\(P(n,k)=n!/(n-k)!\\)；\\(C(n,k)=C(n,n-k)\\)" },
  { id: "f25", unit: "comb", front: "環狀排列", back: "\\(n\\) 人圍圓桌 \\(= (n-1)!\\)" },
  { id: "f26", unit: "comb", front: "重複組合 H", back: "\\(H(n,k) = C(n+k-1, k)\\)（\\(n\\) 類選 \\(k\\) 個可重複）" },
  { id: "f27", unit: "comb", front: "二項式定理的一般項", back: "\\((x+y)^n\\) 的一般項 \\(= C(n,k)\\cdot x^{n-k}\\cdot y^k\\)" },
  { id: "f28", unit: "comb", front: "取捨原理（兩集合）", back: "\\(|A\\cup B| = |A|+|B|-|A\\cap B|\\)" },
  { id: "f29", unit: "prob", front: "條件機率", back: "\\(P(A|B) = \\frac{P(A\\cap B)}{P(B)}\\)" },
  { id: "f30", unit: "prob", front: "獨立事件的判定", back: "\\(A\\)、\\(B\\) 獨立 \\(\\iff P(A\\cap B) = P(A)\\cdot P(B)\\)" },
  { id: "f31", unit: "prob", front: "期望值", back: "\\(E = \\sum\\)（值 × 機率）" },
  { id: "f32", unit: "data", front: "資料全部做 \\(ax+b\\) 變換後，平均與標準差？", back: "平均 \\(\\to a\\mu+b\\)；標準差 \\(\\to |a|\\sigma\\)（平移不改變標準差）" },
  { id: "f33", unit: "data", front: "相關係數 \\(r\\) 的範圍與迴歸直線必過點", back: "\\(-1 \\le r \\le 1\\)；迴歸直線必過 \\((\\bar{x}, \\bar{y})\\)" },
  { id: "f34", unit: "trig1", front: "\\(\\sin/\\cos/\\tan\\) \\(30^\\circ\\)、\\(45^\\circ\\)、\\(60^\\circ\\)", back: "\\(\\sin\\): \\(\\frac{1}{2}\\)、\\(\\frac{\\sqrt{2}}{2}\\)、\\(\\frac{\\sqrt{3}}{2}\\)｜\\(\\cos\\): \\(\\frac{\\sqrt{3}}{2}\\)、\\(\\frac{\\sqrt{2}}{2}\\)、\\(\\frac{1}{2}\\)｜\\(\\tan\\): \\(\\frac{\\sqrt{3}}{3}\\)、\\(1\\)、\\(\\sqrt{3}\\)" },
  { id: "f35", unit: "trig1", front: "平方關係與商數關係", back: "\\(\\sin^2\\theta+\\cos^2\\theta=1\\)；\\(\\tan\\theta = \\frac{\\sin\\theta}{\\cos\\theta}\\)" },
  { id: "f36", unit: "trig1", front: "正弦定理", back: "\\(\\frac{a}{\\sin A} = \\frac{b}{\\sin B} = \\frac{c}{\\sin C} = 2R\\)（\\(R=\\)外接圓半徑）" },
  { id: "f37", unit: "trig1", front: "餘弦定理", back: "\\(c^2 = a^2+b^2-2ab\\cdot\\cos C\\)（求邊）；\\(\\cos C = \\frac{a^2+b^2-c^2}{2ab}\\)（求角）" },
  { id: "f38", unit: "trig1", front: "三角形面積（兩邊夾角）與海龍公式", back: "面積 \\(= \\frac{1}{2}ab\\cdot\\sin C\\)；海龍 \\(= \\sqrt{s(s-a)(s-b)(s-c)}\\)，\\(s=\\)半周長" },
  { id: "f39", unit: "trig1", front: "\\(\\sin(180^\\circ-\\theta)\\)、\\(\\cos(180^\\circ-\\theta)\\)", back: "\\(\\sin(180^\\circ-\\theta)=\\sin\\theta\\)；\\(\\cos(180^\\circ-\\theta)=-\\cos\\theta\\)（補角）" },
  { id: "f40", unit: "trig2", front: "和角公式 \\(\\sin(A\\pm B)\\)、\\(\\cos(A\\pm B)\\)", back: "\\(\\sin(A\\pm B)=\\sin A\\cos B\\pm\\cos A\\sin B\\)；\\(\\cos(A\\pm B)=\\cos A\\cos B\\mp\\sin A\\sin B\\)（\\(\\cos\\) 符號相反）" },
  { id: "f41", unit: "trig2", front: "倍角公式", back: "\\(\\sin 2\\theta = 2\\sin\\theta\\cos\\theta\\)；\\(\\cos 2\\theta = \\cos^2\\theta - \\sin^2\\theta = 2\\cos^2\\theta - 1 = 1 - 2\\sin^2\\theta\\)" },
  { id: "f42", unit: "trig2", front: "疊合 \\(a\\cdot\\sin\\theta + b\\cdot\\cos\\theta\\)", back: "\\(= \\sqrt{a^2+b^2}\\cdot\\sin(\\theta+\\varphi)\\)，最大值 \\(\\sqrt{a^2+b^2}\\)、最小值 \\(-\\sqrt{a^2+b^2}\\)" },
  { id: "f43", unit: "trig2", front: "\\(y = \\sin(bx)\\) 的週期", back: "\\(2\\pi/|b|\\)（tan 的週期是 \\(\\pi/|b|\\)）" },
  { id: "f44", unit: "vec", front: "內積的兩種算法", back: "\\(a\\cdot b = |a||b|\\cos\\theta = x_1 x_2 + y_1 y_2\\)" },
  { id: "f45", unit: "vec", front: "向量垂直與平行的判定", back: "垂直 \\(\\iff\\) 內積\\(=0\\)；平行 \\(\\iff x_1 y_2 - x_2 y_1 = 0\\)" },
  { id: "f46", unit: "vec", front: "正射影向量", back: "\\(a\\) 在 \\(b\\) 上的正射影 \\(= (a\\cdot b/|b|^2)\\cdot b\\)；長度 \\(= |a\\cdot b|/|b|\\)" },
  { id: "f47", unit: "vec", front: "兩向量張出的三角形面積", back: "\\((1/2)|x_1 y_2 - x_2 y_1|\\)（平行四邊形不除 2）" },
  { id: "f48", unit: "vec", front: "分點公式（\\(AP:PB = m:n\\)）", back: "\\(P = (n\\cdot A + m\\cdot B)/(m+n)\\)——靠近誰，誰的權重反而小" },
  { id: "f49", unit: "vec", front: "三角形重心（向量）", back: "\\(G = (A+B+C)/3\\)" },
  { id: "f50", unit: "vec", front: "柯西不等式（二維）", back: "\\((a^2+b^2)(c^2+d^2) \\ge (ac+bd)^2\\)；等號 \\(\\iff ad=bc\\)（平行時）" },
  { id: "f51", unit: "svec", front: "空間兩點距離", back: "\\(\\sqrt{\\Delta x^2 + \\Delta y^2 + \\Delta z^2}\\)" },
  { id: "f52", unit: "svec", front: "外積的幾何意義", back: "\\(|a\\times b| =\\) 兩向量張出的平行四邊形面積；方向依右手定則、同時垂直 \\(a\\) 與 \\(b\\)" },
  { id: "f53", unit: "splane", front: "平面 \\(ax+by+cz=d\\) 的法向量", back: "\\((a, b, c)\\)——係數直接讀" },
  { id: "f54", unit: "splane", front: "點到平面距離", back: "\\(\\frac{|ax_0+by_0+cz_0-d|}{\\sqrt{a^2+b^2+c^2}}\\)" },
  { id: "f55", unit: "splane", front: "兩平面的夾角", back: "＝兩法向量的夾角（取銳角）；平行 \\(\\iff\\) 法向量平行" },
  { id: "f56", unit: "svec", front: "三垂線定理", back: "平面外一點的斜線在平面上的投影若垂直平面內某直線，則斜線本身也垂直該直線（垂直投影 \\(\\Rightarrow\\) 垂直斜線）" },
  { id: "f57", unit: "mat", front: "二階行列式與面積放大率", back: "\\(\\det = ad-bc\\)；線性變換把面積放大 \\(|\\det|\\) 倍" },
  { id: "f58", unit: "mat", front: "二階反矩陣", back: "\\(\\frac{1}{ad-bc}\\cdot\\begin{bmatrix} d & -b \\\\ -c & a \\end{bmatrix}\\)——主對角線互換、副對角線變號" },
  { id: "f59", unit: "mat", front: "旋轉 \\(\\theta\\) 的矩陣", back: "\\(\\begin{bmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{bmatrix}\\)" },
  { id: "f60", unit: "mat", front: "轉移矩陣的特徵", back: "每一行（欄）的和 \\(= 1\\)、元素皆 \\(\\ge 0\\)；穩定狀態＝乘再多次也不變的分布" },
  { id: "f61", unit: "line", front: "平行四邊形對角線性質", back: "互相平分（交點是兩對角線中點）" },
  { id: "f62", unit: "line", front: "三角形兩邊中點連線", back: "平行第三邊、長度是第三邊的一半" },
  { id: "f63", unit: "prob", front: "至少一次的機率", back: "\\(P(\\text{至少一次}) = 1 - P(\\text{一次都沒有})\\)——「至少」先想補集" },
  { id: "f64", unit: "num", front: "\\(\\sqrt{a}\\cdot\\sqrt{b}\\) 與 \\(\\sqrt{a^2 b}\\) 的化簡", back: "\\(\\sqrt{48} = \\sqrt{16\\cdot 3} = 4\\sqrt{3}\\)——先抓最大平方因數" },
  { id: "f65", unit: "exp", front: "\\(2^{10} \\approx ?\\)（常用近似）", back: "\\(2^{10} = 1024 \\approx 10^3\\)；\\(\\log_{10} 2 \\approx 0.3010\\)、\\(\\log_{10} 3 \\approx 0.4771\\)" },
  { id: "f66", unit: "data", front: "中位數/四分位數要先做什麼？", back: "先排序！\\(Q_1\\)、\\(Q_3\\) 分別是前半、後半的中位數；\\(\\text{IQR} = Q_3 - Q_1\\)" },
];

/* 把數值答案的生成題自動變成 4 選 1（手機純按鈕用） */
function optionize(it) {
  if (it.opts) return { q: it.q, opts: it.opts, ans: it.ans, fk: it.fk };
  const s = String(it.ans);
  const alts = new Set();
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac) {
    const p = +frac[1], q = +frac[2];
    for (const [a, b] of [[p + 1, q], [p, q + 1], [p - 1, q], [-p, q], [p + 1, q + 1]]) {
      if (b > 0 && !(a === p && b === q) && !(a === 0)) alts.add(b === 1 ? String(a) : `${a}/${b}`);
    }
  } else if (/^-?\d+$/.test(s)) {
    const v = +s;
    for (const x of [v + 1, v - 1, v + 2, v - 2, -v, v + 10, 2 * v, v - 10]) if (x !== v) alts.add(String(x));
  } else if (/^-?\d+,-?\d+$/.test(s)) {
    const [a, b] = s.split(',').map(Number);
    for (const t of [`${-a},${-b}`, `${a + 1},${b}`, `${a},${b - 1}`, `${a - 1},${b + 1}`]) if (t !== s) alts.add(t);
  } else return null;
  const three = shuffle([...alts]).slice(0, 3);
  if (three.length < 3) return null;
  const opts = shuffle([s, ...three]);
  const ai = opts.indexOf(s);
  return { q: it.q, opts, ans: ai, fk: it.fk }; // 回傳原始字串；phoneQuizNext 會 mDispOpt 一次（別在這裡先包，否則雙重島 \(\(56\)\) KaTeX 排不出）
}
function phoneLog(ok, ms) {
  S.phone = S.phone || { days: {}, hist: [], cards: {} };
  S.phone.days = S.phone.days || {}; S.phone.hist = S.phone.hist || []; S.phone.cards = S.phone.cards || {};
  const t = today();
  const d = (S.phone.days[t] = S.phone.days[t] || { n: 0, ok: 0, ms: 0 });
  d.n++; if (ok) d.ok++; d.ms += ms || 0;
  save();
}
function renderPhone() {
  const t = today();
  const p = S.phone && S.phone.days && S.phone.days[t];
  const hist = (S.phone && S.phone.hist || []).slice(-6);
  app().innerHTML = `
    <h1>📱 手機專區</h1>
    <p class="dim">零碎時間用，按鈕作答、單手可練。</p>
    <div class="grid">
      <div class="card drill-card"><b>⚡ 心算快答</b>
        <p class="dim">12 題連發、4 選 1。</p>
        <button class="btn primary" onclick="startPhoneQuiz()">開始 12 題</button></div>
      <div class="card drill-card"><b>🧠 公式必背卡</b>
        <p class="dim">${FLASH.length + extFlashArr().length} 張，忘過的更常出現。</p>
        <button class="btn primary" onclick="startPhoneFlash('formula')">抽 10 張</button></div>
      <div class="card drill-card"><b>🧑‍🏫 口訣快答</b>
        <p class="dim">看口訣選「它在解什麼」，答完看老師怎麼用。${supa && !syncState.user ? '<b class="warnc">需登入才能載入</b>' : ''}</p>
        ${supa && !syncState.user
          ? '<button class="btn" onclick="nav(\'stats\')">登入後解鎖 →</button>'
          : '<button class="btn primary" onclick="startMnQuiz()">來 10 題</button>'}</div>
    </div>
    ${p ? `<div class="card"><p>📅 今日手機練：<b>${p.n}</b> 題/卡｜答對/記得 <b>${p.ok}</b>（${p.n ? Math.round(100 * p.ok / p.n) : 0}%）</p></div>` : ''}
    ${hist.length ? `<div class="card"><h2>近幾輪</h2><table class="tbl"><tr><th>日期</th><th>模式</th><th>成績</th></tr>
      ${hist.map((h) => `<tr><td>${h.d}</td><td>${h.mode === 'quiz' ? '⚡ 心算' : (h.mode === 'mn' || h.mode === 'mnq') ? '🧑‍🏫 口訣' : '🧠 公式'}</td><td>${h.ok}/${h.n}</td></tr>`).reverse().join('')}</table></div>` : ''}`;
}
let phone = null;
function startPhoneQuiz() {
  if (!syncGate()) return;
  phone = { mode: 'quiz', items: [], i: 0, ok: 0, t0: 0, results: [], tapped: false };
  // 手機＝純心算：排除餘式定理（f(k) 三項相加太重）；mat2 只出 det/面積；frac 壓小分母
  const keys = ['tri', 'logexp', 'quad', 'cnk', 'dot', 'seqd', 'mul', 'root', 'mat2', 'frac'];
  let guard = 0;
  const rseen = new Set();
  while (phone.items.length < 12 && guard++ < 100) {
    const k = pick(keys);
    const o = optionize(genFresh(k, () => (k === 'mat2' ? DRILLS.mat2.gen(2) : k === 'frac' ? DRILLS.frac.gen(1) : DRILLS[k].gen()), rseen));
    if (o) { o.src = DRILLS[k].name; phone.items.push(o); }
  }
  sessionActive = true;
  sessionMode = 'phone';
  phoneQuizNext();
}
function phoneQuizNext() {
  if (!phone) return;
  if (phone.i >= phone.items.length) return phoneQuizDone();
  const it = phone.items[phone.i];
  phone.t0 = Date.now();
  phone.tapped = false;
  app().innerHTML = `
    <div class="session-head"><span>⚡ 心算快答｜第 ${phone.i + 1} / ${phone.items.length} 題</span>
      <span class="shr">${timerOn() ? '<span id="ptimer" class="timer">0.0s</span>' : ''}
      <button class="btn sm xbtn" onclick="exitFlow()">✕</button></span></div>
    <div class="card qcard"><div class="qtext big">${rtTxt(it.q)}</div>
      <div class="pbtns">${it.opts.map((o, i) => `<button class="btn pbtn" onclick="phoneTap(${i})">${mDispOpt(o)}</button>`).join('')}</div>
      <div id="pfb"></div></div>
    ${inkHTML({ phone: true })}
    <p class="dim" style="text-align:center">${it.src}</p>`;
  sessionChrome(true);
  inkStart(`phone-q${phone.i + 1}`, phone.t0);
  if (timerOn()) startTicker(() => { const t = $('#ptimer'); if (t) t.textContent = ((Date.now() - phone.t0) / 1000).toFixed(1) + 's'; });
}
function phoneTap(idx) {
  if (!phone || phone.tapped) return;
  phone.tapped = true;
  stopTicker();
  const it = phone.items[phone.i];
  const ms = Date.now() - phone.t0;
  const ok = idx === it.ans;
  const proc = inkStop(); // 筆記區不批改，但有寫就留數據
  if (proc && proc.n) syncInk(`phone-q${phone.i + 1}`, phone.t0, Object.assign({ mode: 'phone', ok }, proc));
  phone.results.push({ ok, ms, q: it.q, given: it.opts[idx], ans: it.opts[it.ans] }); // 留題目與答案：結算頁要能回顧錯題
  if (ok) phone.ok++;
  factResult(it.fk, ok); // 必背事實：更新間隔複習排程
  phoneLog(ok, ms);
  document.querySelectorAll('.pbtn').forEach((b, i) => {
    b.disabled = true;
    if (i === it.ans) b.classList.add('good');
    else if (i === idx) b.classList.add('badpick');
  });
  const fb = $('#pfb');
  if (ok) {
    fb.innerHTML = `<p class="ok">✔（本題 ${(ms / 1000).toFixed(1)}s）</p>`;
    phone.nextTimer = setTimeout(() => { if (phone && sessionMode === 'phone') { phone.i++; phoneQuizNext(); } }, 450);
  } else {
    fb.innerHTML = `<p class="bad">✘ 正解：<b>${mDispOpt(it.opts[it.ans])}</b></p>
      <div class="actr"><button class="btn primary" onclick="phone.i++;phoneQuizNext()">下一題</button></div>`;
  }
}
function phoneQuizDone() {
  sessionActive = false; sessionMode = null; sessionChrome(false);
  const n = phone.results.length;
  const med = median(phone.results.map((r) => r.ms));
  const prevRounds = S.phone.hist.filter((h) => h.mode === 'quiz');
  const prevQ = prevRounds[prevRounds.length - 1];
  const meds = prevRounds.filter((h) => h.med).map((h) => h.med);
  const bestMed = meds.length ? Math.min(...meds) : null;
  S.phone.hist.push({ d: today(), mode: 'quiz', n, ok: phone.ok, med: Math.round(med) });
  if (S.phone.hist.length > 200) S.phone.hist = S.phone.hist.slice(-200);
  save();
  const acc = n ? Math.round(100 * phone.ok / n) : 0;
  const record = acc === 100 && bestMed != null && med < bestMed;
  const better = prevQ && prevQ.n && (phone.ok / n) > (prevQ.ok / prevQ.n);
  const wrongList = phone.results.filter((r) => !r.ok && r.q);
  app().innerHTML = `<h1>心算快答 — 結果</h1>
    ${goalCrossBanner()}
    <div class="card ${acc === 100 ? 'good' : ''}">
      <p class="big">答對 <b>${phone.ok} / ${n}</b>（${acc}%）｜中位數 <b>${(med / 1000).toFixed(1)}s</b></p>
      ${record ? `<p class="praise">⚡ 心算個人最速：中位數 ${(med / 1000).toFixed(1)}s（原 ${(bestMed / 1000).toFixed(1)}s）</p>` : ''}
      ${better ? `<p class="okc">上輪 ${prevQ.ok}/${prevQ.n} → 這輪 ${phone.ok}/${n} ↑</p>` : ''}
      ${acc === 100 ? '<p class="praise">🎉 全對——這些基本運算正在變成反射！</p>' : acc >= 80 ? '<p class="praise">🎉 手感不錯，錯的那幾題就是還沒自動化的位置。</p>' : ''}
      <div class="actr"><button class="btn" onclick="nav('phone')">回手機專區</button>
      <button class="btn primary" onclick="startPhoneQuiz()">再來 12 題</button></div>
    </div>
    ${wrongList.length ? `<div class="card warn"><h2>✘ 這輪錯的 ${wrongList.length} 題——下車前看一眼</h2>
      <ul>${wrongList.map((r) => `<li>${rtTxt(r.q)}　你答 <span class="badc">${mDispOpt(r.given)}</span>，正解 <b>${mDispOpt(r.ans)}</b></li>`).join('')}</ul></div>` : ''}`;
}
function startPhoneFlash(kind) {
  if (!syncGate()) return;
  const go = (deck) => {
    if (!deck || !deck.length) { alert(mlibEmptyMsg()); return; }
    S.phone = S.phone || { days: {}, hist: [], cards: {} };
    const st = (S.phone.cards = S.phone.cards || {});
    // 權重：忘過的 > 沒看過的 > 記得的，加隨機擾動避免死循環
    const scored = deck.map((c) => {
      const r = st[c.id];
      return { c, w: (r ? r.m * 5 - r.s * 0.5 : 2) + Math.random() * 3 };
    });
    scored.sort((a, b) => b.w - a.w);
    phone = { mode: 'flash', kind, cards: shuffle(scored.slice(0, 10).map((x) => x.c)), i: 0, mem: 0, t0: 0, back: false };
    sessionActive = true;
    sessionMode = 'phone';
    flashShow();
  };
  if (kind === 'formula') { go(FLASH.concat(extFlashArr())); return; } // 匯入的公式卡包一起進 deck（承諾過的）
}
/* ═══ 🧑‍🏫 口訣快答：看口訣選「它在解什麼」——舊版「看概念回想口訣」召回難度太高，反轉成辨識方向才答得出來，
   答完立刻看老師方法全文，把 1662 條資料變成可用的零碎複習 ═══ */
let mnq = null;
async function startMnQuiz() {
  if (!syncGate()) return;
  if (sessionActive) return; // 已有活動在跑，別重入
  const lib = await loadMethodLib();
  if (!lib) { alert(mlibEmptyMsg()); return; }
  if (sessionActive) return; // 讀方法庫這段期間若使用者已開別的活動（心算/公式卡），別蓋掉它
  const pool = [];
  for (const u of Object.keys(lib)) for (const m of lib[u]) {
    if (m.mnemonic && m.mnemonic.length <= 40 && m.concept) pool.push({ u, mn: m.mnemonic, concept: m.concept, method: m.method });
  }
  if (pool.length < 8) { alert('口訣資料不足。'); return; }
  S.phone = S.phone || { days: {}, hist: [], cards: {} };
  const st = (S.phone.cards = S.phone.cards || {});
  const scored = pool.map((c) => { // 答錯過的優先回鍋（沿用卡片記憶桶）
    const key = 'mnq:' + strHash(c.u + '|' + c.mn);
    const r = st[key];
    return { c, key, w: (r ? r.m * 5 - r.s * 0.5 : 2) + Math.random() * 3 };
  });
  scored.sort((a, b) => b.w - a.w);
  const items = shuffle(scored.slice(0, 10)).map(({ c, key }) => {
    let others = [...new Set(pool.filter((x) => x.u === c.u && x.concept !== c.concept).map((x) => x.concept))];
    if (others.length < 3) others = others.concat([...new Set(pool.filter((x) => x.u !== c.u && x.concept !== c.concept).map((x) => x.concept))]);
    const opts = shuffle([c.concept, ...shuffle(others).slice(0, 3)]);
    return { key, u: c.u, mn: c.mn, method: c.method, opts, ans: opts.indexOf(c.concept) };
  });
  mnq = { items, i: 0, ok: 0, t0: 0, tapped: false };
  sessionActive = true;
  sessionMode = 'phone';
  mnqShow();
}
function mnqShow() {
  if (!mnq) return;
  if (mnq.i >= mnq.items.length) return mnqDone();
  const it = mnq.items[mnq.i];
  mnq.t0 = Date.now(); mnq.tapped = false;
  app().innerHTML = `
    <div class="session-head"><span>🧑‍🏫 口訣快答｜第 ${mnq.i + 1} / ${mnq.items.length} 題</span>
      <span class="shr"><button class="btn sm xbtn" onclick="exitFlow()">✕</button></span></div>
    <div class="card qcard"><p class="dim">${TOPICS[it.u] || ''}｜老師的這句口訣，是在解哪種問題？</p>
      <div class="qtext big">🔑 ${mathTxt(it.mn)}</div>
      <div class="ansrow">${it.opts.map((o, i) => `<button class="btn opt block" onclick="mnqTap(${i})">${mathTxt(o)}</button>`).join('')}</div>
      <div id="pfb"></div></div>`;
  sessionChrome(true);
}
function mnqTap(idx) {
  if (!mnq || mnq.tapped) return;
  mnq.tapped = true;
  const it = mnq.items[mnq.i];
  const ok = idx === it.ans;
  const ms = Date.now() - mnq.t0;
  if (ok) mnq.ok++;
  const st = (S.phone.cards[it.key] = S.phone.cards[it.key] || { s: 0, m: 0 });
  st.s++; if (!ok) st.m++;
  phoneLog(ok, ms);
  document.querySelectorAll('.ansrow .btn').forEach((b, i) => {
    b.disabled = true;
    if (i === it.ans) b.classList.add('good');
    else if (i === idx) b.classList.add('badpick');
  });
  $('#pfb').innerHTML = `${ok ? '<p class="ok">✔ 對！</p>' : '<p class="bad">✘ 不是這個。</p>'}
    <div class="teach"><p><b>🧑‍🏫 老師怎麼用：</b>${mathTxt(it.method || '')}</p></div>
    <div class="actr"><button class="btn primary" onclick="mnq.i++;mnqShow()">下一題 →</button></div>`;
}
function mnqDone() {
  sessionActive = false; sessionMode = null; sessionChrome(false);
  const n = mnq.items.length;
  S.phone.hist.push({ d: today(), mode: 'mnq', n, ok: mnq.ok });
  if (S.phone.hist.length > 200) S.phone.hist = S.phone.hist.slice(-200);
  save();
  const okN = mnq.ok;
  mnq = null;
  app().innerHTML = `<h1>口訣快答 — 結果</h1>${goalCrossBanner()}<div class="card ${okN === n ? 'good' : ''}">
    <p class="big">答對 <b>${okN} / ${n}</b></p>
    ${okN === n ? '<p class="praise">🎉 全對——這些口訣跟概念已經接上線了！</p>' : '<p class="dim">答錯的口訣之後會更常抽到。</p>'}
    <div class="actr"><button class="btn" onclick="nav('phone')">回手機專區</button>
    <button class="btn primary" onclick="startMnQuiz()">再來 10 題</button></div></div>`;
}
function flashShow() {
  if (!phone) return;
  if (phone.i >= phone.cards.length) return flashDone();
  const c = phone.cards[phone.i];
  phone.t0 = Date.now();
  phone.back = false;
  app().innerHTML = `
    <div class="session-head"><span>${phone.kind === 'mn' ? '🧑‍🏫 老師口訣卡' : '🧠 公式必背卡'}｜${phone.i + 1} / ${phone.cards.length}</span>
      <span class="shr"><button class="btn sm xbtn" onclick="exitFlow()">✕</button></span></div>
    <div class="card flashcard" onclick="flashFlip()">
      <p class="dim">${TOPICS[c.unit] || ''}</p>
      <div class="flash-front">${rtTxt(c.front)}</div>
      <div id="flash-back" style="display:none">
        <div class="flash-backtxt">${rtTxt(c.back)}</div>
        ${c.extra ? `<p class="dim flash-extra">${rtTxt(c.extra)}</p>` : ''}
      </div>
    </div>
    <div class="flash-btns" id="flash-btns"><button class="btn primary big" onclick="flashFlip()">翻面看答案</button></div>
    <p class="dim" style="text-align:center">先在腦中作答，再翻面對照——想不起來就誠實按「忘了」</p>`;
  sessionChrome(true);
}
function flashFlip() {
  if (!phone || phone.back) return;
  phone.back = true;
  const b = $('#flash-back'); if (b) b.style.display = 'block';
  const bt = $('#flash-btns');
  if (bt) bt.innerHTML = `<button class="btn err big" onclick="flashJudge(false)">❌ 忘了</button>
    <button class="btn primary big" onclick="flashJudge(true)">✅ 背得出來</button>`;
}
function flashJudge(ok) {
  if (!phone || !phone.back) return;
  const c = phone.cards[phone.i];
  const st = (S.phone.cards[c.id] = S.phone.cards[c.id] || { s: 0, m: 0 });
  st.s++; if (!ok) st.m++;
  if (ok) phone.mem++;
  phoneLog(ok, Date.now() - phone.t0);
  phone.i++;
  flashShow();
}
function flashDone() {
  sessionActive = false; sessionMode = null; sessionChrome(false);
  const mode = phone.kind === 'mn' ? 'mn' : 'flash';
  const prevRounds = S.phone.hist.filter((h) => h.mode === mode);
  const prevF = prevRounds[prevRounds.length - 1];
  S.phone.hist.push({ d: today(), mode, n: phone.cards.length, ok: phone.mem });
  if (S.phone.hist.length > 200) S.phone.hist = S.phone.hist.slice(-200);
  save();
  const all = phone.mem === phone.cards.length && phone.cards.length > 0;
  const better = prevF && prevF.n && (phone.mem / phone.cards.length) > (prevF.ok / prevF.n);
  app().innerHTML = `<h1>背誦結果</h1>${goalCrossBanner()}<div class="card ${all ? 'good' : ''}">
    <p class="big">記得 <b>${phone.mem} / ${phone.cards.length}</b></p>
    ${better ? `<p class="okc">上輪 ${prevF.ok}/${prevF.n} → 這輪 ${phone.mem}/${phone.cards.length} ↑</p>` : ''}
    ${all ? '<p class="praise">🎉 這疊全部記得——它們已經在你腦裡站穩了！</p>' : '<p class="dim">忘掉的卡之後會更常抽到，抽到你背熟為止。</p>'}
    <div class="actr"><button class="btn" onclick="nav('phone')">回手機專區</button>
    <button class="btn primary" onclick="startPhoneFlash('${phone.kind === 'mn' ? 'mn' : 'formula'}')">再抽 10 張</button></div></div>`;
}

function renderDrillMenu() {
  // 熟練五階：0 沒練過｜1 練過未達標｜2 曾達標｜3 上次達標｜4 連兩輪達標
  const passOf = (k, h) => h.med / 1000 <= DRILLS[k].target && h.acc === 100;
  const level = (k) => {
    const h = S.drills[k] || [];
    if (!h.length) return 0;
    const last = h[h.length - 1], prev = h[h.length - 2];
    if (passOf(k, last) && prev && passOf(k, prev)) return 4;
    if (passOf(k, last)) return 3;
    if (h.some((x) => passOf(k, x))) return 2;
    return 1;
  };
  const keys = Object.keys(DRILLS);
  const autoN = keys.filter((k) => level(k) >= 3).length;
  keys.sort((a, b) => level(a) - level(b)); // 最需要練的排最前
  const cards = keys.map((k) => {
    const d = DRILLS[k];
    const hist = S.drills[k] || [];
    const last = hist[hist.length - 1];
    const lv = level(k);
    const dots = hist.slice(-6).map((h) => `<i class="${passOf(k, h) ? 'p' : ''}"></i>`).join('');
    const stat = last
      ? `上次：中位數 ${(last.med / 1000).toFixed(1)}s／答對 ${last.acc}%${lv >= 3 ? ' ✅' : ''}`
      : '尚未練過';
    return `<div class="card drill-card m${lv}">
      <b>${d.name}</b><span class="dim"> 目標 ${d.target}s/題</span>
      <p class="dim">${d.desc}</p>
      <p class="dim">${stat}${dots ? ` <span class="mdots">${dots}</span>` : ''}</p>
      <button class="btn primary" onclick="startDrill('${k}')">開始 12 題</button>
    </div>`;
  }).join('');
  app().innerHTML = `
    <h1>⚡ 速度特訓 <span class="okc" style="font-size:14px">已自動化 ${autoN} / ${keys.length}</span></h1>
    <p>目的：把基本運算練到<b>不經思考</b>。每輪 12 題。<b>達標＝中位數 ≤ 目標秒數，且 12 題全對</b>——兩個條件缺一不可，「快但會錯」在考場上比「慢」更貴。<br>
    <span class="dim">卡片頂色＝熟練度（越深越自動化）；最需要練的排最前。點點＝近 6 輪達標紀錄。</span></p>
    <div class="grid">${cards}</div>`;
}

let drill = null;
/* ═══ 必背事實的間隔複習（Anki 式）═══
   sin30°=1/2 這類「重要而唯一」的事實：答錯→立即到期、反覆出現直到會；
   連續答對→間隔翻倍暫時退場（10分→1時→8時→2天→7天→21天）。記憶存 S.facts 跨裝置同步。 */
const FACT_IVL = [10 * 60e3, 60 * 60e3, 8 * 3600e3, 2 * 86400e3, 7 * 86400e3, 21 * 86400e3];
let FACT_RECENT = []; // 最近抽過的事實（防同一輪連抽同一個）
function factPick(cands) {
  const now = Date.now(), F = S.facts || {};
  const tier = (c) => {
    const f = F[c.key];
    if (!f) return 1;            // 沒看過：次優先
    return f.due <= now ? 0 : 2; // 到期/剛答錯：最優先；連對未到期：殿後
  };
  const avail = cands.filter((c) => !FACT_RECENT.includes(c.key));
  const pool = avail.length ? avail : cands;
  let best = null, bs = 9;
  for (const c of pool) {
    const s = tier(c) + Math.random() * 0.9;
    if (s < bs) { bs = s; best = c; }
  }
  FACT_RECENT.push(best.key);
  if (FACT_RECENT.length > 10) FACT_RECENT.shift();
  return best;
}
function factResult(key, ok) {
  if (!key) return;
  S.facts = S.facts || {};
  const f = (S.facts[key] = S.facts[key] || { s: 0, due: 0, last: 0 });
  if (ok) { f.s = Math.min(f.s + 1, FACT_IVL.length); f.due = Date.now() + FACT_IVL[f.s - 1]; }
  else { f.s = 0; f.due = 0; } // 答錯：歸零、立即到期
  f.last = Date.now();
  save();
}
/* 產生器去重：同一輪絕不重題；參數題另外跨輪避重（事實題的跨輪節奏交給間隔複習排程） */
const QSEEN = {};
function genFresh(key, genFn, roundSeen) {
  const ring = (QSEEN[key] = QSEEN[key] || []);
  let g = null;
  for (let t = 0; t < 15; t++) {
    g = genFn();
    const sig = String(g.q).replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    if (roundSeen && roundSeen.has(sig)) continue;
    if (!g.fk && ring.includes(sig)) continue;
    if (roundSeen) roundSeen.add(sig);
    if (!g.fk) { ring.push(sig); if (ring.length > 40) ring.shift(); }
    return g;
  }
  return g; // 題池真的太小躲不掉時才接受重複
}
function startDrill(key) {
  if (!syncGate()) return;
  drill = { key, items: [], i: 0, results: [], t0: 0, pend: null, rseen: new Set() };
  for (let i = 0; i < 12; i++) drill.items.push(genFresh(key, () => DRILLS[key].gen(), drill.rseen));
  sessionActive = true;
  sessionMode = 'drill';
  drillNext();
}
function drillNext() {
  if (!drill || !sessionActive || sessionMode !== 'drill') return;
  if (drill.i >= drill.items.length) return drillDone();
  const d = DRILLS[drill.key];
  const it = drill.items[drill.i];
  drill.pend = null;
  drill.lock = false;
  drill.t0 = Date.now();
  drill.qid = `drill:${drill.key}:${drill.t0}`;
  // 統一計算紙：題目 → 批改槽 → 一張書寫畫布 → 按鈕（速訓不加 :has 收合，自評時要看得到自己寫的字對照正解）
  const controls = it.kind === 'num'
    ? `<div class="ansarea"><div class="actr"><button class="btn primary big" onclick="drillSubmit()">✅ 算完了</button></div>
       <details class="typed-opt"${typedOpen ? ' open' : ''} ontoggle="typedOpen=this.open"><summary class="dim">改用打字（選用）</summary>
       <input id="din" class="ans-input" inputmode="text" autocomplete="off" placeholder="答案" onkeydown="if(event.key==='Enter')drillSubmit()"></details></div>`
    : `<div class="ansarea"><div class="ansrow">${it.opts.map((o, idx) => `<button class="btn opt" onclick="drillSubmit(${idx})">${mDispOpt(o)}</button>`).join('')}</div></div>`;
  app().innerHTML = `
    <div class="session-head">
      <span>${d.name}｜第 ${drill.i + 1} / 12 題</span>
      <span class="shr">${timerOn() ? '<span id="dtimer" class="timer">0.0s</span>' : ''}
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    <div class="card qcard booklet sheet">
      <div class="sheet-tools"><b>✍️ 整張都能寫</b>${inkToolsHTML()}</div>
      <div class="bk-item"><div class="bk-content" style="text-align:center;font-size:22px">${rtTxt(it.q)}</div></div>
      <div class="write-pad" style="min-height:30vh"></div>
      ${controls}
      <div id="dfb"></div>
      <canvas id="ink-cv" class="qink"></canvas>
    </div>`;
  sessionChrome(true);
  inkStart(drill.qid, drill.t0);
  if (timerOn()) startTicker(() => {
    const e = (Date.now() - drill.t0) / 1000;
    const t = $('#dtimer');
    if (t) t.textContent = e.toFixed(1) + 's';
  });
}
function drillSubmit(optIdx) {
  if (!drill || drill.pend || drill.lock) return;
  drill.lock = true;
  const it = drill.items[drill.i];
  const ms = Date.now() - drill.t0;
  stopTicker();
  const proc = inkStop();
  document.querySelectorAll('.ansrow button, .ansrow input').forEach((b) => (b.disabled = true));
  const typed = $('#din') ? $('#din').value.trim() : '';
  const proceed = () => {
    if (it.kind !== 'num') { drillFinish(optIdx === it.ans, it.opts[optIdx], ms, proc); return; }
    if (typed) { drillFinish(checkFill(typed, [it.ans]), typed, ms, proc); return; }
    // 手寫作答：秀正解 → 自評對錯（不需要鍵盤）
    drill.pend = { ms, proc };
    $('#dfb').innerHTML = `<div class="judge-box"><p>正解：<b class="big accent">${mDispOpt(String(it.ans))}</b>　對照你答案區寫的——一樣嗎？</p>
      <div class="actr"><button class="btn err" onclick="drillJudge(false)">✗ 我錯了</button>
      <button class="btn primary" onclick="drillJudge(true)">✓ 我對了</button></div></div>`;
  };
  if (ms >= 360000) {
    modal(`<h2>⏸ 這題用了 ${fmtSec(ms)}</h2><p>是不是有中途離開座位？有的話這題不列入本輪，避免污染速度數據。</p>`, [
      ['有離開，這題不列入', () => { drill.pend = null; drill.lock = false; drill.items[drill.i] = genFresh(drill.key, () => DRILLS[drill.key].gen(), drill.rseen); drillNext(); }],
      ['沒有離開，正常記錄', proceed],
    ]);
  } else proceed();
}
function drillJudge(ok) {
  if (!drill || !drill.pend) return;
  const { ms, proc } = drill.pend;
  drill.pend = null;
  const it = drill.items[drill.i];
  drillFinish(ok, ok ? String(it.ans) : '（手寫，自評錯）', ms, proc);
}
function drillFinish(ok, given, ms, proc) {
  const it = drill.items[drill.i];
  const ansTxt = it.kind === 'num' ? it.ans : it.opts[it.ans];
  if (it.kind === 'num') inkMark(drill.qid, ok, String(it.ans)); // 自評/打字也照樣畫紅筆
  factResult(it.fk, ok); // 必背事實：更新間隔複習排程（非事實題 fk 為空、自動略過）
  drill.results.push({ ok, ms, q: it.q, ans: ansTxt, given });
  syncInk(drill.qid, drill.t0, Object.assign({ mode: 'drill', ok }, proc || {}));
  const fb = $('#dfb');
  if (ok) {
    fb.innerHTML = `<p class="ok">✔ 正確（${(ms / 1000).toFixed(1)}s）</p>`;
    drill.i++;
    drill.nextTimer = setTimeout(drillNext, 500); // endSession 會清掉，避免退出後殭屍題復活
  } else {
    fb.innerHTML = `<p class="bad">✘ 錯了，正確答案：<b>${mDispOpt(String(ansTxt))}</b></p>
      <div class="actr"><button class="btn primary" onclick="drill.i++;drillNext()">下一題</button></div>`;
  }
}
function drillDone() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  if (!drill.results.length) {
    if (pomo) { sessionActive = true; sessionMode = 'prac'; pomoServe(); return; } // 番茄鐘裡的空輪：別停在速訓選單、也別記空輪，直接接下一項（否則番茄鐘卡死）
    nav('drill'); return;
  }
  const d = DRILLS[drill.key];
  const times = drill.results.map((r) => r.ms);
  const med = median(times);
  const acc = Math.round(100 * drill.results.filter((r) => r.ok).length / drill.results.length);
  (S.drills[drill.key] = S.drills[drill.key] || []).push({ d: today(), med, acc, n: drill.results.length }); // n＝本輪題數，給右上角今日計數表加總（舊資料無 n 當 12）
  save();
  if (pomo) { // 番茄鐘裡的速訓：記一輪、標今日、直接接下一項（不看結算畫面）
    pomo.stats.drillRounds++;
    pomoMarkDaily('drill');
    sessionActive = true;
    sessionMode = 'prac';
    pomoServe();
    return;
  }
  const hist = S.drills[drill.key];
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  const speedOK = med / 1000 <= d.target;
  const accOK = acc === 100;
  const pass = speedOK && accOK;
  // 里程碑（全由 S.drills 現算）：首次達標／已自動化 X/12／個人最速（附準度條件，不鼓勵搶快）
  const passOf = (h) => h.med / 1000 <= d.target && h.acc === 100;
  const firstPass = pass && !hist.slice(0, -1).some(passOf);
  const autoN = Object.keys(DRILLS).filter((k) => { const l = (S.drills[k] || []).slice(-1)[0]; return l && l.med / 1000 <= DRILLS[k].target && l.acc === 100; }).length;
  const bestMed = hist.length > 1 ? Math.min(...hist.slice(0, -1).map((h) => h.med)) : null;
  const newRecord = bestMed != null && med < bestMed && (!prev || acc >= prev.acc);
  const totalMs = times.reduce((a, b) => a + b, 0);
  const fastest = Math.min(...times);
  const slowest = Math.max(...times);
  const wrongs = drill.results.filter((r) => !r.ok);
  const slows = drill.results.filter((r) => r.ok && r.ms > med * 2 && r.ms > 3000);
  const slowShare = Math.round(100 * slows.reduce((a, r) => a + r.ms, 0) / totalMs);
  // 診斷：分開判速度與準度，處方對症
  let verdict;
  if (pass) {
    verdict = `✅ <b>達標！</b>速度（${(med / 1000).toFixed(1)}s ≤ ${d.target}s）與準度（100%）雙過——這個動作接近自動化了。明天再過一輪確認穩定，就換下一種特訓。`;
  } else if (!accOK && speedOK) {
    verdict = `⚠️ <b>敗在準度，不是速度。</b>中位數 ${(med / 1000).toFixed(1)}s 遠低於目標 ${d.target}s，但答對率只有 ${acc}%——手比腦快了。
      <b>處方：下一輪刻意放慢兩成、每題送出前多看一眼，先拿 100% 再談快。</b>
      自動化的定義是「快、而且不會錯」——考場上錯一題的代價，比慢三秒大得多。`;
  } else if (accOK && !speedOK) {
    verdict = `⚠️ <b>全對，但還不夠快</b>（${(med / 1000).toFixed(1)}s > 目標 ${d.target}s）——代表這個運算你還在「想」，還沒變成反射。
      <b>處方：明天同一種再來一輪。</b>速度是重複出來的，不是想出來的。`;
  } else {
    verdict = `❌ 速度與準度都未達標。<b>處方：先不追速度——下一輪只求全對。</b>全對之後，速度通常會自己掉下來。`;
  }
  const trend = hist.slice(-6).map((h) => `${(h.med / 1000).toFixed(1)}s/${h.acc}%`).join(' → ');
  const rows = drill.results.map((r, i) => {
    const slow = r.ok && r.ms > med * 2 && r.ms > 3000;
    return `<tr>
      <td>${i + 1}</td><td>${rtTxt(r.q)}</td>
      <td>${r.ok ? '<span class="okc">✔</span>' : `<span class="badc">✘ ${escH(r.given || '（空白）')}</span>`}</td>
      <td><b>${mDispOpt(String(r.ans))}</b></td>
      <td class="${slow ? 'warnc' : ''}" style="font-variant-numeric:tabular-nums">${(r.ms / 1000).toFixed(1)}s${slow ? ' ⚠' : ''}</td></tr>`;
  }).join('');
  app().innerHTML = `
    <h1>${d.name} — 結果</h1>
    ${dailyBanner(1)}
    ${goalCrossBanner()}
    <div class="card ${pass ? 'good' : ''}">
      ${firstPass ? `<p class="praise">🏁 首次達標！12 種基本運算你已自動化 <b>${autoN}</b> 種。</p>` : ''}
      ${!firstPass && newRecord ? `<p class="praise">⚡ 個人新紀錄：中位數 ${(med / 1000).toFixed(1)}s（原 ${(bestMed / 1000).toFixed(1)}s）</p>` : ''}
      <p class="big">中位數 <b>${(med / 1000).toFixed(1)}s</b>／目標 ${d.target}s ｜ 答對 <b class="${accOK ? 'okc' : 'badc'}">${acc}%</b></p>
      <p>達標＝兩個條件同時成立：
        ① 中位數 ≤ ${d.target}s ${speedOK ? '<b class="okc">✓ 已達</b>' : `<b class="badc">✗ 未達（你 ${(med / 1000).toFixed(1)}s）</b>`}
        ② 12 題全對 ${accOK ? '<b class="okc">✓ 已達</b>' : `<b class="badc">✗ 未達（你 ${acc}%，錯 ${wrongs.length} 題）</b>`}</p>
      <p class="dim">全輪 ${(totalMs / 1000).toFixed(0)}s ｜ 最快 ${(fastest / 1000).toFixed(1)}s ｜ 最慢 ${(slowest / 1000).toFixed(1)}s</p>
      <p>${verdict}</p>
      ${prev ? `<p class="dim">上一輪 ${(prev.med / 1000).toFixed(1)}s／${prev.acc}% → 這一輪 ${(med / 1000).toFixed(1)}s／${acc}%
        ${med < prev.med && acc >= prev.acc ? '<span class="okc">（雙向進步 ↑）</span>' : ''}</p>` : ''}
      ${hist.length > 1 ? `<p class="dim">近 ${Math.min(6, hist.length)} 輪走勢：${trend}</p>` : ''}
    </div>
    ${wrongs.length ? `<div class="card warn"><h2>✘ 錯的 ${wrongs.length} 題——花 30 秒看懂它們再走</h2>
      <ul>${wrongs.map((r) => `<li>${rtTxt(r.q)}　你答 <span class="badc">${escH(r.given || '（空白）')}</span>，正解 <b>${mDispOpt(String(r.ans))}</b>（${(r.ms / 1000).toFixed(1)}s${r.ms < med ? '——比你的中位數還快，十之八九是搶快' : ''}）</li>`).join('')}</ul></div>` : ''}
    ${slows.length ? `<div class="card"><h2>⚠ 卡頓題 ${slows.length} 題（吃掉全輪 ${slowShare}% 的時間）</h2>
      <p class="dim">耗時超過自己中位數兩倍的題——這幾種數字組合就是你「還沒自動化」的精確位置，下一輪特別注意它們有沒有變快：</p>
      <ul>${slows.map((r) => `<li>${rtTxt(r.q)}　<b class="warnc">${(r.ms / 1000).toFixed(1)}s</b></li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>逐題明細</h2>
      <div style="overflow-x:auto"><table class="tbl"><tr><th>#</th><th>題目</th><th>作答</th><th>正解</th><th>耗時</th></tr>${rows}</table></div>
      <div class="actr"><button class="btn" onclick="nav('drill')">回特訓選單</button>
      <button class="btn primary" onclick="startDrill('${drill.key}')">再來一輪</button></div>
    </div>`;
}

/* ═══════════ 主題刷題 ═══════════ */
function attemptsOf(qid) { return S.attempts.filter((a) => a.qid === qid); }
/* 單元優先序：沒寫過/樣本太少的最危險（排最前），其次答對率低、速度比高 */
function topicPriority() {
  const by = {};
  for (const a of S.attempts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (by[q.topic] = by[q.topic] || { n: 0, ok: 0, ms: 0, target: 0 });
    t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms || 0; t.target += qTarget(q);
  }
  // 確定性排序（樣本最少優先、同樣本比該單元題量）：同一天啟動兩次自動刷題不會打到完全不同單元
  const bankCnt = {};
  for (const q of BANK) bankCnt[q.topic] = (bankCnt[q.topic] || 0) + 1;
  const unseen = Object.keys(TOPICS).filter((k) => !by[k] || by[k].n < 3)
    .sort((a, b) => (((by[a] || {}).n || 0) - ((by[b] || {}).n || 0)) || ((bankCnt[b] || 0) - (bankCnt[a] || 0)));
  const weak = Object.keys(by).filter((k) => by[k].n >= 3)
    .map((k) => ({ k, acc: by[k].ok / by[k].n, speed: by[k].ms / Math.max(1, by[k].target) }))
    .sort((a, b) => (a.acc - b.acc) || (b.speed - a.speed)).map((x) => x.k);
  return { unseen, weak, by };
}
/* 一輪隊列裡同一題組的小題只取一題（共用題幹連著出會像「一直重複」）；不夠再補回 */
function dedupeStems(list, cnt) {
  const seen = new Set(), out = [];
  for (const q of list) {
    const isGroup = String(q.q).includes('題為題組');
    const k = q.grp || (isGroup ? (q.src || '') + '|' + String(q.q).replace(/<[^>]+>/g, '').slice(0, 24) : q.id); // schema v2 的題組 id 優先，舊字串嗅探當 fallback
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= cnt) return out;
  }
  for (const q of list) {
    if (out.includes(q)) continue;
    out.push(q);
    if (out.length >= cnt) break;
  }
  return out;
}
function renderPracConfig() {
  const pr = topicPriority();
  const rest = Object.keys(TOPICS).filter((k) => !pr.unseen.includes(k) && !pr.weak.includes(k));
  const order = [...pr.unseen, ...pr.weak, ...rest]; // 沒摸過 → 弱 → 穩：弱的永遠先看到
  const ac = attCountMap();
  const chips = order.map((k) => {
    const qs = BANK.filter((q) => q.topic === k);
    const seen = qs.filter((q) => ac.get(q.id)).length;
    const t = pr.by[k];
    const acc = t && t.n >= 2 ? t.ok / t.n : null;
    const badge = acc == null ? '<span class="dim">沒練過</span>' : `<b class="${acc < 0.6 ? 'badc' : acc < 0.8 ? 'warnc' : 'okc'}">${Math.round(acc * 100)}%</b>`;
    return `<label class="chip"><input type="checkbox" value="${k}"> ${TOPICS[k]} ${badge} <span class="dim">${seen}/${qs.length}</span></label>`;
  }).join('');
  app().innerHTML = `
    <h1>🎯 主題刷題</h1>
    <div class="card">
      <h3>單元</h3>
      <div class="actr" style="justify-content:flex-end">
        <button class="btn sm" onclick="pracSel('none')">全不選</button>
        <button class="btn sm" onclick="pracSel('all')">全選</button>
        <button class="btn sm" onclick="pracSel('weak')">🎯 選最近弱項</button>
      </div>
      <p class="dim fs13" id="presel-note"></p>
      <div class="chips" id="topicChips">${chips}</div>
      <h3>難度</h3>
      <div class="chips" id="diffChips">
        <label class="chip"><input type="checkbox" value="1" checked> 易</label>
        <label class="chip"><input type="checkbox" value="2" checked> 中</label>
        <label class="chip"><input type="checkbox" value="3" checked> 難</label>
      </div>
      <h3>題數</h3>
      <div class="chips" id="cntChips">
        ${[5, 15].map((n) => `<label class="chip"><input type="radio" name="cnt" value="${n}"${n === ([5, 15].includes(S.pracCnt) ? S.pracCnt : 15) ? ' checked' : ''}> ${n} 題</label>`).join('')}
      </div>
      ${extBankArr().some((q) => q.src && packIsOff(q.src)) ? `<p class="dim fs13">（外部題庫有 ${extBankArr().filter((q) => q.src && packIsOff(q.src)).length} 題被停用中——到 📊 數據頁可重新啟用）</p>` : ''}
      <div class="actr"><button class="btn primary" onclick="startPrac()">開始（未做過的題優先）</button></div>
    </div>`;
  pracSel('weak', true); // 弱項優先是預設，不是要多按一下的選項
}
/* 單元快速選取：全選／全不選／選最近表現弱的（近14天答對率<80% 或 耗時比>1.2；資料太少退回全期）
   silent＝進場預選模式：沒弱項就全選、不彈 alert */
function pracSel(mode, silent) {
  const boxes = [...document.querySelectorAll('#topicChips input')];
  if (mode === 'all') { boxes.forEach((b) => (b.checked = true)); return; }
  if (mode === 'none') { boxes.forEach((b) => (b.checked = false)); return; }
  const cut = Date.now() - 14 * 86400000;
  let atts = S.attempts.filter((a) => (a.ts || 0) >= cut);
  if (atts.length < 20) atts = S.attempts;
  const by = {};
  for (const a of atts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (by[q.topic] = by[q.topic] || { n: 0, ok: 0, ms: 0, target: 0 });
    t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms || 0; t.target += qTarget(q);
  }
  const weak = new Set(Object.keys(by).filter((k) => {
    const t = by[k];
    return t.n >= 2 && (t.ok / t.n < 0.8 || (t.target > 0 && t.ms / t.target > 1.2));
  }));
  for (const k of Object.keys(TOPICS)) if (!by[k] || by[k].n < 2) weak.add(k); // 沒寫過的更危險
  if (!weak.size) {
    if (silent) { boxes.forEach((b) => (b.checked = true)); return; }
    alert('目前看不出弱項——先全選刷一輪。'); return;
  }
  boxes.forEach((b) => (b.checked = weak.has(b.value)));
  if (silent) {
    const n = $('#presel-note');
    if (n) n.textContent = `已預選你目前最需要的 ${weak.size} 個單元（答對率 <80%、耗時比 >1.2 或沒練過）——可自行增減。`;
  }
}
let prac = null;
function startPrac() {
  if (!syncGate()) return;
  const topics = [...document.querySelectorAll('#topicChips input:checked')].map((i) => i.value);
  const diffs = [...document.querySelectorAll('#diffChips input:checked')].map((i) => +i.value);
  const cnt = +document.querySelector('#cntChips input:checked').value;
  if (cnt !== S.pracCnt) { S.pracCnt = cnt; save(); } // 記住上次選的題數
  let pool = BANK.filter((q) => topics.includes(q.topic) && diffs.includes(q.diff));
  if (!pool.length) { alert('沒有符合條件的題目'); return; }
  // 未做過優先，其次做過次數少的
  pool = shuffle(pool).sort((a, b) => attemptsOf(a.id).length - attemptsOf(b.id).length);
  prac = { queue: dedupeStems(pool, cnt), i: 0, results: [], mode: 'practice' };
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pracNext();
}
function pracNext() {
  if (prac.i >= prac.queue.length) return pracDone();
  renderQuestion(prac.queue[prac.i], {
    head: `第 ${prac.i + 1} / ${prac.queue.length} 題`,
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
  const slowOk = timerOn() ? r.filter((x) => x.ok && x.ms > x.target * 1.5).length : 0;
  const hardWins = all.filter((x, i) => !x.excluded && x.ok && prac.queue[i].diff === 3).length;
  const rows = all.map((x, i) => {
    const q = prac.queue[i];
    if (x.excluded) return `<tr><td>${TOPICS[q.topic]}</td><td colspan="${timerOn() ? 3 : 2}" class="dim">（中途離開，未列入紀錄）</td></tr>`;
    return `<tr><td>${TOPICS[q.topic]}</td><td>${x.ok ? '✔' : '✘'}</td>
      ${timerOn() ? `<td class="${x.ms > x.target ? 'badc' : 'okc'}">${fmtSec(x.ms)} / ${fmtSec(x.target)}</td>` : ''}
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
    ${roundStuck.slice(0, 4).map((s) => `<p style="margin:3px 0">${s.topic ? TOPICS[s.topic] + '：' : ''}${escH(s.what || '')}${s.dur ? `（停 ${s.dur}s）` : ''}${s.fix ? ` <span class="okc">💡 ${escH(s.fix)}</span>` : ''}</p>`).join('')}</div>` : '';
  app().innerHTML = `
    <h1>刷題結果</h1>
    ${dailyBanner(3)}
    ${goalCrossBanner()}
    <div class="card">
      ${prac.picked && prac.picked.length ? `<p class="dim fs13">🔒 本輪鎖定：${prac.picked.map((p) => `${TOPICS[p.k]}（${p.reason}）`).join('、')}</p>` : ''}
      <p class="big">答對 <b>${okN} / ${r.length}</b>${slowOk ? `，其中 <b class="warnc">${slowOk} 題「對但超時」</b>（考場上等於失分，已加入錯題本重練速度）` : ''}</p>
      ${cheer ? `<p class="praise">🎉 ${cheer}</p>` : ''}
      ${progress}
      ${stuckRecap}
      <table class="tbl"><tr><th>單元</th><th>結果</th>${timerOn() ? '<th>耗時/目標</th>' : ''}<th>錯因</th></tr>${rows}</table>
      <div class="actr"><button class="btn" onclick="nav('stats')">看數據</button>
      <button class="btn primary" onclick="nav('prac')">再刷一輪</button></div>
    </div>`;
}

/* ═══════════ 單題渲染（刷題與錯題重測共用） ═══════════ */
/* ═══ 學測題本樣式：段落標頭＋題號外突＋(1)(2) 直排選項，讀寫都像真考卷 ═══ */
function sectionLabel(q) { return q.type === 'single' ? '單選題' : q.type === 'multi' ? '多選題' : '選填／非選題'; }
function bkNum(head) { const m = String(head || '').match(/(\d+)/); return m ? m[1] + '.' : '※'; }
/* 選項印在題目正下方（像考卷），tap 仍作答；submitFn：single→'qSubmit'|'mockAns'（帶索引），multi→送出鈕 */
function bkOpts(q, submitFn) {
  if (q.type === 'single') {
    // 模擬＝正式考：點選項先「劃卡」，再按送出確認（手滑點錯不會直接鎖定）；平時刷題維持點了就走的節奏
    const click = submitFn === 'mockAns' ? (i) => `mockPick(${i},this)` : (i) => `${submitFn}(${i})`;
    return `<div class="bk-opts">${q.opts.map((o, i) =>
      `<div class="bk-opt" onclick="${click(i)}"><span class="bk-check"></span><span class="bk-op">(${i + 1})</span><span>${rtTxt(o)}</span></div>`).join('')}</div>`;
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
function renderQuestion(q, cfg) {
  qsess = { q, cfg, t0: Date.now(), warned: false, locked: false };
  const target = qTarget(q);
  const giveUp = `<button class="btn sm skip" onclick="qGiveUp()">🏳 放棄，看答案</button>`;
  const hintBtn = aiKey() ? `<button class="btn sm" onclick="qHint()">💡 我卡關了</button>` : ''; // AI 看你手寫、給下一步提示（不給完整答案）
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
      <span>${cfg.head}｜${TOPICS[q.topic]}${q.src ? `｜<b class="accent">${q.src}</b>` : ''}｜${stars(q.diff)}${timerOn() ? `｜目標 ${fmtSec(target)}` : ''}</span>
      <span class="shr"><span class="dim" style="font-size:11px">${APP_VER}</span>${timerOn() ? '<span id="qtimer" class="timer">00:00</span>' : ''}
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    ${cfg.review && S.wrong[q.id] && !S.wrong[q.id].grad ? `<p class="dim fs13" style="margin:0 0 4px">📓 上次錯因：${S.wrong[q.id].err || '—'}${S.wrong[q.id].err === '超時' ? `｜⚡ 這次要在 ${fmtSec(target)} 內完成才過關` : ''}</p>` : ''}
    ${timerOn() ? '<div class="timebar"><div id="tbfill" class="timebar-fill"></div></div>' : ''}
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    <div id="qhint"></div><!-- 提示放在書寫卡「外面、上方」：出現時把整張卡連同手寫往下推、不蓋到手寫（卡內任何面板都會蓋到滿版書寫層） -->
    ${cfg.redo ? `<div class="card redo-sol"><p><b>📖 解答攤開著——照它的路，自己再走一遍（寫完照樣批改）：</b></p>${rtTxt(q.sol)}${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}${q.tip ? `<p class="tip">💡 ${rtTxt(q.tip)}</p>` : ''}${teachBlock(q.id)}</div>` : ''}
    ${bkCard(q, cfg.head, 'qSubmit', actions)}`;
  sessionChrome(true);
  inkStart(q.id, qsess.t0);
  if (!timerOn()) return; // 計時器隱藏：不跑碼表、不出時間警示（時間仍在 qSubmit 幕後量測）
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
  const q = qsess.q;
  if (!aiKey()) { qsess.hints = ['（要先到 📊 數據頁設定 AI key 才能用提示）']; renderHints(); return; }
  const b64 = inkCaptureFull(q.id); // 目前手寫的即時快照（null＝還沒動筆）
  qsess.hints = qsess.hints || [];
  qsess.hintBusy = true;
  if (qsess.hintCollapsed) qsess.hintCollapsed = false; // 按了卡關就展開讓他看得到
  renderHints();
  const _he = document.getElementById('qhint'); if (_he && _he.scrollIntoView) try { _he.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} // 提示在卡上方，捲進視野免得沒看到
  try {
    const correctTxt = q.type === 'fill' ? (q.ans && q.ans[0]) : (Array.isArray(q.ans) ? q.ans.map((a) => '(' + (a + 1) + ')').join('') : '');
    const prior = qsess.hints.length ? '\n（你之前已提示過，接著往下、換個角度、別重複）：\n' + qsess.hints.map((h, i) => (i + 1) + '. ' + h).join('\n') : '';
    const system = '你是陪考生即時解題的數學家教。學生正在算這一題、卡住了，傳來他目前的手寫過程。任務：\n'
      + '1) 先看懂他寫到哪、判斷他的方向可不可行。\n'
      + '2) 方向可行→順著他的寫法給「下一步」的關鍵提示；若看到他哪一步算錯，具體點出（引用他寫的式子）。\n'
      + '3) 方向不可行或太繞太花時間→直白說原因，建議一個更好走的方向。\n'
      + '鐵則：只給「剛好夠他自己往下走」的一點提示、循序漸進；**絕對不要**寫出完整解法或最終答案（會毀了練習）。繁體中文、口語、簡短（最多 3 句）。數學式用 \\(…\\) 包起來。';
    const usr = (b64 ? '這是我目前的手寫。' : '我還沒動筆、不知道怎麼下手。') + '我卡住了，給我一點提示（不要直接給我答案）。' + prior;
    const content = [];
    if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
    content.push({ type: 'text', text: '題目：' + stripTags(q.q) + '\n正解（你心裡有數就好、絕不可透露）：' + (correctTxt || '（略）') + (q.sol ? '\n參考詳解（絕不可照抄或劇透，只供你判斷方向對不對）：' + stripTags(q.sol) : '') + '\n\n' + usr });
    const hint = await aiChatCall(system, [{ role: 'user', content }]);
    qsess.hints.push(hint || '（沒有提示）');
  } catch (e) {
    qsess.hints.push('（提示失敗：' + ((e && e.message) || e) + '）');
  } finally {
    qsess.hintBusy = false;
    renderHints();
  }
}
function renderHints() {
  const el = document.getElementById('qhint');
  if (!el || !qsess) return;
  const hints = qsess.hints || [];
  if (!hints.length && !qsess.hintBusy) { el.innerHTML = ''; return; }
  if (qsess.hintCollapsed) { // 收起成小藥丸：露出下面被蓋住的手寫，要看提示再展開
    el.innerHTML = '<div class="hint-box collapsed"><button class="hint-toggle" onclick="qsess.hintCollapsed=false;renderHints()">💡 提示 ' + hints.length + ' 則 ▸ 展開</button></div>';
    return;
  }
  el.innerHTML = '<div class="hint-box"><div class="hint-head"><span>💡 提示（一步一步來，不是完整答案）</span><button class="hint-toggle" onclick="qsess.hintCollapsed=true;renderHints()" title="收起，露出下面的手寫">收起 ▾</button></div>'
    + hints.map((h, i) => '<div class="hint-item"><b>' + (i + 1) + '.</b> ' + rtTxt(h) + '</div>').join('')
    + (qsess.hintBusy ? '<p class="dim">🤖 看你的手寫、想提示中…</p>' : '<div class="actr"><button class="btn sm" onclick="qHint()">再給一點提示</button></div>')
    + '</div>';
  el.querySelectorAll('.hint-item').forEach((n) => { try { renderMathInElement(n, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: true }], throwOnError: false }); } catch (e) {} });
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
  qsess.diag = `診斷 v${APP_VER}：key=${aiKey() ? '有' : '無'}｜筆跡 ${_ns} 筆｜截圖=${calcB64 ? '成功' : '空'}`;
  if (aiKey() && calcB64) {
    $('#qfb').innerHTML = '<p class="dim">🤖 AI 批改中…（認字、對答案、檢查過程哪裡開始錯）</p>';
    const sess = qsess; // 綁定本題：離開或換題後，遲到的回應直接丟棄
    sess.stuckShots = inkStuckShots(q.id, sess.t0); // 停頓證據圖一起送：同一次 API 順帶判讀「當時卡在哪」
    aiGradeCall(q, q.ans.join(' 或 '), (_ord && _ord.b64) || calcB64, sess.stuckShots, _ord ? _ord.steps : 0)
      .then((v) => { if (qsess !== sess) return; qsess.ai = v; qsess.stuck = normStuck(v, sess.stuckShots); const ok = aiCorrect(v); inkMark(q.id, ok, String(q.ans[0])); qResolve(ok); }) // AI 判定直接生效→解答頁（不再多按一次「改對了」；改判連結留在解答頁）
      .catch((e) => { if (qsess !== sess) return; qsess.aiErr = (e && e.message) || String(e); qShowJudge(false); });
  } else {
    if (aiKey() && !calcB64) qsess.noInk = true; // 有 key 卻沒有任何筆跡：要明講，不能靜默
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
    const noKeyHint = !qsess.aiErr && !aiKey() && supa && syncState.user
      ? '<p class="warnc">⚠ 這台裝置還沒拿到 AI key——如果你已在別台填過，重新整理此頁同步後就會自動批改。</p>' : '';
    const noInkHint = qsess.noInk
      ? '<p class="warnc">⚠ AI 沒批改：抓不到手寫筆跡——先寫再按「算完了」。</p>' : '';
    const diag = qsess.diag && (qsess.aiErr || qsess.noInk) ? `<p style="font-size:13px;background:#fff8e1;border:1px solid #f0c14b;padding:6px 9px;border-radius:6px;margin:6px 0">🔎 ${qsess.diag}</p>` : ''; // 只在批改異常時亮診斷，平常自評不出 debug 噪音
    const noAIHint = !qsess.aiErr && !aiKey() ? '<p class="dim">（AI 批改未啟用——先對照正解自評；想要自動批改＋手寫分析，到 📊 數據頁設定 key）</p>' : '';
    $('#qfb').innerHTML = `${qsess.aiErr ? `<p class="warnc">⚠ AI 批改失敗：${escH(qsess.aiErr)}——先自評，key 問題到「📊 數據」頁按「測試連線」檢查。</p>` : noInkHint || noKeyHint}${diag}${peek}${noAIHint}
      <p><b>答對了嗎？</b><span class="dim">（等價形式都算對）</span></p>
      <div class="actr"><button class="btn err" onclick="qResolve(false)">✗ 我錯了</button>
      <button class="btn primary" onclick="qResolve(true)">✓ 我對了</button></div>`;
  }
}
// 像老師改考卷：把 AI 回傳的錯誤座標框（0~1）畫成紅圈＋短標，疊在你送去批改的那張手寫圖上
function markedImgHTML(src, marks, caption, w) {
  const dots = (marks || []).slice(0, 3).map((mk) => {
    const raw = mk && mk.box;
    const b = Array.isArray(raw) ? raw.map(Number) : []; // 只接受陣列座標；字串/物件/數字等一律視為無效（不可直接 .map，否則會 throw）
    let [x0, y0, x1, y1] = b;
    if (b.length !== 4 || ![x0, y0, x1, y1].every((n) => n >= 0 && n <= 1) || !(x1 > x0) || !(y1 > y0)) return ''; // 座標非法就跳過這個框
    const pad = 0.028; // 框大一點、比較像老師隨手一圈（也符合「框可以大」）
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
    const L = (x0 * 100).toFixed(1), T = (y0 * 100).toFixed(1), W = ((x1 - x0) * 100).toFixed(1), H = ((y1 - y0) * 100).toFixed(1);
    let lab = '';
    if (mk.label) { // 靠上緣的標籤改放圈內、靠右緣的改靠右對齊，避免被卡片裁掉
      const nearTop = y0 < 0.10, nearRight = x1 > 0.62;
      const lx = nearRight ? `right:${((1 - x1) * 100).toFixed(1)}%` : `left:${L}%`;
      lab = `<span class="am-lab${nearTop ? ' below' : ''}" style="${lx};top:${T}%">${escH(String(mk.label).slice(0, 12))}</span>`;
    }
    return `<span class="am-circle" style="left:${L}%;top:${T}%;width:${W}%;height:${H}%"></span>${lab}`;
  }).join('');
  if (!dots) return ''; // 沒有任何有效框：交給呼叫端退回純文字
  return `<div class="ai-marked"><div class="am-wrap" style="width:${w || 480}px"><img src="${src}" alt="你的手寫（AI 已標記）">${dots}</div>${caption ? `<p class="am-cap">🖍 ${escH(caption)}</p>` : ''}</div>`;
}
function fbInView() { // 批改完把回饋區捲到頂：最上面就是判定＋「下一題」，不用往下拉
  const fb = $('#qfb');
  if (fb && fb.scrollIntoView) { try { fb.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { fb.scrollIntoView(); } }
}
function qResolve(ok) {
  const { q } = qsess;
  const ms = qsess.ms;
  const target = qTarget(q);
  const overtime = timerOn() && ok && ms > target * 1.5;
  const correctTxt = q.type === 'fill' ? q.ans[0] : q.ans.map((a) => `(${a + 1})`).join('');
  // 筆跡一律上傳（珍貴分析資料）；改判會重跑 qResolve，用旗標避免重複上傳
  if (!qsess.inkSynced) {
    syncInk(q.id, qsess.t0, Object.assign(
      { mode: qsess.cfg.side ? 'side' : (qsess.cfg.review ? 'review' : 'practice'), ok, excluded: !!qsess.exclude, ai: qsess.ai || null }, qsess.proc || {}));
    qsess.inkSynced = true;
  }
  // 🎯 類題支線：只記到獨立桶（S.sidePractice），絕不進 attempts／錯題本／每日點數／本輪成績
  if (qsess.cfg.side) {
    if (!qsess.sideRecord) { // 首次：新增一筆
      qsess.sideRecord = { qid: q.id, origId: qsess.cfg.origId || null, ok, ms, ts: Date.now(), d: today() };
      if (qsess.cfg.redo) qsess.sideRecord.redo = 1; // 訂正重算：看著解答寫的，別跟自力類題混在一起解讀
      (S.sidePractice = S.sidePractice || []).push(qsess.sideRecord);
    } else { qsess.sideRecord.ok = ok; qsess.sideRecord.ms = ms; } // 改判：更新同一筆（陣列裡是同一個物件參照），不新增
    save();
  }
  const fb = $('#qfb');
  const v = qsess.ai; // AI 批改結果（只有手寫填充題有）：{read,correct,firstError,praise,nextTime,marks,stuck}
  const timeStr = timerOn() ? `｜耗時 ${fmtSec(ms)}（目標 ${fmtSec(target)}）` : '';
  const solTxt = q.type === 'fill' ? mDispOpt(String(correctTxt)) : correctTxt;
  // 複習模式：晉級/畢業「預告」（與 qFinish 的 reviewResult 同一套規則，先算先講——過關要有過關的感覺）
  const w = qsess.cfg.review ? S.wrong[q.id] : null;
  let reviewLine = '';
  if (w && !w.grad) {
    const needFast = w.err === '超時';
    const fastOk = !needFast || ms <= target;
    if (ok && fastOk) {
      const next = { 1: 3, 3: 7, 7: 14 }[w.itv] || 0;
      reviewLine = next === 0
        ? '<p class="praise">🎓 這題畢業——1→3→7→14 天四關全過，從錯題本除名（戰績保留）！</p>'
        : `<p class="okc">⬆ 過關晉級：下次 ${next} 天後再驗。</p>`;
    } else if (ok && !fastOk) {
      reviewLine = `<p class="warnc">⚡ 答對了，但這題當初是因「超時」進來的——${fmtSec(ms)} 還沒進目標 ${fmtSec(target)}。明天再驗一次速度（不算答錯，但間隔回到第 1 關）。</p>`;
    } else {
      reviewLine = '<p class="badc">↩ 打回第 1 關，明天再來。</p>';
    }
  }
  // 複習模式的跨次對照：上次的卡點/建議 vs 這次（需求5：同一步跌倒兩次＝你的洞）
  let lastAdv = '';
  if (w && w.adv) {
    if (ok && w.adv.nt) lastAdv = `<p class="praise">🎯 上次的建議「${escH(w.adv.nt)}」——這次你做到了。</p>`;
    else if (!ok) {
      const parts = [];
      if (w.adv.fe) parts.push(`上次卡在：${escH(w.adv.fe)}`);
      if (v && v.firstError) parts.push(`這次卡在：${escH(v.firstError)}`);
      if (parts.length === 2) parts.push('<b>對照一下——若是同一步，那就是你的洞：先到下面「老師方法」補這個概念再測。</b>');
      else if (w.adv.nt) parts.push(`上次的建議：${escH(w.adv.nt)}`);
      lastAdv = parts.length ? `<p class="badc">${parts.join('<br>')}</p>` : '';
    }
  }
  // ① 判定列——永遠最上面
  const verdict = (ok
    ? `<p>${overtime ? '<span class="ok">✔ 答對，但太慢</span>' : '<span class="ok">✔ 答對</span>'}｜正解：<b>${solTxt}</b>${timeStr}</p>${overtime ? '<p class="warnc"><b>⚠ 超過目標 1.5 倍——考場上這題等於沒拿到</b></p>' : ''}`
    : `<p><span class="bad">✘ 答錯</span>（你的：${escH(qsess.yourAns)}）｜正解：<b>${solTxt}</b>${timeStr}</p>`) + reviewLine;
  // ② AI 讀到什麼＋改判（只有 AI 批改過才有；壓成一行，兼顧信任與翻案）
  const reJudge = v
    ? `<p class="rejudge">🤖 AI 讀到「<b>${v.read != null ? escH(v.read) : '—'}</b>」→ 判${ok ? '對' : '錯'}　<a onclick="qResolve(${!ok})">判錯了？改判</a></p>`
    : '';
  // ③ 主要動作——緊接判定，一按就走，不用往下拉；類題支線用不同按鈕（不進主流程）
  const action = qsess.cfg.side
    ? (qsess.cfg.redo
      ? `<div class="actr"><button class="btn" onclick="qRedoAgain()">📝 再算一次</button><button class="btn" onclick="sideReturn()">↩ 回到原題</button><button class="btn primary big" onclick="qRedoDone()">下一題 →</button></div>`
      : `<div class="actr"><button class="btn primary big" onclick="sideNext()">🎯 再來一題類題</button><button class="btn" onclick="sideReturn()">↩ 回到原題</button></div>`)
    : (!ok
      ? `<p class="dim" style="margin:8px 0 4px">標個錯因幫錯題本分類（選填，不選也能直接下一題）：</p><div class="chips r">${ERR_TYPES.slice(0, 4).map((e) => `<button class="chip${qsess.errPick === e ? ' sel' : ''}" onclick="qPickErr(this,'${e}')">${e}</button>`).join('')}</div><div class="actr" style="margin-top:8px"><button class="btn" onclick="qRedoStart()">📝 看解答重算一次</button><button class="btn" onclick="qSideStart()">🎯 先練一題類題</button><button class="btn primary big" id="errnext" onclick="qFinish(false, ${ms}, qsess.errPick)">下一題 →</button></div>`
      : `<div class="actr"><button class="btn primary big" onclick="qFinish(true, ${ms}, ${overtime ? "'超時'" : 'null'})">下一題 →</button><button class="btn" onclick="qSideStart()">🎯 再練一題類題</button></div>`);
  // ④ 中段（批改的靈魂）：先肯定你做得好的 → 錯在哪（圈在你字上）→ 🧠 卡在哪 → 🎯 下次這樣做。詳解不塞這、收摺疊。
  const willProc = aiKey() && !v && qsess.proc && qsess.proc.n; // 選擇/打字題稍後由 AI 過程點評接手稱讚＋下次，這裡就不重複
  // 史實類稱讚（曾錯今對/破個人最速）AI 看不到，永遠保留；AI 在場時當下類交給 AI 講
  const praiseHTML = (v && v.praise ? `<p class="praise">🎉 你做得好：${escH(v.praise)}</p>` : '') + praiseFor(q, ok, ms, target, !!(v || willProc));
  const nextTxt = v && v.nextTime ? escH(v.nextTime) : (!willProc && q.tip ? rtTxt(q.tip) : '');
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
    const errLine = v && v.firstError ? `<p class="badc" style="margin:8px 0 4px"><b>你這裡跑掉了：</b>${escH(v.firstError)}</p>` : ''; // 畫布上的紅框圈「哪裡」，這行講「錯什麼」
    const method = !v ? `<div class="one-method"><b>一種最簡單的算法：</b>${rtTxt(q.sol)}${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}</div>` : ''; // 沒 AI 看手寫時才補完整方法；詳解配圖（solFig）不過 rtTxt
    mid = `${praiseHTML}${handImg}${errLine}${lastAdv}${stuckBlock}${method}${nextHTML}`;
  } else if (overtime) {
    mid = `${praiseHTML}${lastAdv}${handImg}${stuckBlock}${nextHTML || (willProc ? '' : '<p class="dim">多做幾次讓步驟變反射就會更快。</p>')}`;
  } else {
    mid = `${praiseHTML}${lastAdv}${handImg}${stuckBlock}${nextHTML}`;
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
  if (aiKey() && !qsess.ai && qsess.proc && qsess.proc.n) {
    const el = document.getElementById('ai-proc');
    if (el) { el.innerHTML = '<p class="dim">🤖 AI 正在看你的手寫過程…（不用等，可先按下一題）</p>'; qProcReview(ok); }
  }
  // 批改後：把 AI 紅框畫在你原字上、恢復書寫層可繼續加寫（填充題現在就有 marks；選擇題稍後 qProcReview 補）。等版面(含 KaTeX)定下來再抓畫布高度。
  if (qsess.proc && qsess.proc.n && qsess.calcImg) {
    const _qid = q.id;
    setTimeout(() => { if (qsess && qsess.q && qsess.q.id === _qid) resumeWithMarks(_qid, (qsess.ai && qsess.ai.marks) || null, qsess.markBox); }, 50);
  }
  mountChat(qsess); // 「追問這題」多輪對話區（有 context 記憶）
}
/* 標錯因＝選取，不跳題（詳解/卡點還要看）；「下一題」才前進 */
function qPickErr(btn, e) {
  if (!qsess) return;
  qsess.errPick = e;
  if (btn && btn.parentElement) btn.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('sel', c === btn));
  const nx = $('#errnext'); if (nx) { nx.disabled = false; nx.textContent = '下一題 →'; }
}
let qFinLock = false; // 重入鎖：擋掉「連點兩下下一題／錯因鈕」——第一下已把 qsess 換到下一題，第二下（脫離 DOM 的舊按鈕仍會觸發）會誤記下一題並跳過它
function qFinish(ok, ms, err) {
  if (qFinLock) return; // 同一個同步 tick 內只認第一下
  qFinLock = true; Promise.resolve().then(() => { qFinLock = false; }); // 微任務後解鎖，不影響之後正常的點擊
  const { q, cfg } = qsess;
  let grad = null;
  if (!qsess.exclude) {
    if (qsess.stuck && qsess.stuck.length && qsess.proc) qsess.proc.stuck = qsess.stuck; // 卡點分析跟著 attempt 入庫
    let rec = null;
    if (cfg.review) {
      const w0 = S.wrong[q.id];
      const needFast = !!(w0 && w0.err === '超時'); // 入本原因是速度：答對還要夠快才算過關
      const fastOk = !needFast || ms <= qTarget(q);
      rec = recordAttempt(q, ok, ms, err, 'review', qsess.proc, qsess.ai, { skipWrong: true }); // 複習也是練習量：計入 streak/每日點數/單元統計
      grad = reviewResult(q.id, ok && fastOk, err, ok && !fastOk);
    } else {
      rec = recordAttempt(q, ok, ms, err, prac ? prac.mode : 'practice', qsess.proc, qsess.ai);
    }
    qsess.rec = rec; // 給遲到的 AI 過程點評精準補寫用（不再掃 attempts 猜哪筆是本場）
    const advP = qsess.advPending; // 非同步過程點評的建議若已先到，這裡補進本場紀錄與錯題卡
    if (advP) {
      let dirty = false;
      if (rec && !rec.ai) { rec.ai = advP; dirty = true; }
      if (S.wrong[q.id] && !S.wrong[q.id].grad) { S.wrong[q.id].adv = advP; S.wrong[q.id].mt = Date.now(); dirty = true; }
      if (dirty) save();
    }
    // 錯題手寫存檔：答錯且有手寫 → 把手寫圖留到 IndexedDB（日後統整「怎麼錯的」趨勢）；錯法(k)/首錯(fe) 主要靠 S.attempts 那筆走，這裡順手帶當下有的
    if (!ok && rec && qsess.calcImg) errShotSave(rec.qid + '|' + rec.ts, { img: qsess.calcImg, qid: rec.qid, ts: rec.ts, d: rec.d, topic: q.topic, diff: q.diff, tag: err || null, fe: (rec.ai && rec.ai.fe) || null, k: (rec.ai && rec.ai.k) || null });
  }
  cfg.onDone({ ok, ms, err, target: qTarget(q), excluded: !!qsess.exclude, grad });
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
  sideState = { html: app().innerHTML, sess: qsess, origQ: qsess.q, doneIds: [qsess.q.id], redo: true };
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
    ...(prac && prac.queue ? prac.queue.map((x) => x.id) : []),
    ...(review && review.ids ? review.ids : [])];
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
  app().innerHTML = sideState.html; // 還原原題解答畫面（靜態，按鈕 onclick 用回全域 qsess）
  qsess = sideState.sess;
  sideState = null;
  const el = document.getElementById('ai-proc'); // 支線期間原題的 AI 過程點評若才回來，重新貼上（否則會卡在「正在看…」）
  if (el && qsess.aiProcHTML) el.innerHTML = qsess.aiProcHTML;
  mountChat(qsess); // 還原「追問這題」對話（回原題後接著問）
}
/* 訂正重算中直接「下一題」：還原原題 session（原答案是錯的）→ 記原筆＋前進，不用先繞回原題再選錯因 */
function qRedoDone() {
  if (!sideState) return;
  const s = sideState.sess;
  sideReturn(); // qsess 回到原題
  qFinish(false, (s && s.ms) || 0, s && s.errPick); // 原題答錯：記錄＋前進下一題
}

/* ═══════════ 模擬實戰 ═══════════ */
function renderMockIntro() {
  const n = S.mocks.length;
  app().innerHTML = `
    <h1>⏱️ 模擬實戰</h1>
    <div class="card">
      <p><b>12 題、36 分鐘</b>｜兩輪作答：20 秒內沒路就跳，第二輪回頭；途中不顯示對錯。</p>
      <p class="dim">已完成 ${n} 次模擬。</p>
      <div class="actr"><button class="btn primary big" onclick="startMock()">開始模擬（36:00 倒數）</button></div>
    </div>`;
}
let mock = null;
function buildPaper() {
  // 學測數A結構＝單選＋多選＋選填三段。講義 8 成是填充，純難度抽會抽出一整卷填充——
  // 這裡先按「題型配額」抽（盡量 3 單選＋2 多選＋7 選填），配額不足才用別型補滿 12 題，
  // 每型內部仍求難度分散、不同單元、題組不拆。
  const usedGrp = new Set(), used = new Set(), picked = new Set();
  const take = (q) => { picked.add(q); used.add(q.topic); if (q.grp) usedGrp.add(q.grp); };
  const avail = (q) => !picked.has(q) && !(q.grp && usedGrp.has(q.grp));
  // 從 pool 依「難度配額」挑 n 題：同單元後挑、難度分散（近似整卷 易5中5難2）。
  const pickN = (pool, n, diffQuota) => {
    const buckets = { 1: [], 2: [], 3: [] };
    for (const q of shuffle(pool)) if (avail(q)) buckets[q.diff].push(q);
    const grab = (d) => {
      const b = buckets[d]; if (!b || !b.length) return false;
      let i = b.findIndex((q) => avail(q) && !used.has(q.topic)); // 先挑沒出現過的單元
      if (i < 0) i = b.findIndex((q) => avail(q));
      if (i < 0) return false;
      take(b[i]); return true;
    };
    let got = 0;
    for (const d of [1, 2, 3]) { let q = diffQuota[d] || 0; while (q-- > 0 && got < n && grab(d)) got++; }
    // 難度配額湊不滿（某難度題不夠）→ 任何難度補滿本型
    for (const d of [2, 1, 3]) while (got < n && grab(d)) got++;
    return got;
  };
  // 每型分配難度：single3=易1中1難1、multi2=易1中1、fill7=易3中3難1 → 合計 易5中5難2
  pickN(BANK.filter((q) => q.type === 'single'), 3, { 1: 1, 2: 1, 3: 1 });
  pickN(BANK.filter((q) => q.type === 'multi'), 2, { 1: 1, 2: 1, 3: 0 });
  pickN(BANK.filter((q) => q.type === 'fill'), 7, { 1: 3, 2: 3, 3: 1 });
  if (picked.size < 12) pickN(BANK.slice(), 12 - picked.size, { 1: 4, 2: 4, 3: 4 }); // 某型不夠就用任何型補滿
  return shuffle([...picked].slice(0, 12));
}
function startMock() {
  if (!syncGate()) return;
  const paper = buildPaper();
  mock = {
    paper, orig: paper.slice(), i: 0, round: 1, skipped: [],
    answers: {}, times: {}, proc: {}, exclude: {}, judge: {},
    tEnd: Date.now() + 36 * 60 * 1000, t0: 0, qwarned: false, sessT0: Date.now(),
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
      app().innerHTML = `<div class="card good"><h2>第一輪完成 ✔</h2>
        <p>剩餘 <b>${fmtClock(mock.tEnd - Date.now())}</b>，回頭處理 ${mock.paper.length} 題跳過的題。<br>
        還是沒路線的題，直接放棄它——保住檢查時間。</p>
        <div class="actr"><button class="btn primary" onclick="mockQ()">進入第二輪</button></div></div>`;
      return;
    }
    return mockGrade('全部作答完成');
  }
  mockQ();
}
function mockQ() {
  const q = mock.paper[mock.i];
  const cap = qTarget(q);
  mock.t0 = Date.now();
  (mock.qSeen = mock.qSeen || {});
  (mock.qSeen[q.id] = mock.qSeen[q.id] || []).push(mock.t0); // 每輪進場時間：卡點分析只看最後一輪，跨輪空檔不算停頓
  mock.qwarned = false;
  mock.qlock = false;
  mock.sel = null; // 單選劃卡狀態逐題歸零
  const mockRow = `<div class="mock-actions">
      ${mock.round === 1 ? `<button class="btn skip" onclick="mockSkip()">跳過 → 第二輪</button>` : `<button class="btn skip" onclick="mockGiveup()">放棄此題</button>`}
      <span id="mqtimer" class="dim"></span></div>`;
  let actions;
  if (q.type === 'single') {
    actions = `<div class="actr"><button class="btn primary" id="mock-submit" disabled onclick="mockAns(mock.sel)">送出此題</button></div>${mockRow}`; // 點選項＝劃卡，送出才鎖定
  } else if (q.type === 'multi') {
    actions = `<div class="actr"><button class="btn primary" onclick="mockAns()">送出此題</button></div>${mockRow}`;
  } else {
    actions = `<div class="actr"><button class="btn primary big" onclick="mockAns()">✅ 算完了，送出此題</button></div>
      <details class="typed-opt"${typedOpen ? ' open' : ''} ontoggle="typedOpen=this.open"><summary class="dim">改用打字（選用）</summary>
      <input id="qin" class="ans-input" autocomplete="off" placeholder="答案（分數用 a/b）" onkeydown="if(event.key==='Enter')mockAns()"></details>${mockRow}`;
  }
  app().innerHTML = `
    <div class="session-head">
      <span>第${mock.round === 1 ? '一' : '二'}輪｜第 ${mock.i + 1} / ${mock.paper.length} 題｜建議 ≤ ${fmtSec(cap)}</span>
      <span class="shr"><span id="mclock" class="timer">${fmtClock(mock.tEnd - Date.now())}</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    ${bkCard(q, '第 ' + (mock.i + 1) + ' 題', 'mockAns', actions)}`;
  sessionChrome(true);
  inkStart(q.id, mock.t0, mock.sessT0); // 第二輪回頭時保留第一輪筆跡；更早的舊筆跡歸檔
  startTicker(() => {
    const left = mock.tEnd - Date.now();
    if (left <= 0) { mockGrade('時間到！'); return; }
    const c = $('#mclock'); if (c) c.textContent = fmtClock(left);
    const e = Date.now() - mock.t0;
    const t = $('#mqtimer');
    if (t) t.textContent = `本題 ${fmtSec(e)}`;
    if (!mock.qwarned && e >= cap) {
      mock.qwarned = true;
      flashOnce('⏰ 這題理想中該答完了——考場上此刻就該收尾或跳題');
    }
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
  let ans;
  if (q.type === 'single') ans = { type: 'single', v: optIdx };
  else if (q.type === 'multi') ans = { type: 'multi', v: [...document.querySelectorAll('.bk-opts input:checked')].map((i) => +i.value) };
  else {
    const typed = $('#qin') ? $('#qin').value.trim() : '';
    ans = typed ? { type: 'fill', v: typed } : { type: 'inkfill' };
  }
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
        <p class="dim">${TOPICS[q.topic]}｜正解：<b class="big">${q.type === 'fill' ? mDispOpt(String(q.ans[0])) : q.ans.map((a) => `(${a + 1})`).join('')}</b></p>
        <div id="jai-${i}"></div>
        <div class="actr"><button class="btn sm err" id="jbad-${i}" onclick="mockJudgeSet(${i}, false)">✗ 錯</button>
        <button class="btn sm okb" id="jok-${i}" onclick="mockJudgeSet(${i}, true)">✓ 對</button></div>
      </div>
    </div>`;
  }).join('');
  app().innerHTML = `
    <h1>📝 批改手寫題（${list.length} 題）</h1>
    <div class="card">
      <p>跟考場一樣：寫完才對答案。逐題對照你的手寫答案與正解（等價形式、順序不同都算對），按 ✓ 或 ✗。
      ${aiKey() ? '' : '<span class="dim">（到「📊 數據」頁設定 AI key 後，這一步會由 AI 自動先批＋標出過程錯在哪）</span>'}</p>
      ${items}
      <p id="jmsg" class="dim"></p>
      <div class="actr"><button class="btn primary big" onclick="mockJudgeDone()">完成批改，看結果</button></div>
    </div>`;
  if (aiKey()) mockAIJudge();
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
      if (box) box.innerHTML = aiFeedbackHTML(v) + stuckHTML(stuck);
      if (m.judge[q.id] === undefined) mockJudgeSet(i, aiCorrect(v));
    } catch (e) {
      const box = $('#jai-' + i);
      if (box) box.innerHTML = `<p class="warnc">⚠ AI 批改失敗：${escH((e && e.message) || e)}——請人工批這題。</p>`;
    }
  }
  if (mock === m && msgEl && msgEl.isConnected) msgEl.textContent = 'AI 批改完成——每題確認 ✓/✗（可改判），再看結果。';
}
function mockJudgeDone() {
  const missing = mock.toJudge.filter((q) => mock.judge[q.id] === undefined);
  if (missing.length) { const m = $('#jmsg'); if (m) m.textContent = `還有 ${missing.length} 題沒批——每題要按 ✓ 或 ✗。`; return; }
  mockFinal();
}
function mockFinal() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  const paper = mock.graded;
  let okN = 0;
  const detail = paper.map((q) => {
    const a = mock.answers[q.id];
    const ms = mock.times[q.id] || 0;
    const target = qTarget(q);
    let ok = false, yourAns = '（未作答）';
    if (a) {
      if (a.type === 'single') { ok = a.v === q.ans[0]; yourAns = `(${a.v + 1})`; }
      else if (a.type === 'multi') { ok = a.v.length === q.ans.length && q.ans.every((x) => a.v.includes(x)); yourAns = a.v.length ? a.v.map((c) => `(${c + 1})`).join('') : '（未選）'; }
      else if (a.type === 'inkfill') { ok = !!mock.judge[q.id]; yourAns = '（手寫）'; }
      else { ok = checkFill(a.v, q.ans); yourAns = a.v || '（空白）'; }
    }
    if (ok) okN++;
    // 只記使用者「實際作答過」的題：沒作答/沒看到的（時間到剩下一堆）仍列入成績與結果表，但不可灌進 attempts／錯題本（否則沒看過的題被排進明天複習）
    if (a) recordAttempt(q, ok, ms, ok ? (ms > target * 1.5 ? '超時' : null) : '概念不熟', 'mock', mock.proc[q.id] || null, mock.aiv && mock.aiv[q.id]);
    return { q, ok, ms, target, yourAns, answered: !!a };
  });
  const acc = paper.length ? okN / paper.length : 0;
  const overStuck = detail.filter((d) => !d.ok && d.answered && d.ms > d.target * 1.5);
  const slowOk = detail.filter((d) => d.ok && d.ms > d.target * 1.5);
  const unused = mock.tEnd - Date.now();
  const wrongAdded = detail.filter((d) => d.answered && (!d.ok || d.ms > d.target * 1.5)).length; // 有沒有題真的進了錯題本（頁尾那行別在全對時嚇人）
  const unansweredIds = detail.filter((d) => !d.answered).map((d) => d.q.id);
  // 跟上一場比 + 級分跨檔 + 新高（有依據才講；退步只陳列數字不評論）
  let mockTrend = '';
  if (!mock.partial && S.mocks.length >= 1) {
    const prev = S.mocks[S.mocks.length - 1];
    const bestBefore = Math.max(...S.mocks.map((m2) => m2.acc));
    mockTrend = `<p class="dim">上次 ${prev.ok}/${prev.n}（${Math.round(prev.acc * 100)}%）→ 這次 ${okN}/${paper.length}（${Math.round(acc * 100)}%）</p>`;
    if (acc > prev.acc && gradeOf(acc) !== gradeOf(prev.acc)) mockTrend += `<p class="praise">🎉 體感級分推進：${gradeOf(prev.acc)} → ${gradeOf(acc)}</p>`;
    if (acc > bestBefore) mockTrend += '<p class="praise">🏆 系統模擬新高！</p>';
  }
  if (!mock.partial) S.mocks.push({ d: today(), ok: okN, n: paper.length, acc, ts: Date.now() }); // ts 讓 mergeState 的 JSON.stringify 去重不會把同日同分的兩場模考塌成一筆（靜默丟一場）
  save();
  // 逐題鼓勵：只講有真實依據的（曾錯今對、難題拿下、目標內完成）
  const cheers = detail.filter((d) => d.ok).map((d) => {
    const past = S.attempts.filter((x) => x.qid === d.q.id).slice(0, -1);
    const bits = [];
    if (past.some((x) => !x.ok)) bits.push('之前錯過、這次拿下');
    if (d.q.diff === 3) bits.push('★★★難題成功解出');
    if (d.ms && d.ms <= d.target) bits.push('目標時間內完成');
    return bits.length ? `<li>${TOPICS[d.q.topic]}：${bits.join('、')} 🎉</li>` : '';
  }).filter(Boolean).join('');
  const aiNotes = mock.aiv ? paper.map((q) => {
    const v = mock.aiv[q.id];
    if (!v || (!v.firstError && !v.nextTime)) return '';
    return `<li>${TOPICS[q.topic]}：${v.firstError ? `<b>從這裡開始錯</b>——${escH(v.firstError)}` : ''}${v.nextTime ? `${v.firstError ? '<br>' : ''}🎯 下次：${escH(v.nextTime)}` : ''}</li>`;
  }).filter(Boolean).join('') : '';
  const rows = detail.map((x) => `
    <tr><td>${TOPICS[x.q.topic]} ${starF(x.q.diff)}</td>
    <td>${x.ok ? '✔' : x.answered ? '✘' : '⊘'}</td>
    <td>${escH(x.yourAns)}</td>
    <td>${x.q.type === 'fill' ? mDispOpt(String(x.q.ans[0])) : x.q.ans.map((a) => `(${a + 1})`).join('')}</td>
    <td class="${x.ms > x.target ? 'badc' : ''}">${fmtSec(x.ms)}/${fmtSec(x.target)}</td></tr>`).join('');
  app().innerHTML = `
    <h1>模擬結果 — ${mock.reason}</h1>
    ${goalCrossBanner()}
    ${mock.partial ? '<div class="card warn">中途結束：只結算你作答過的題，不列入模擬成績走勢（每題紀錄與筆跡照樣保存）。</div>' : ''}
    <div class="card">
      <p class="big">答對 <b>${okN} / ${paper.length}</b>（${(acc * 100).toFixed(0)}%）${mock.partial ? '' : `→ 體感 <b class="accent">${gradeOf(acc)}</b>`}</p>
      ${mockTrend}
      ${cheers ? `<div class="praise"><b>先說做得好的：</b><ul>${cheers}</ul></div>` : ''}
      <ul>
        <li>卡太久沒跳（答錯且耗時超過建議 1.5 倍——考場上 90 秒沒路就該跳）：<b class="${overStuck.length ? 'badc' : 'okc'}">${overStuck.length} 題</b>${overStuck.length ? ' ← 這是你寫不完的直接原因' : ' ✅'}</li>
        <li>「對但太慢」：<b class="${slowOk.length ? 'warnc' : 'okc'}">${slowOk.length} 題</b>${slowOk.length ? ' ← 已加入錯題本重練速度' : ''}</li>
        ${mock.partial ? '' : `<li>剩餘未用時間：${unused > 0 ? fmtClock(unused) : '0（時間用罄）'}</li>`}
      </ul>
      ${mock.partial ? '<p class="dim">完成一次完整 12 題模擬，才會得到體感級分估計與模擬走勢。</p>' : ''}
      ${aiNotes ? `<div class="sol"><b>🤖 AI 抓到的出錯點：</b><ul>${aiNotes}</ul></div>` : ''}
      <div class="tblwrap"><table class="tbl"><tr><th>題目</th><th>結果</th><th>你的答案</th><th>正解</th><th>耗時/建議</th></tr>${rows}</table></div>
      ${wrongAdded ? '<p class="dim">錯題與超時題已進錯題本，明天到期。</p>' : ''}
      ${unansweredIds.length ? `<div class="actr"><span class="dim fs13">⊘ 放棄/未作答的 ${unansweredIds.length} 題（完全沒路的題最需要補概念）</span><button class="btn sm" onclick="addWrongManual('${unansweredIds.map(jsA).join(',')}');this.disabled=true;this.textContent='已加入 ✓'">加入錯題本</button></div>` : ''}
      <div class="actr"><button class="btn" onclick="nav('stats')">看數據</button>
      <button class="btn primary" onclick="nav('wrong')">去看錯題詳解</button></div>
    </div>`;
}
/* 手動把題目釘進錯題本（模擬放棄題等「沒作答但該補」的題） */
function addWrongManual(csv) {
  for (const id of String(csv).split(',')) {
    if (!id || !bankById(id)) continue;
    if (S.wrong[id] && !S.wrong[id].grad) continue; // 已在本裡就不動
    S.wrong[id] = { fails: 0, wins: 0, itv: 1, err: '概念不熟', due: addDays(today(), 1), mt: Date.now() };
  }
  save();
  updateBadge();
}

/* ═══════════ 錯題本 2.0：學習卡（先學再測），不再只是到期日表格 ═══════════ */
function setWrongErr(id, err, btn) {
  const w = S.wrong[id];
  if (!w) return;
  w.err = err;
  w.mt = Date.now();
  save();
  // 原地更新，不整頁重繪：重繪會把所有展開的卡收起、捲動歸零，chips 就沒法用了
  if (btn && btn.parentElement) {
    btn.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('sel', c === btn));
  }
}
/* 指定單元直開一輪刷題（錯題卡「同單元加練」/數據頁攻擊清單/戰力地圖共用） */
function startPracTopics(topics, cnt) {
  if (!syncGate()) return;
  let pool = BANK.filter((q) => topics.includes(q.topic));
  if (!pool.length) { alert('這些單元目前沒有題目。'); return; }
  const ac = attCountMap();
  pool = shuffle(pool).sort((a, b) => (ac.get(a.id) || 0) - (ac.get(b.id) || 0));
  prac = { queue: dedupeStems(pool, Math.min(cnt || 8, pool.length)), i: 0, results: [], mode: 'practice' };
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pracNext();
}
function startPracTopic(k) { startPracTopics([k], 6); }
/* 錯題學習卡：題目全文＋上次跑掉的地方＋AI 的「下次這樣做」＋作答時間線＋詳解/老師教法＋行動鈕 */
function wrongCard(id) {
  const w = S.wrong[id]; const q = bankById(id);
  if (!q) return '';
  const isDue = !w.grad && w.due <= today();
  const steps = [1, 3, 7, 14];
  const stepIdx = steps.indexOf(w.itv);
  const ladder = steps.map((s, i) => `<i class="${stepIdx >= i ? 'on' : ''}" title="${s} 天"></i>`).join('');
  const hist = attemptsOf(id).slice(-5);
  const histLine = hist.map((a) => `<span class="${a.ok ? 'okc' : 'badc'}" title="${a.d}｜${fmtSec(a.ms || 0)}">${a.ok ? '✔' : '✘'}</span>`).join(' ');
  return `<details class="card wcard ${isDue ? 'due' : ''}">
    <summary>
      <span class="wc-meta">${TOPICS[q.topic]}｜${starF(q.diff) || '☆'}｜${w.fails > 0 ? `<span class="badc">錯 ${w.fails} 次</span>` : '<span class="warnc">放棄/未作答</span>'}${w.err ? `｜${w.err}` : ''}${q.fig ? '｜📐' : ''}</span>
      <span class="wc-due">${isDue ? '<b class="warnc">今天到期</b>' : escH(w.due || '')}</span>
    </summary>
    <div class="wc-body">
      <div class="wc-q">${q.stem ? `<div class="bk-stem">${rtTxt(q.stem)}</div>` : ''}${rtTxt(q.q)}${q.fig ? `<div class="qfig">${sanitizeSVG(q.fig)}</div>` : ''}${q.type !== 'fill' && q.opts ? `<div class="bk-opts">${q.opts.map((o, i) => `<div class="bk-opt"><span class="bk-op">(${i + 1})</span><span>${rtTxt(o)}</span></div>`).join('')}</div>` : ''}</div>
      <p class="dim fs13">正解：<b>${q.type === 'fill' ? mDispOpt(String(q.ans[0])) : q.ans.map((a) => `(${a + 1})`).join('')}</b>｜離畢業 <span class="itv-ladder">${ladder}</span>（1→3→7→14 天四關）｜最近：${histLine || '—'}</p>
      ${w.adv && w.adv.fe ? `<p class="badc">✘ 上次你這裡跑掉了：${escH(w.adv.fe)}</p>` : ''}
      ${w.adv && w.adv.nt ? `<div class="next-step"><b>🎯 下次這樣做：</b>${escH(w.adv.nt)}</div>` : (q.tip ? `<p class="tip">💡 ${rtTxt(q.tip)}</p>` : '')}
      <div class="chips r fs13">${ERR_TYPES.map((e) => `<button class="chip ${w.err === e ? 'sel' : ''}" onclick="setWrongErr('${jsA(id)}','${e}',this)">${e}</button>`).join('')}</div>
      <details class="sol-detail"><summary class="dim">📖 詳解 · 老師這樣教</summary>
        <p>${rtTxt(q.sol)}</p>${q.solFig ? `<div class="qfig">${sanitizeSVG(q.solFig)}</div>` : ''}${q.tip ? `<p class="tip">💡 ${rtTxt(q.tip)}</p>` : ''}${teachBlock(q.id)}
        <div class="actr"><button class="btn sm" onclick="showMethods('${q.topic}')">🧑‍🏫 調老師方法庫</button></div>
      </details>
      <div class="actr">
        <button class="btn" onclick="startPracTopics(['${q.topic}'],5)">同單元加練 5 題</button>
        <button class="btn primary" onclick="reviewOne('${jsA(id)}')">重測這題</button>
      </div>
    </div>
  </details>`;
}
/* 📖 單元重點整理（參考書內容匯入後出現；kind:'notes' 內容包） */
function notesLibCard() {
  const n = extNotesArr().length;
  if (!n) return '';
  return `<div class="card"><h2>📖 單元重點整理 <span class="dim">${n} 條</span></h2>
    <div class="chips r">${Object.keys(TOPICS).map((k) => `<button class="btn sm" onclick="showNotes('${k}')">${TOPICS[k]}</button>`).join('')}</div>
    <div id="notes-box"></div></div>`;
}
function showNotes(unit) {
  const box = $('#notes-box'); if (!box) return;
  const ns = extNotesArr().filter((x) => x.topic === unit).sort((a, b) => (a.order || 0) - (b.order || 0));
  box.innerHTML = ns.length
    ? `<div class="mlib">${ns.map((x) => `<details><summary>${escH(x.title)}</summary><div>${rtTxt(x.html)}</div></details>`).join('')}</div>`
    : `<p class="dim">「${TOPICS[unit]}」目前沒有匯入的重點。</p>`;
}
/* 🃏 衝刺複習：把錯題的「正解＋上次跑掉的地方＋下次這樣做」做成翻卡快速過一遍——不重解、不動間隔排程 */
let wflash = null;
function startWrongFlash() {
  const ids = Object.keys(S.wrong).filter((id) => !S.wrong[id].grad && bankById(id));
  if (!ids.length) { alert('沒有可複習的錯題。'); return; }
  wflash = { ids: shuffle(ids), i: 0, back: false };
  sessionActive = true;
  sessionMode = 'wflash';
  wfShow();
}
function wfShow() {
  if (!wflash) return;
  if (wflash.i >= wflash.ids.length) {
    sessionActive = false; sessionMode = null; sessionChrome(false);
    const n = wflash.ids.length;
    wflash = null;
    app().innerHTML = `<h1>🃏 衝刺複習完成</h1><div class="card good"><p class="big">過完 ${n} 題錯題的重點</p>
      <p class="dim">這不是重測——間隔排程照舊；到期時記得回來真的動筆重測。</p>
      <div class="actr"><button class="btn primary" onclick="nav('wrong')">回錯題本</button></div></div>`;
    return;
  }
  const id = wflash.ids[wflash.i];
  const q = bankById(id); const w = S.wrong[id];
  wflash.back = false;
  app().innerHTML = `
    <div class="session-head"><span>🃏 衝刺複習｜${wflash.i + 1} / ${wflash.ids.length}｜${TOPICS[q.topic]}</span>
      <span class="shr"><button class="btn sm xbtn" onclick="exitFlow()">✕</button></span></div>
    <div class="card flashcard" onclick="wfFlip()">
      <p class="dim">${w.err || ''}｜${w.fails > 0 ? '錯 ' + w.fails + ' 次' : '放棄/未作答'}</p>
      <div class="wc-q" style="text-align:left">${q.stem ? `<div class="bk-stem">${rtTxt(q.stem)}</div>` : ''}${rtTxt(q.q)}${q.fig ? `<div class="qfig">${sanitizeSVG(q.fig)}</div>` : ''}${q.type !== 'fill' && q.opts ? `<div class="bk-opts">${q.opts.map((o, i) => `<div class="bk-opt"><span class="bk-op">(${i + 1})</span><span>${rtTxt(o)}</span></div>`).join('')}</div>` : ''}</div>
      <div id="wf-back" style="display:none;text-align:left">
        <p>正解：<b class="accent big">${q.type === 'fill' ? mDispOpt(String(q.ans[0])) : q.ans.map((a) => `(${a + 1}) ${q.opts ? rtTxt(q.opts[a]) : ''}`).join('、')}</b></p>
        ${w.adv && w.adv.fe ? `<p class="badc">上次你這裡跑掉了：${escH(w.adv.fe)}</p>` : ''}
        ${w.adv && w.adv.nt ? `<div class="next-step"><b>🎯 下次這樣做：</b>${escH(w.adv.nt)}</div>` : ''}
        ${q.tip ? `<p class="tip">💡 ${rtTxt(q.tip)}</p>` : ''}
      </div>
    </div>
    <div class="flash-btns" id="wf-btns"><button class="btn primary big" onclick="wfFlip()">先想「條件 → 工具 → 第一步」，再翻面對照</button></div>`;
  sessionChrome(true);
}
function wfFlip() {
  if (!wflash) return;
  if (!wflash.back) {
    wflash.back = true;
    const b = $('#wf-back'); if (b) b.style.display = 'block';
    const bt = $('#wf-btns');
    const last = wflash.i >= wflash.ids.length - 1;
    if (bt) bt.innerHTML = `<button class="btn primary big" onclick="wflash.i++;wfShow()">${last ? '完成 ✓' : '下一張 →'}</button>`;
  }
}
function renderWrong() {
  const all = Object.keys(S.wrong);
  const valid = all.filter((id) => bankById(id));
  const missing = all.length - valid.length;
  const active = valid.filter((id) => !S.wrong[id].grad);
  const grads = valid.filter((id) => S.wrong[id].grad);
  const due = active.filter((id) => S.wrong[id].due <= today());
  const gradBadge = grads.length ? ` <span class="okc fs13">🎓 已畢業 ${grads.length} 題</span>` : '';
  if (!active.length) {
    app().innerHTML = `<h1>📓 錯題本${gradBadge}</h1>
      <div class="card good"><p>目前沒有待複習的錯題${grads.length ? `——而且你已經讓 <b>${grads.length}</b> 題畢業了 ✅` : ' ✅'}</p></div>
      ${grads.length ? gradTable(grads) : ''}${mlibCard()}${notesLibCard()}`;
    return;
  }
  const sorted = active.slice().sort((a, b) => ((S.wrong[a].due || '') < (S.wrong[b].due || '') ? -1 : 1));
  app().innerHTML = `
    <h1>📓 錯題本 <span class="dim">1→3→7→14 天</span>${gradBadge}</h1>
    ${due.length ? `<div class="card warn"><b>${due.length} 題今天到期——先清這些，投報率最高。</b>
      <div class="actr"><button class="btn" onclick="startWrongFlash()">🃏 衝刺複習（不重解）</button>
      <button class="btn primary" onclick="reviewDue()">開始重測（${due.length}）</button></div></div>`
      : `<div class="card good">今天沒有到期的錯題 ✅
      <div class="actr"><button class="btn" onclick="startWrongFlash()">🃏 衝刺複習（把建議再過一遍）</button></div></div>`}
    ${missing ? `<p class="dim">另有 ${missing} 題屬雲端題包、題目尚未載入，暫時無法顯示與重測。</p>` : ''}
    ${sorted.map((id) => wrongCard(id)).join('')}
    ${grads.length ? gradTable(grads) : ''}
    ${mlibCard()}
    ${notesLibCard()}
    <p class="dim">訂正標準：能自己說出「關鍵條件 → 工具 → 第一步」才算訂正完。</p>`;
}
function gradTable(grads) {
  return `<details class="card"><summary class="dim">🎓 已畢業 ${grads.length} 題（1→3→7→14 天四關全過）</summary>
    <table class="tbl"><tr><th>單元</th><th>畢業日</th><th>曾錯</th></tr>
    ${grads.map((id) => { const w = S.wrong[id]; const q = bankById(id); return `<tr><td>${TOPICS[q.topic]}</td><td>${w.grad}</td><td>${w.fails} 次</td></tr>`; }).join('')}</table></details>`;
}
let review = null;
function reviewDue() { if (!syncGate()) return; startReview(dueWrong()); }
function reviewOne(id) {
  if (!syncGate()) return;
  // 「重測這題」不再做完就回列表——這題排第一，其餘未畢業錯題（到期的排前面）接在後面，一路往下跳到下一題錯題
  const rest = Object.keys(S.wrong)
    .filter((x) => bankById(x) && !S.wrong[x].grad && x !== id)
    .sort((a, b) => ((S.wrong[a].due || '') < (S.wrong[b].due || '') ? -1 : 1));
  startReview([id, ...rest], true);
}
function startReview(ids, keepOrder) {
  ids = ids.filter((id) => bankById(id)); // 題庫載不到的失效 id（如雲端題包未載入）直接略過，避免炸畫面
  if (!ids.length) { alert('這些錯題對應的題目不在目前的題庫裡（可能來自尚未載入的雲端題包），暫時無法重測。'); return; }
  review = { ids: keepOrder ? ids : shuffle(ids), i: 0, okN: 0, excl: 0, grads: [] };
  sessionActive = true;
  sessionMode = 'review';
  snapSession();
  reviewNext();
}
function reviewNext() {
  if (review.i >= review.ids.length) {
    sessionActive = false;
    sessionMode = null;
    sessionChrome(false);
    const denom = review.ids.length - (review.excl || 0);
    const allPass = denom > 0 && review.okN === denom;
    app().innerHTML = `<h1>重測完成</h1>${dailyBanner(2)}${goalCrossBanner()}<div class="card good">
      <p class="big">過關 ${review.okN} / ${denom}</p>
      ${review.excl ? `<p class="dim">（另有 ${review.excl} 題因中途離開未列入）</p>` : ''}
      ${review.grads.length ? `<p class="praise">🎓 本輪畢業 <b>${review.grads.length}</b> 題（${review.grads.join('、')}）——連過四關，從錯題本除名！</p>` : ''}
      ${allPass ? '<p class="praise">🎉 到期錯題全數過關——之前跌倒的地方都站起來了，這是最扎實的一種進步！</p>' : ''}
      <p>過關的題進入下一個間隔；答錯或還不夠快的明天再來。</p>
      <div class="actr"><button class="btn primary" onclick="nav('wrong')">回錯題本</button></div></div>`;
    return;
  }
  const q = bankById(review.ids[review.i]);
  if (!q) { review.i++; return reviewNext(); }
  renderQuestion(q, {
    head: `錯題重測 ${review.i + 1} / ${review.ids.length}`,
    review: true,
    onDone(res) {
      if (res.excluded) review.excl = (review.excl || 0) + 1;
      else if (res.grad ? res.grad !== 'back' : res.ok) review.okN++; // 過關＝晉級或畢業；「答對但不夠快」被打回不算過關
      if (res.grad === 'grad') review.grads.push(TOPICS[q.topic]);
      review.i++;
      reviewNext();
    },
  });
}

/* ═══════════ 數據 ═══════════ */
function renderStats() {
  if (!S.attempts.length) {
    // 沒做題也要能管理內容包/登錄模考（家教流程常是「先灌題包再開始做」）
    app().innerHTML = `<h1>📊 數據</h1>${dailyCard()}<div class="card"><p>還沒有做題數據。</p>
      <div class="actr"><button class="btn primary" onclick="nav('mock')">去摸底</button></div></div>${timerSettingCard()}${extMockCard()}${packCard()}${aiCard()}${syncCard()}${backupCard()}`;
    return;
  }
  // 單元統計
  const byTopic = {};
  for (const a of S.attempts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (byTopic[q.topic] = byTopic[q.topic] || { n: 0, ok: 0, ms: 0, target: 0 });
    t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms; t.target += qTarget(q);
  }
  const topicRows = Object.keys(byTopic)
    .map((k) => ({ k, ...byTopic[k], acc: byTopic[k].ok / byTopic[k].n, speed: byTopic[k].ms / byTopic[k].target }))
    .sort((a, b) => (a.acc - b.acc) || (b.speed - a.speed));
  const atk = attackList(); // 沒寫過的更危險：優先攻擊要包含沒摸過的單元；點了直接開 8 題
  // 72%＝13 級門檻、78%＝14 級門檻（GRADE_TABLE 實值）：刻度直接釘在每條橫條上
  const bars = topicRows.map((t) => `
    <div class="bar-row"><span class="bar-label">${TOPICS[t.k]} <span class="dim">(${t.n}題)</span></span>
      <div class="bar"><div class="bar-fill ${t.acc >= 0.78 ? 'g' : t.acc >= 0.72 ? 't' : t.acc >= 0.6 ? 'y' : 'r'}" style="width:${(t.acc * 100).toFixed(0)}%"></div><i class="tick t72"></i><i class="tick t78"></i></div>
      <span class="bar-val">${(t.acc * 100).toFixed(0)}%｜速度 ${t.speed > 1 ? '<b class="badc">' : '<b class="okc">'}${t.speed.toFixed(2)}×</b></span>
    </div>`).join('');
  // 錯因統計
  const errCount = {};
  for (const a of S.attempts) if (a.err) errCount[a.err] = (errCount[a.err] || 0) + 1;
  const errMax = Math.max(1, ...Object.values(errCount)); // 以最大次數正規化：條長差異才看得出來（跟卡點卡同一套視覺語言）
  const errBars = ERR_TYPES.filter((e) => errCount[e]).map((e) => `
    <div class="bar-row"><span class="bar-label">${e}</span>
      <div class="bar"><div class="bar-fill y" style="width:${(errCount[e] / errMax * 100).toFixed(0)}%"></div></div>
      <span class="bar-val">${errCount[e]} 次</span></div>`).join('') || '<p class="dim">尚無錯因紀錄</p>';
  const ERR_RX = {
    '概念不熟': '先到「📓 錯題本」頁調出該單元的老師方法庫（口訣＋方法），看完立刻限時重做同型題——看懂不算數，寫出來才算。',
    '計算失誤': '不是粗心，是計算量訓練不足——加練「⚡兩位數心算」與該單元速度特訓。',
    '看錯題意': '養成「動筆前圈出問句關鍵字」的固定動作：求什麼？最大最小？正確錯誤？',
    '用猜的': '該題型完全沒把握——列入概念補強清單，優先級最高。',
    '超時': '會但慢：這種題重測時要在目標時間內完成才過關（系統已自動把關），另找它的「快解」套路。',
  };
  const ERR_ACT = { // 處方不是死文字：一鍵直達對症訓練
    '概念不熟': '<button class="btn sm" onclick="nav(\'wrong\')">去方法庫</button>',
    '計算失誤': '<button class="btn sm" onclick="startDrill(\'mul\')">練心算</button>',
    '用猜的': '<button class="btn sm" onclick="nav(\'wrong\')">去方法庫</button>',
    '超時': '<button class="btn sm" onclick="nav(\'drill\')">去速訓</button>',
  };
  const advice = Object.keys(errCount).sort((a, b) => errCount[b] - errCount[a]).slice(0, 2)
    .map((e) => `<li><b>${e}（${errCount[e]} 次）：</b>${ERR_RX[e]}　${ERR_ACT[e] || ''}</li>`).join('');
  // 🧠 腦袋卡點：AI 語意判讀（attempts.p.stuck）優先；沒有才退回數字版過程診斷
  const procAtt = S.attempts.filter((a) => a.p);
  const stuckList = [];
  for (let i = S.attempts.length - 1; i >= 0 && stuckList.length < 8; i--) {
    const a = S.attempts[i];
    if (a.p && Array.isArray(a.p.stuck)) {
      for (const s of a.p.stuck) {
        if (stuckList.length >= 8) break;
        const q = bankById(a.qid);
        stuckList.push({ d: a.d, topic: q ? q.topic : null, ph: s.ph, what: s.what, fix: s.fix, dur: s.dur });
      }
    }
  }
  const phCount = {};
  for (const a of S.attempts) if (a.p && Array.isArray(a.p.stuck)) for (const s of a.p.stuck) if (s.ph) phCount[s.ph] = (phCount[s.ph] || 0) + 1;
  const PHASE_RX = {
    '想公式': ['📱 練公式必背卡', "nav('phone')"],
    '選方法': ['🧑‍🏫 補老師方法庫', "nav('wrong')"],
    '卡計算': ['⚡ 加練速度特訓', "nav('drill')"],
    '讀題': ['動筆前圈出問句關鍵字', ''],
    '驗算收尾': ['寫了再說、90 秒停損', ''],
  };
  let procCard = '';
  if (stuckList.length) {
    const hasAI = Object.keys(phCount).length > 0; // 本地啟發式卡點沒有 phase——標題與內容要誠實區分
    const maxPh = Math.max(1, ...Object.values(phCount));
    const phBars = Object.keys(phCount).sort((a, b) => phCount[b] - phCount[a]).map((ph) => {
      const rx = PHASE_RX[ph];
      const act = rx ? (rx[1] ? `<a onclick="${rx[1]}" style="cursor:pointer">${rx[0]}</a>` : rx[0]) : '';
      return `<div class="bar-row"><span class="bar-label">${escH(ph)}</span>
        <div class="bar"><div class="bar-fill y" style="width:${Math.round(100 * phCount[ph] / maxPh)}%"></div></div>
        <span class="bar-val">${phCount[ph]} 次${act ? '｜' + act : ''}</span></div>`;
    }).join('');
    const numLine = procAtt.length ? `<p class="dim fs13">起筆平均 ${Math.round(procAtt.reduce((s, a) => s + (a.p.fi || 0), 0) / procAtt.length)}s｜停頓 ${(procAtt.reduce((s, a) => s + (a.p.hes || []).length, 0) / procAtt.length).toFixed(1)} 次/題｜塗改 ${(procAtt.reduce((s, a) => s + (a.p.era || 0), 0) / procAtt.length).toFixed(1)} 次/題（樣本 ${procAtt.length} 題）</p>` : '';
    procCard = `<div class="card"><h2>🧠 你最常卡的地方 <span class="dim">${hasAI ? 'AI 從手寫過程判讀' : '依停頓位置判讀（設 AI key 後升級成語意版）'}</span></h2>
      ${phBars}
      <p style="margin-top:8px"><b>最近的卡點（含解法）：</b></p>
      <ul>${stuckList.map((s) => `<li>${s.topic ? TOPICS[s.topic] + '：' : ''}${escH(s.what || '')}${s.fix ? `　<span class="okc">💡 ${escH(s.fix)}</span>` : ''} <span class="dim">（${s.d}${s.dur ? '，停 ' + s.dur + 's' : ''}）</span></li>`).join('')}</ul>
      ${numLine}</div>`;
  } else if (procAtt.length) {
    const fiAvg = Math.round(procAtt.reduce((s, a) => s + (a.p.fi || 0), 0) / procAtt.length);
    const hesPer = (procAtt.reduce((s, a) => s + a.p.hes.length, 0) / procAtt.length).toFixed(1);
    const eraPer = (procAtt.reduce((s, a) => s + a.p.era, 0) / procAtt.length).toFixed(1);
    const worstH = procAtt
      .map((a) => ({ a, m: a.p.hes.length ? Math.max(...a.p.hes.map((h) => h[1])) : 0 }))
      .filter((x) => x.m >= 30).sort((x, y) => y.m - x.m).slice(0, 3);
    procCard = `<div class="card"><h2>✍️ 過程診斷（手寫板）</h2>
      <p>平均起筆 <b>${fiAvg}s</b>｜題中停頓 <b>${hesPer} 次/題</b>｜塗改 <b>${eraPer} 次/題</b>（樣本 ${procAtt.length} 題）</p>
      ${worstH.length ? `<p><b>最嚴重卡點：</b></p><ul>${worstH.map(({ a, m }) => {
        const q = bankById(a.qid);
        return `<li>${q ? TOPICS[q.topic] : a.qid}：單次停頓 <b class="warnc">${m}s</b>（${a.d}${a.ok ? '，最後有解出來' : '，最後沒解出來'}）</li>`;
      }).join('')}</ul>` : ''}
      <p class="dim">之後有 AI key 的手寫作答會自動判讀「每次停頓當下你卡在哪」，這張卡會升級成語意版。</p></div>`;
  }
  // 模擬歷史
  const mockRows = S.mocks.map((m) => `<tr><td>${m.d}</td><td>${m.ok}/${m.n}</td><td>${(m.acc * 100).toFixed(0)}%</td><td>${gradeOf(m.acc)}</td></tr>`).join('');
  // 特訓趨勢
  const drillRows = Object.keys(S.drills).map((k) => {
    const h = S.drills[k]; const last = h[h.length - 1]; const first = h[0];
    const trend = h.length > 1 ? `${(first.med / 1000).toFixed(1)}s → ${(last.med / 1000).toFixed(1)}s` : `${(last.med / 1000).toFixed(1)}s`;
    const pass = last.med / 1000 <= DRILLS[k].target && last.acc === 100;
    return `<tr><td>${DRILLS[k].name}</td><td>${h.length} 輪</td><td>${trend}</td><td>${pass ? '✅ 已自動化' : '訓練中'}</td></tr>`;
  }).join('');
  app().innerHTML = `
    <h1>📊 數據</h1>
    ${dailyCard()}
    ${milestoneCard()}
    ${atk.length ? `<div class="card warn"><b>本週優先攻擊</b> <span class="dim">點單元＝直接開 8 題</span>
      <div class="chips">${atk.map((a) => `<button class="chip" onclick="startPracTopics(['${a.k}'],8)">${TOPICS[a.k]} <span class="dim">${a.reason}</span></button>`).join('')}</div></div>` : ''}
    <div class="card"><h2>單元答對率與速度比 <span class="dim">速度比 >1× ＝ 吃時間</span></h2>${bars}
      <p class="dim fs12">直線刻度＝72%（13 級門檻）與 78%（14 級門檻）；策略上抓高一點——保底 73%、進攻 80%。</p></div>
    <div class="card"><h2>錯因分布 → 對症處方</h2>${errBars}${advice ? `<ul>${advice}</ul>` : ''}</div>
    ${errTrendCard()}
    ${procCard}
    ${drillRows ? `<div class="card"><h2>速度特訓進度</h2><table class="tbl"><tr><th>項目</th><th>輪數</th><th>中位數變化</th><th>狀態</th></tr>${drillRows}</table></div>` : ''}
    ${mockRows ? `<div class="card"><h2>系統模擬走勢</h2><table class="tbl"><tr><th>日期</th><th>答對</th><th>答對率</th><th>體感級分</th></tr>${mockRows}</table></div>` : ''}
    ${timerSettingCard()}
    ${extMockCard()}
    ${packCard()}
    ${aiCard()}
    ${syncCard()}
    ${backupCard()}`;
  const cw = document.querySelector('.chartwrap'); // 窄螢幕橫向捲動的每日圖：預設捲到最右（今天那根）
  if (cw) cw.scrollLeft = cw.scrollWidth;
  loadErrShots(); // 非同步從 IndexedDB 載錯題手寫縮圖
}
/* 🔎 錯誤趨勢：把每次答錯「錯在哪種機制」(ai.k) 統整＋最近錯題手寫縮圖（存在 IndexedDB）。深度趨勢分析可再叫 AI。 */
function errTrendCard() {
  const kc = {};
  for (const a of S.attempts) { if (a.ok) continue; const k = a.ai && a.ai.k; if (k) kc[k] = (kc[k] || 0) + 1; }
  const kinds = Object.entries(kc).sort((x, y) => y[1] - x[1]);
  const kMax = Math.max(1, ...kinds.map((x) => x[1]));
  const bars = kinds.length
    ? kinds.map(([k, n]) => `<div class="bar-row"><span class="bar-label">${escH(k)}</span><div class="bar"><div class="bar-fill y" style="width:${(n / kMax * 100).toFixed(0)}%"></div></div><span class="bar-val">${n} 次</span></div>`).join('')
    : '<p class="dim fs13">還沒有 AI 標記的「錯法」——答錯時讓 AI 批改，就會累積「怎麼錯的」機制分類。</p>';
  return `<div class="card"><h2>🔎 錯誤趨勢（怎麼錯的）</h2>
    <p class="dim fs13">不只粗心/猜/不熟——AI 把每次答錯歸類成「正負號、化簡、移項、審題…」哪種機制，看出你的固定漏洞。</p>
    ${bars}
    <div id="errshots" class="errshots"><p class="dim fs13">載入錯題手寫…</p></div>
    <p class="dim fs13">要更深的趨勢（跨單元/題型/時間的模式）跟我説一聲，我調你的手寫檔＋錯法紀錄幫你統整。</p></div>`;
}
async function loadErrShots() {
  const el = document.getElementById('errshots');
  if (!el) return;
  const si = await storageInfo();
  const mb = (b) => (b / 1048576).toFixed(0);
  const near = si.warn || (si.quota && si.usage / si.quota > 0.85);
  const status = `<p class="fs13 ${near ? 'warnc' : 'dim'}" style="margin:2px 0 6px">📦 本機已存 <b>${si.count}</b> 張手寫${si.quota ? `｜裝置用量 ${mb(si.usage)} / ${mb(si.quota)} MB` : ''}${near ? '——<b>本機空間吃緊，最舊的縮圖開始輪替</b>（雲端仍保留全部）。要全部留本機請清裝置空間，或升級雲端 DB。' : '（不設上限、盡量全留）'}<br><span class="dim">雲端 ink_sessions 永久保留你每一題的手寫筆跡、無上限——本機這份只是快取縮圖。</span></p>`;
  const all = await errShotAll();
  if (!all.length) { el.innerHTML = status + '<p class="dim fs13">目前本機沒有存下的錯題手寫縮圖（之後答錯有手寫就會自動留下）。</p>'; return; }
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  el.innerHTML = status + '<p class="dim fs13" style="margin:8px 0 4px">最近的錯題手寫（點看大圖＋錯在哪）：</p><div class="errshots-grid">'
    + all.slice(0, 12).map((s) => `<figure class="errshot" onclick="errShotZoom('${escH(String(s.key))}')"><img src="${s.img}" alt="錯題手寫" loading="lazy"><figcaption>${escH(TOPICS[s.topic] || s.topic || '')}${s.k ? '｜' + escH(s.k) : (s.tag ? '｜' + escH(s.tag) : '')}<br><span class="dim">${escH(s.d || '')}</span></figcaption></figure>`).join('')
    + '</div>';
}
function errShotZoom(key) {
  errShotAll().then((all) => {
    const s = all.find((x) => String(x.key) === key); if (!s) return;
    const a = S.attempts.filter((x) => x.qid === s.qid).sort((p, q2) => (q2.ts || 0) - (p.ts || 0))[0];
    const fe = (a && a.ai && a.ai.fe) || s.fe;
    const k = (a && a.ai && a.ai.k) || s.k;
    modal(`<h2>錯題手寫｜${escH(TOPICS[s.topic] || '')}</h2>
      <p class="dim fs13">${escH(s.d || '')}${k ? '｜錯法：<b>' + escH(k) + '</b>' : ''}${s.tag ? '｜自評：' + escH(s.tag) : ''}</p>
      ${fe ? `<p class="badc">✘ 你這裡跑掉了：${escH(fe)}</p>` : ''}
      <div class="errshot-full"><img src="${s.img}" alt="錯題手寫"></div>`, [['關閉', null, 'primary']]);
  });
}
/* ═══════════ 🧑‍🏫 AI 老師：撈你全部作答表現＋歷史手寫，像長期家教一樣討論學習 ═══════════
   表現＝本機 S.attempts/wrong（也同步在雲端 app_state）；手寫＝Supabase ink_sessions 的筆跡重繪成圖＋配題幹。 */
function buildTutorDigest() {
  const A = (S.attempts || []).filter((a) => a.mode !== 'drill'); // 速訓＝反射練習，主分析看正式作答
  if (!A.length) return '（這位學生還沒有正式作答紀錄。）';
  const okN = A.filter((a) => a.ok).length, ds = A.map((a) => a.d).filter(Boolean).sort();
  const byT = {};
  for (const a of A) { const q = bankById(a.qid); if (!q) continue; const t = byT[q.topic] = byT[q.topic] || { n: 0, ok: 0, ms: 0, tgt: 0 }; t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms || 0; t.tgt += qTarget(q); }
  const topics = Object.entries(byT).map(([k, t]) => ({ name: TOPICS[k] || k, n: t.n, acc: t.ok / t.n, spd: t.tgt ? t.ms / t.tgt : 0 })).sort((a, b) => a.acc - b.acc);
  const tag = {}, kind = {};
  for (const a of A) { if (a.ok) continue; if (a.err) tag[a.err] = (tag[a.err] || 0) + 1; if (a.ai && a.ai.k) kind[a.ai.k] = (kind[a.ai.k] || 0) + 1; }
  let fiS = 0, fiC = 0, hesS = 0, eraS = 0, pc = 0;
  for (const a of A) { const p = a.p; if (!p) continue; pc++; if (p.fi != null) { fiS += p.fi; fiC++; } hesS += (p.hes || []).length; eraS += p.era || 0; }
  const recent = A.filter((a) => !a.ok).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 18).map((a) => { const q = bankById(a.qid); return `・${q ? TOPICS[q.topic] : '?'}(難${q ? q.diff : '?'})${a.d}：${(a.ai && a.ai.fe) || a.err || '—'}`; });
  const cut = addDays(today(), -14);
  const rec = A.filter((a) => (a.d || '') >= cut), old = A.filter((a) => (a.d || '') < cut);
  const trend = (rec.length && old.length) ? `近14天答對率${(rec.filter((a) => a.ok).length / rec.length * 100).toFixed(0)}%(${rec.length}題) vs 更早${(old.filter((a) => a.ok).length / old.length * 100).toFixed(0)}%(${old.length}題)` : '資料還不夠比趨勢';
  const pct = (x) => (x * 100).toFixed(0) + '%';
  return [
    `作答總覽：正式作答 ${A.length} 題、答對率 ${pct(okN / A.length)}（${ds[0]}～${ds[ds.length - 1]}）。${trend}。`,
    `\n【各單元（弱→強）】\n` + topics.map((t) => `${t.name}：${t.n}題 答對${pct(t.acc)} 速度${t.spd ? t.spd.toFixed(2) + '×' : '—'}`).join('\n'),
    `\n【自評錯因】` + (Object.entries(tag).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + v).join('、') || '（無）'),
    `【AI 判的錯法機制】` + (Object.entries(kind).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + v).join('、') || '（近期才開始累積、暫少）'),
    `\n【解題行為】平均 ${fiC ? (fiS / fiC).toFixed(1) : '?'} 秒才下第一筆、每題平均停頓 ${pc ? (hesS / pc).toFixed(1) : '?'} 次、擦除 ${pc ? (eraS / pc).toFixed(1) : '?'} 次（停頓多＝在想、擦除多＝算不穩）。`,
    `\n【最近答錯的具體情形】\n` + recent.join('\n'),
    `\n【錯題本】待複習 ${dueWrong().length} 題、已畢業 ${gradCount()} 題。`,
  ].join('\n');
}
function inkStrokesToImg(arr) { // 把 ink_sessions 存的筆畫重繪成裁切白底 PNG（給 AI 看你實際怎麼寫）
  arr = (arr || []).filter((s) => s && s.pts && s.pts.length && !s.dead);
  if (!arr.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of arr) for (const p of s.pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
  const pad = 14, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2, scale = Math.min(2, Math.max(0.4, 1100 / w));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of arr) inkDrawStroke(ctx, s, 2.2);
  return cv.toDataURL('image/png').split(',')[1];
}
async function tutorPullInk(limit) {
  if (!supa || !syncState.user) return [];
  try { const { data } = await supa.from('ink_sessions').select('qid,proc,strokes').eq('user_id', syncState.user.id).order('t0', { ascending: false }).limit(limit || 50); return data || []; }
  catch (e) { return []; }
}
async function tutorHandwriting(n) { // 撈最近答錯的手寫、重繪、配題幹（手寫＋題幹一起才有意義）
  const rows = await tutorPullInk(60);
  const wrong = rows.filter((r) => r.proc && r.proc.ok === false && r.strokes && r.strokes.s && r.strokes.s.length).slice(0, n);
  const out = [];
  for (const r of wrong) { const img = inkStrokesToImg(r.strokes.s); if (!img) continue; const q = bankById(r.qid); out.push({ img, stem: q ? stripTags(q.q).slice(0, 140) : r.qid, ok: false }); }
  return out;
}
let tutorChat = null;
function renderTutor() {
  if (!aiKey()) { app().innerHTML = `<h1>🧑‍🏫 AI 老師</h1><div class="card"><p>要先設定 AI key 才能跟老師對話。</p><div class="actr"><button class="btn primary" onclick="nav('stats')">去數據頁設定 AI</button></div></div>`; return; }
  if (!S.attempts || !S.attempts.length) { app().innerHTML = `<h1>🧑‍🏫 AI 老師</h1><div class="card"><p>還沒有作答紀錄——先練幾題，老師才有東西跟你討論。</p></div>`; return; }
  if (!tutorChat) tutorChat = { turns: [], hwReady: false };
  app().innerHTML = `<h1>🧑‍🏫 AI 老師 <span class="dim" style="font-size:14px">你的長期家教</span></h1>
    <div class="card"><p class="dim fs13">這位老師看得到你「全部的作答表現、單元強弱、速度、錯法，還會撈你最近幾題的手寫來看」。像跟長期家教聊天一樣問他：我最近怎麼樣？哪裡最該補？我為什麼老在某種地方錯？該怎麼調整？</p>
      <div id="tutor-chat"></div></div>`;
  mountTutorChat();
}
function mountTutorChat() {
  const el = document.getElementById('tutor-chat'); if (!el) return;
  const turns = tutorChat.turns;
  const log = turns.map((t) => t.role === 'user' ? '<div class="cm cm-u">' + escH(t.text) + '</div>' : '<div class="cm cm-a">' + rtTxt(t.text) + '</div>').join('') + (tutorChat.busy ? '<div class="cm cm-a dim">🧑‍🏫 老師看你的紀錄＋手寫中…</div>' : '');
  el.innerHTML = `<div class="ai-chat"><div class="chat-log">${log || '<p class="dim fs13">問老師任何關於你學習的事…</p>'}</div>
    <div class="chat-in"><textarea id="tutorq" rows="2" placeholder="例：我最近進步了嗎？哪個單元最該補？我為什麼老在正負號出錯？接下來一週該怎麼練？" ${tutorChat.busy ? 'disabled' : ''}></textarea>
    <button class="btn primary" onclick="tutorSend()" ${tutorChat.busy ? 'disabled' : ''}>問老師</button></div></div>`;
  el.querySelectorAll('.cm-a').forEach((n) => { try { renderMathInElement(n, { delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: true }], throwOnError: false }); } catch (e) {} });
  const ta = el.querySelector('#tutorq');
  if (ta) { ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tutorSend(); } }); const lg = el.querySelector('.chat-log'); if (lg) lg.scrollTop = lg.scrollHeight; if (turns.length && !tutorChat.busy) ta.focus(); }
}
async function tutorSend() {
  if (!tutorChat || tutorChat.busy || !aiKey()) return;
  const ta = document.getElementById('tutorq'); const q = ta ? ta.value.trim() : ''; if (!q) return;
  tutorChat.turns.push({ role: 'user', text: q });
  tutorChat.busy = true; mountTutorChat();
  try {
    if (!tutorChat.hwReady) { try { tutorChat.hw = await tutorHandwriting(6); } catch (e) { tutorChat.hw = []; } tutorChat.hwReady = true; }
    const system = '你是這位學測數學A考生的長期一對一家教，很了解他、講話直接但溫暖。根據下面「他的完整學習檔案」跟他討論學習狀況、指出你看到的模式與盲點、給「具體、可執行、這週就能做」的調整建議（別空泛、別只會叫他多練）。要寫算式一律用 \\(…\\) 包起來，不要用 markdown 粗體/標題。\n\n【他的學習檔案】\n' + buildTutorDigest() + (tutorChat.hw && tutorChat.hw.length ? '\n\n（第一則訊息另附他最近幾題答錯的手寫圖，每張前面都標了題目，供你看他實際怎麼寫、怎麼錯。）' : '');
    const msgs = tutorChat.turns.map((t, i) => {
      if (t.role === 'user' && i === 0 && tutorChat.hw && tutorChat.hw.length) {
        const content = [{ type: 'text', text: t.text }];
        for (const hw of tutorChat.hw) { content.push({ type: 'text', text: '〔題目〕' + hw.stem + '（他答錯）' }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: hw.img } }); }
        return { role: 'user', content };
      }
      return { role: t.role, content: t.text };
    });
    const reply = await aiChatCall(system, msgs);
    tutorChat.turns.push({ role: 'assistant', text: reply || '（沒有回應）' });
  } catch (e) { tutorChat.turns.push({ role: 'assistant', text: '（老師暫時回不了：' + ((e && e.message) || e) + '）' }); }
  finally { tutorChat.busy = false; mountTutorChat(); }
}
/* 計時器顯示開關（預設關：初期以寫完為主；時間照樣幕後記錄） */
function setTimerVis(on) { S.hideTimer = on ? false : true; save(); renderStats(); }
function timerSettingCard() {
  return `<div class="card"><h2>⏱️ 計時器</h2>
    <label class="chip"><input type="checkbox" ${timerOn() ? 'checked' : ''} onchange="setTimerVis(this.checked)"> 作答時顯示計時器</label>
    <p class="dim">${timerOn()
      ? '目前顯示中：作答畫面有碼表/進度條，超時的題會提醒。'
      : '目前隱藏中：作答不顯示任何碼表、進度條，也不因超時把答對的題丟進錯題本——先專心把題目寫完。<b>時間仍在幕後完整記錄</b>，之後想練速度再打開。'}
    （模擬實戰維持考場計時不受此設定影響。）</p></div>`;
}
/* 📦 題庫內容管理：外部題包按來源分組，可停用（紀錄保留、重啟即回） */
function packCard() {
  const packs = {};
  for (const q of extBankArr()) {
    const src = q.src || '（未標來源）';
    const p = (packs[src] = packs[src] || { n: 0, units: new Set(), d: { 1: 0, 2: 0, 3: 0 }, real: !!q.src });
    p.n++; p.units.add(q.topic); p.d[q.diff] = (p.d[q.diff] || 0) + 1;
  }
  const keys = Object.keys(packs);
  if (!keys.length) return '';
  const rows = keys.map((src) => {
    const p = packs[src];
    const off = packIsOff(src);
    return `<tr><td>${escH(src)}${off ? ' <span class="badc">（停用中）</span>' : ''}</td><td>${p.n} 題</td><td>${p.units.size} 單元</td><td class="dim">易${p.d[1] || 0}/中${p.d[2] || 0}/難${p.d[3] || 0}</td>
      <td>${p.real ? `<button class="btn sm" onclick="togglePack('${jsA(src)}')">${off ? '啟用' : '停用'}</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>📦 外部題庫 <span class="dim">共 ${extBankArr().length} 題${splitOn() ? '（已與作答狀態分家）' : ''}</span></h2>
    ${contentTableMissing ? '<p class="dim fs13">💡 到 Supabase Dashboard 跑一次 schema.sql 的 content_packs 段後，題庫將與作答狀態分家：每次作答不再整包上傳、20+ 本講義也放得下。</p>' : ''}
    <div class="tblwrap"><table class="tbl"><tr><th>來源</th><th>題數</th><th>覆蓋</th><th>難度分布</th><th></th></tr>${rows}</table></div></div>`;
}
function togglePack(src) {
  S.packOff = S.packOff || {};
  S.packOff[src] = { off: !packIsOff(src), ts: Date.now() }; // 永不 delete：顯式狀態＋時間戳才能在合併時分出新舊
  save();
  clearTimeout(syncTimer); // reload 會殺掉 4 秒 debounce——先直接推雲端再重載，別靠 unload 競速
  Promise.resolve(supa && syncState.user ? syncPush() : null).finally(() => location.reload());
}
/* 補習班模考成績登錄（4 次真實模考；跟系統模擬分開走勢） */
function extMockCard() {
  const list = (S.extMocks || []).slice().sort((a, b) => (a.d < b.d ? 1 : -1));
  const rows = list.map((m, i) =>
    `<tr><td>${m.d}</td><td>${m.name || '模考'}</td><td>${m.score}/${m.total}（${Math.round(100 * m.score / m.total)}%）</td>
      <td>${gradeOf(m.score / m.total)}</td><td>${escH(m.note || '')}</td>
      <td><button class="btn sm err" onclick="delExtMock(${i})">刪</button></td></tr>`).join('');
  return `<div class="card"><h2>🏫 補習班模考</h2>
    <div class="chips" style="align-items:flex-end">
      <label class="chip col">名稱<input id="em-name" class="ans-input sm" placeholder="第一次模考"></label>
      <label class="chip col">得分<input id="em-score" class="ans-input sm" inputmode="decimal" placeholder="76"></label>
      <label class="chip col">滿分<input id="em-total" class="ans-input sm" inputmode="decimal" value="100"></label>
      <label class="chip col">日期<input id="em-date" class="ans-input sm" type="date" value="${today()}"></label>
    </div>
    <label class="chip col" style="display:block">備註<input id="em-note" class="ans-input" placeholder="錯在哪、考場狀況…（選填）"></label>
    <div class="actr"><button class="btn primary" onclick="addExtMock()">登錄成績</button></div>
    ${rows ? `<div class="tblwrap"><table class="tbl"><tr><th>日期</th><th>名稱</th><th>得分</th><th>換算</th><th>備註</th><th></th></tr>${rows}</table></div>` : '<p class="dim">還沒登錄。四次補習班模考的成績記這裡，跟系統模擬分開看走勢。</p>'}</div>`;
}
function addExtMock() {
  const score = parseFloat(($('#em-score') || {}).value);
  const total = parseFloat(($('#em-total') || {}).value) || 100;
  const d = ($('#em-date') || {}).value || today();
  if (isNaN(score) || score < 0 || score > total) { alert('請填有效的得分（0～滿分）'); return; }
  S.extMocks = S.extMocks || [];
  S.extMocks.push({ d, name: ($('#em-name') || {}).value.trim() || '模考', score, total, note: ($('#em-note') || {}).value.trim(), ts: Date.now() });
  save();
  renderStats();
}
function delExtMock(i) {
  const list = (S.extMocks || []).slice().sort((a, b) => (a.d < b.d ? 1 : -1));
  const target = list[i];
  if (!target) return;
  S.extMocks = (S.extMocks || []).filter((m) => m !== target);
  save();
  renderStats();
}

/* ═══════════ 作戰計畫 ═══════════ */
function renderPlan() {
  const days = Math.ceil((new Date(EXAM_DATE) - new Date()) / 86400000);
  const weeks = Math.floor(days / 7);
  const t = today();
  const done = S.daily[t] || {};
  // 今日清單改唯讀狀態：打勾由「今日菜單」流程自動寫入，跟首頁菜單預覽是同一份資料，不再兩處各養一張清單
  const items = [['drill', '⚡ 速訓'], ['wrongq', '📓 清錯題'], ['prac', '🎯 刷題 8 題'], ['log', '📊 看數據']];
  const statusLine = items.map(([k, l]) => `<span class="chip" style="cursor:default">${done[k] ? '✅' : '⬜'} ${l}</span>`).join('');
  const streak = Object.keys(S.daily).filter((d) => Object.values(S.daily[d]).some(Boolean)).length;
  app().innerHTML = `
    <h1>🗓️ 作戰計畫 <span class="dim">距學測 ${days} 天（約 ${weeks} 週）</span></h1>
    <div class="card">
      <h2>今日進度（由「▶ 今日菜單」自動打勾）</h2>
      <div class="chips">${statusLine}</div>
      <div class="actr"><button class="btn primary big" onclick="startDaily()">▶ 一鍵開始今日菜單</button></div>
      <p class="dim">已執行 ${streak} 天｜週三、六改打一場模擬（每天約 60 分鐘數A）。</p>
    </div>
    <div class="card">
      <h2>三階段路線（現在 → 2027/1/22）</h2>
      <table class="tbl">
        <tr><th>階段</th><th>期間</th><th>主軸</th><th>檢查點</th></tr>
        <tr><td><b>① 自動化＋補洞</b></td><td>7~8 月</td>
          <td>速訓全達標；限時刷完 14 單元；錯題清零；不上新課</td>
          <td>8 月底：模擬 ≥ 70%、「該跳沒跳」= 0</td></tr>
        <tr><td><b>② 類題實戰</b></td><td>9~11 月</td>
          <td>歷屆已失真→主練系統內類題；全真＝補習班模考（共 4 次）</td>
          <td>11 月底：類題卷 ≥ 78%、模考寫得完留 15 分檢查</td></tr>
        <tr><td><b>③ 穩定輸出</b></td><td>12~1 月</td>
          <td>只重測錯題＋類題；節奏靠系統模擬＋補習班模考</td>
          <td>考前：連 3 次 ≥ 78%</td></tr>
      </table>
      <p><b>鐵律：沒有計時的練習不算練習。</b></p>
    </div>
    <div class="card">
      <h2>考場 SOP（背下來）</h2>
      <ol>
        <li>發卷先花 1 分鐘掃全卷，標出「一眼有路」的題。</li>
        <li>第一輪只做有路的題；90 秒內找不到第一步 → 標記跳過，零例外。</li>
        <li>多選題逐項判斷、判斷完立刻標 ✓✗，不整題重想。</li>
        <li>第二輪處理跳過題；<b>最後至少 15 分鐘只檢查不開新題</b>（名師標準是 20 分鐘——你的粗心失分就靠這段收回）。</li>
        <li>檢查順序：選填格式 → 簡單題 → 多選 → 計算最後一步。</li>
      </ol>
    </div>`;
}

/* ═══════════ ☁️ 雲端同步（Supabase） ═══════════
   離線優先：一切照常存 localStorage；登入後每次 save() 幾秒內自動上傳整包狀態，
   手寫筆跡逐題永久歸檔到 ink_sessions。只用 publishable key，資料由 RLS 保護。
   在封鎖外部連線的環境（claude.ai artifact）自動降級為純本機模式。 */
const SUPA_URL = 'https://jahqjaipeekkynpjjafw.supabase.co';
const SUPA_KEY = 'sb_publishable_0m8WTikRbOepsYSZjz0Epg_TkUiwLDu';
let supa = null;
let syncState = { user: null, msg: '', last: null };
let syncTimer = null;
function supaInit() {
  if (!window.supabase) { syncPill(); return; } // CDN 被擋（artifact 環境）→ 純本機模式
  supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
  autoLoginFromHash();
  supa.auth.onAuthStateChange((ev, session) => {
    const was = syncState.user && syncState.user.id;
    syncState.user = session ? session.user : null;
    if (syncState.user && syncState.user.id !== was) { syncPull(); probeContent(); }
    syncPill();
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
/* 裝置配對連結（免打字登入）：網址帶 #pair=… 時自動登入一次，成功後 session 存在該裝置並自動續期。
   新版 payload＝session 權杖（access+refresh，可在任一裝置登出即撤銷、access 會過期），取代舊版的明文帳密——
   避免書籤/截圖外洩＝永久帳密外洩。舊版 base64(email|密碼) 仍相容（過渡）。讀完先清網址，不落地、不上雲。 */
async function autoLoginFromHash() {
  const m = location.hash.match(/#pair=([A-Za-z0-9+/=_-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { data: s } = await supa.auth.getSession();
    if (s && s.session) { syncState.msg = '這台裝置已配對過'; syncPill(); return; }
    const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    let tok = null; try { tok = JSON.parse(raw); } catch (e) {}
    let error;
    if (tok && tok.r) { // 新版：session 權杖配對（可撤銷、會過期）
      ({ error } = await supa.auth.setSession({ access_token: tok.a || '', refresh_token: tok.r }));
    } else { // 舊版：base64(email|密碼)，過渡相容
      const i = raw.indexOf('|');
      if (i < 1) return;
      ({ error } = await supa.auth.signInWithPassword({ email: raw.slice(0, i), password: raw.slice(i + 1) }));
    }
    syncState.msg = error ? '配對連結登入失敗：' + error.message : '✅ 裝置配對完成，之後開頁自動同步';
    syncPill();
  } catch (e) {}
}
/* 產生本裝置的配對連結：帶 session 權杖（非密碼）。在另一台裝置貼進網址列即自動登入。 */
async function makePairLink() {
  if (!supa || !syncState.user) { alert('請先登入再產生配對連結'); return; }
  const { data } = await supa.auth.getSession();
  if (!data || !data.session) { alert('取不到目前的登入狀態，請重新登入後再試'); return; }
  const payload = btoa(JSON.stringify({ a: data.session.access_token, r: data.session.refresh_token })).replace(/\+/g, '-').replace(/\//g, '_');
  const url = location.origin + location.pathname + '#pair=' + payload;
  const note = '在另一台裝置把它貼進網址列開啟即自動登入。\n\n⚠️ 這條連結等同一次登入權杖——別外流。要作廢：在任一裝置按「登出」即撤銷所有配對連結。';
  try { await navigator.clipboard.writeText(url); alert('✅ 配對連結已複製。\n' + note); }
  catch (e) { prompt('複製這條配對連結：\n' + note, url); }
}
/* 同步狀態燈（常駐右上角）＋開始做題前的登入攔檢 */
function syncPill() {
  let el = $('#syncpill');
  if (!el) {
    el = el || document.createElement('div');
    el.id = 'syncpill';
    el.onclick = () => nav('stats');
    document.body.appendChild(el);
  }
  if (saveQuotaErr) { // 本機寫入失敗要看得見，不能無聲
    el.textContent = supa && syncState.user ? '🟡 本機存滿——雲端仍正常' : '🔴 本機存滿——資料存不下來！';
    el.className = supa && syncState.user ? 'mid' : 'warn';
    return;
  }
  if (!supa) { el.textContent = '⚫ 離線版（無法同步）'; el.className = 'off'; return; }
  if (!syncState.user) { el.textContent = '🔴 未登入——紀錄只存本機'; el.className = 'warn'; return; }
  el.textContent = syncState.pushErr ? '🟡 ' + syncState.msg : '🟢 ☁ ' + (syncState.msg || '已登入');
  el.className = syncState.pushErr ? 'mid' : 'ok';
}
let syncGateAsked = false; // 一個 session 只問一次：之後交給右下角常駐的 🔴 未登入角標，別每開一輪就彈一次
function syncGate() {
  // 回傳 true = 放行。沒登入時攔下來問，避免「做了題但沒上雲」而不自知。
  if (!supa || syncState.user || syncGateAsked) return true;
  syncGateAsked = true;
  if (confirm('⚠️ 尚未登入雲端同步！\n\n現在開始做題，紀錄只會存在這台裝置的瀏覽器裡——換裝置、清瀏覽器就沒了。\n\n按「確定」先去登入（推薦）\n按「取消」仍然開始（僅本機保存，這次不再提醒）')) {
    nav('stats');
    return false;
  }
  return true;
}
async function syncPush() {
  if (!supa || !syncState.user) return;
  try {
    const { error } = await supa.from('app_state')
      .upsert({ user_id: syncState.user.id, data: S, updated_at: new Date().toISOString() });
    syncState.pushErr = !!error;
    syncState.msg = error ? '上傳失敗：' + error.message : '已同步 ' + new Date().toTimeString().slice(0, 5);
    if (!error) flushInkQueue();
  } catch (e) { syncState.pushErr = true; syncState.msg = '離線（資料在本機，連上後自動補傳）'; }
  syncPill();
}
async function syncPull() {
  if (!supa || !syncState.user) return;
  try {
    const { data, error } = await supa.from('app_state').select('data').maybeSingle();
    if (error) { syncState.msg = '下載失敗：' + error.message; return; }
    if (data && data.data) {
      S = mergeState(S, data.data);
      if (splitOn()) await migrateContentFromS(); // 另一台舊裝置 merge 進來的內容 → 搬進內容層、S 保持輕
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { saveQuotaErr = true; }
      applyExtBank();
      syncState.msg = '已從雲端合併';
      updateBadge();
    }
    syncPush();
  } catch (e) { syncState.msg = '離線（資料在本機）'; syncPill(); }
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
  const emset = new Set((a.extMocks || []).map((m) => JSON.stringify(m)));
  const extMocks = [...(a.extMocks || [])];
  for (const m of b.extMocks || []) if (!emset.has(JSON.stringify(m))) extMocks.push(m);
  const daily = { ...(b.daily || {}) };
  for (const d of Object.keys(a.daily || {})) daily[d] = { ...(daily[d] || {}), ...a.daily[d] };
  // 🎯 類題支線紀錄：兩裝置聯集（以 ts 去重），別讓其中一方蓋掉另一方
  const spkey = (x) => `${x.ts}|${x.qid}`; // 含 qid，跟 attempts 一致：同毫秒兩台裝置的類題紀錄不塌成一筆
  const spset = new Set((a.sidePractice || []).map(spkey));
  const sidePractice = [...(a.sidePractice || [])];
  for (const x of b.sidePractice || []) if (!spset.has(spkey(x))) sidePractice.push(x);
  const merged = { ...b, ...a, attempts, wrong, drills, mocks, extMocks, daily, extbank, sidePractice };
  // 內容包（公式卡/重點整理）：兩裝置聯集、rev 大者勝
  if ((a.extflash || []).length || (b.extflash || []).length) merged.extflash = unionById(a.extflash, b.extflash);
  if ((a.extnotes || []).length || (b.extnotes || []).length) merged.extnotes = unionById(a.extnotes, b.extnotes);
  if (a.packOff || b.packOff) { // 逐 key 取時間戳較新的一方（舊格式 true 視為 ts=0）
    const norm = (v) => (v === true ? { off: true, ts: 0 } : v);
    const po = {};
    for (const k of new Set([...Object.keys(a.packOff || {}), ...Object.keys(b.packOff || {})])) {
      const A = norm((a.packOff || {})[k]), B = norm((b.packOff || {})[k]);
      po[k] = !A ? B : !B ? A : ((B.ts || 0) > (A.ts || 0) ? B : A);
    }
    merged.packOff = po;
  }
  // AI key：取「最後修改時間較新」的一方（避免舊裝置的舊 key 蓋掉新換的 key）
  if ((b.aikeyTs || 0) > (a.aikeyTs || 0)) { merged.aikey = b.aikey; merged.aikeyTs = b.aikeyTs; }
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
let inkQueue = []; // 上傳失敗的筆跡列，連上網或下次同步時補傳（上限 200 筆防爆記憶體）
function supaInkInsert(row) {
  supa.from('ink_sessions').insert(row).then(({ error }) => {
    if (error) {
      if (inkQueue.length < 200) inkQueue.push(row);
      syncState.msg = '筆跡上傳失敗（已排隊，連線後補傳）';
      syncPill();
    }
  });
}
function flushInkQueue() {
  if (!supa || !syncState.user || !inkQueue.length) return;
  const q = inkQueue; inkQueue = [];
  for (const row of q) supaInkInsert(row);
}
function syncInk(qid, t0, proc) {
  if (!supa || !syncState.user) return;
  const st = sessionInk[qid]; if (!st) return;
  // 完整書寫錄影進雲端：筆畫(s)＋塗改事件(e)，供後續 AI 統整分析（舊列的 q/a 欄位僅歷史資料殘留）
  const strokes = st.s.filter((s) => s.t0 >= t0);
  const eras = st.e.filter((t) => t >= t0);
  if (!strokes.length && !eras.length) return;
  supaInkInsert({ user_id: syncState.user.id, qid, t0, proc: proc || null, strokes: { s: strokes, e: eras } });
}
async function syncLogin(isSignup) {
  let email = $('#sy-email').value.trim();
  if (email && !email.includes('@')) email += '@gmail.com'; // 打帳號就好，自動補網域
  const pass = $('#sy-pass').value;
  if (!email || pass.length < 6) { syncState.msg = '帳號或密碼格式不對（密碼至少 6 碼）'; renderStats(); return; }
  syncState.msg = '處理中…'; renderStats();
  const { data, error } = isSignup
    ? await supa.auth.signUp({ email, password: pass })
    : await supa.auth.signInWithPassword({ email, password: pass });
  if (error) syncState.msg = (isSignup ? '註冊' : '登入') + '失敗：' + error.message;
  else if (isSignup && !data.session) syncState.msg = '註冊成功——去收信點確認連結後回來登入（或到 Supabase 後台 Auth 設定關掉 Confirm email）';
  else {
    syncState.msg = '登入成功，同步啟動';
    try { localStorage.setItem('mathA13_email', email); } catch (e) {}
  }
  renderStats();
}
async function syncLogout() {
  // scope:'local' = 只登出這台裝置——預設的 global 會把桌機/平板/手機全部一起踢掉
  await supa.auth.signOut({ scope: 'local' });
  syncState.msg = '';
  renderStats();
}
function syncPushNow() { syncState.msg = '上傳中…'; renderStats(); syncPush().then(() => renderStats()); }
function syncCard() {
  if (!supa) return `<div class="card"><h2>☁️ 雲端同步</h2>
    <p class="dim">這個網頁環境封鎖外部連線（claude.ai artifact），雲端同步自動停用——資料照常存本機，可用下方備份匯出。
    要用同步版請開本機版 index.html 或自架網址。</p></div>`;
  if (!syncState.user) return `<div class="card"><h2>☁️ 雲端同步</h2>
    <p class="dim">帳號打使用者名稱就好。</p>
    <input id="sy-email" class="ans-input" autocomplete="username" placeholder="帳號（不用打 @gmail.com）" value="${escH((() => { try { return (localStorage.getItem('mathA13_email') || '').replace(/@gmail\.com$/, ''); } catch (e) { return ''; } })())}">
    <input id="sy-pass" class="ans-input" type="password" autocomplete="current-password" placeholder="密碼（至少 6 碼）" onkeydown="if(event.key==='Enter')syncLogin(false)">
    <div class="actr">
      <button class="btn" onclick="syncLogin(true)">註冊</button>
      <button class="btn primary" onclick="syncLogin(false)">登入</button>
    </div>
    ${syncState.msg ? `<p class="dim">${syncState.msg}</p>` : ''}</div>`;
  return `<div class="card"><h2>☁️ 雲端同步 <span class="okc">已登入</span></h2>
    <p class="dim">${syncState.user.email}｜${syncState.msg || '自動同步中：每次做完題幾秒內上傳'}</p>
    <div class="actr"><button class="btn" onclick="syncLogout()">登出</button>
    <button class="btn" onclick="makePairLink()">📱 產生配對連結</button>
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
    `<button data-view="${v}" onclick="nav('${v}')">${VIEWS[v].label}</button>`).join('');
  if (!document.getElementById('day-counter')) { const dc = document.createElement('div'); dc.id = 'day-counter'; document.body.appendChild(dc); }
  renderDayCounter(); // 右上角常駐今日計數表
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // 爭取持久儲存：手寫是高優先資料，別讓瀏覽器在空間壓力下清掉
  await contentInit(); // 分家啟用時從 IndexedDB 載內容（毫秒級；未啟用是 no-op）
  applyExtBank();
  aiKeyMigrate();
  supaInit();
  nav('home');
  initMathObserver();
  // KaTeX 是 defer 載入，可能比 app.js 晚就緒：載到就補排一次
  if (!window.renderMathInElement) window.addEventListener('load', () => setTimeout(typesetMath, 50));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
