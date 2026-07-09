/* 數A 13級分特訓系統 — 核心邏輯
   設計原則：每一題都帶碼表、每一個錯都分類、用數據決定練什麼。 */
'use strict';

/* ═══════════ 狀態 ═══════════ */
const KEY = 'mathA13';
let S = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { attempts: [], wrong: {}, drills: {}, mocks: [], daily: {}, ver: 1 };
}
function save() { localStorage.setItem(KEY, JSON.stringify(S)); syncQueue(); }
function exportData() {
  const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mathA13-備份-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function unionById(a, b) {
  const out = [...(b || [])];
  const have = new Set(out.map((x) => x.id));
  for (const x of a || []) if (!have.has(x.id)) { out.push(x); have.add(x.id); }
  return out;
}
function applyExtBank() {
  if (!S.extbank || !Array.isArray(S.extbank)) return;
  const have = new Set(BANK.map((q) => q.id));
  for (const q of S.extbank) if (q && q.id && !have.has(q.id)) { BANK.push(q); have.add(q.id); }
}
function importData(input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d && Array.isArray(d.extbank) && !Array.isArray(d.attempts)) {
        // 題包檔：只併入外部題庫（如大考中心歷屆題），不動做題紀錄
        if (!confirm(`這是題包檔，含 ${d.extbank.length} 題${d.name ? '（' + d.name + '）' : ''}。併入後主題刷題與模擬會自動納入這些題目，確定？`)) return;
        S.extbank = unionById(d.extbank, S.extbank);
        save();
        alert(`已併入。外部題庫目前共 ${S.extbank.length} 題。`);
        location.reload();
        return;
      }
      if (!d || !Array.isArray(d.attempts)) { alert('這不是本系統的備份檔（缺 attempts 欄位）。'); return; }
      const cur = S.attempts.length;
      if (!confirm(`備份檔含 ${d.attempts.length} 筆作答紀錄、${Object.keys(d.wrong || {}).length} 題錯題。\n匯入會覆蓋目前這個瀏覽器裡的 ${cur} 筆紀錄，確定？`)) return;
      S = d; save(); location.reload();
    } catch (e) { alert('讀取失敗：' + e.message); }
  };
  r.readAsText(f);
  input.value = '';
}
function backupCard() {
  return `<div class="card"><h2>💾 資料備份</h2>
    <p class="dim"><b>登入雲端同步後，所有紀錄自動跨裝置同步</b>——做題紀錄、錯題本、筆跡、AI key，桌機/手機/平板拿到的都是同一份，
    這就是你的主要備份。下面的手動匯出是<b>額外保險</b>（雲端之外再留一份離線副本），不再是必要動作；
    只有「離線 artifact 版」或未登入時，資料才只存本機。</p>
    <div class="actr"><button class="btn" onclick="exportData()">匯出備份（.json）</button>
    <button class="btn" onclick="$('#impfile').click()">匯入備份</button>
    <button class="btn" onclick="exportInk()">匯出今日筆跡</button></div>
    <input type="file" id="impfile" accept=".json,application/json" style="display:none" onchange="importData(this)">
    <p class="dim">筆跡（手寫板的完整書寫過程）：<b>登入雲端同步時每題自動永久歸檔</b>，供 AI 後續統整分析你的運算習慣；未登入的話只存在本次頁面記憶體，關頁就消失——沒登入練完記得先匯出。</p>
  </div>`;
}

/* ═══════════ ✍️ 手寫過程紀錄（平板＋觸控筆） ═══════════
   三個書寫面：題目畫記(q)、計算區(s)、答案區(a)。每一筆帶時間戳與顏色。
   只認觸控筆與滑鼠——手掌/手指不會畫線、也不會誤觸捲動（兩指手勢才捲動）。
   自動偵測：起筆猶豫、題中停頓（≥15s）、塗改（復原）、尾段放棄（最後一筆到送出）。 */
const HES_GAP = 15000;
const INK_W = 1.35; // 筆跡粗細（原本 2 的 2/3）
const INK_COLORS = { k: '#1f2937', r: '#dc2626', g: '#15803d' };
let inkColor = 'k';
let ink = null;
let replaying = false;
const sessionInk = {}; // qid → { s:計算筆畫, e:塗改時間, q:題目畫記, a:答案區筆畫 }

function inkStore(qid) {
  const st = (sessionInk[qid] = sessionInk[qid] || { s: [], e: [] });
  st.q = st.q || []; st.a = st.a || [];
  return st;
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
  return `<div class="card ink-card">
    <div class="ink-bar"><b>✍️ 計算區</b>${inkToolsHTML()}</div>
    <div id="ink-flash" class="ink-flash" style="display:none"></div>
    <div class="ink-scroll"><canvas id="ink-cv" data-h="${small ? 240 : 0}"></canvas></div>
    <p class="dim ink-hint">觸控筆書寫（手掌不會誤觸）、兩指上下捲動；寫錯就劃掉或按復原。<b>最終答案寫在計算的最後（圈起來更好認）</b>——AI 會看完整過程、從結尾認答案。</p>
  </div>`;
}
function inkSurface(key, cv, h) {
  const sur = { key, cv, ctx: cv.getContext('2d'), h, cur: null, touches: new Map() };
  cv.onpointerdown = (e) => inkDown(e, sur);
  cv.onpointermove = (e) => inkMove(e, sur);
  cv.onpointerup = cv.onpointercancel = (e) => inkUp(e, sur);
  cv.oncontextmenu = (e) => e.preventDefault();
  return sur;
}
function inkArr(sur) {
  const st = inkStore(ink.qid);
  return sur.key === 'calc' ? st.s : sur.key === 'q' ? st.q : st.a;
}
function inkStart(qid, t0, since) {
  const cv = $('#ink-cv'); if (!cv) return;
  replaying = false; // 換題即解除回放鎖，避免上一題的回放把新題的筆鎖死
  const st = inkStore(qid);
  // 歸檔舊筆跡：同一題再次作答時不重現上次內容（模擬第二輪傳 sessT0 保留第一輪）
  const cut = since != null ? since : t0;
  for (const arr of [st.s, st.q, st.a]) for (const s of arr) if (!s.dead && !s.arch && s.t0 < cut) s.arch = 1;
  let maxY = 0;
  for (const s of st.s) if (!s.dead && !s.arch) for (const p of s.pts) if (p[1] > maxY) maxY = p[1];
  const base = +cv.dataset.h || 0;
  const h = base
    ? Math.max(base, Math.ceil(maxY + 80))
    : Math.max(340, Math.round(window.innerHeight * 0.45), Math.ceil(maxY + 80));
  ink = { qid, t0, penAt: 0, sur: {} };
  ink.sur.calc = inkSurface('calc', cv, h);
  const qcv = $('#qink-cv');
  if (qcv) ink.sur.q = inkSurface('q', qcv, 0);
  const acv = $('#ans-cv');
  if (acv) ink.sur.ans = inkSurface('ans', acv, 150);
  for (const k of Object.keys(ink.sur)) inkSizeSur(ink.sur[k]);
  inkColorSet(inkColor);
}
function inkSizeSur(sur) {
  const dpr = window.devicePixelRatio || 1;
  let w, h;
  if (sur.key === 'q') {
    const wrap = sur.cv.parentElement; // .qwrap（畫記層蓋在題目文字上）
    w = wrap.clientWidth; h = wrap.clientHeight;
  } else {
    w = sur.cv.parentElement.clientWidth; h = sur.h;
  }
  sur.cv.width = Math.max(1, Math.round(w * dpr));
  sur.cv.height = Math.max(1, Math.round(h * dpr));
  sur.cv.style.width = w + 'px'; sur.cv.style.height = h + 'px';
  sur.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sur.ctx.lineCap = 'round'; sur.ctx.lineJoin = 'round';
  inkRedraw(sur);
}
function inkExtend(dh) {
  if (!ink || !ink.sur.calc || ink.sur.calc.h >= 4000) return;
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
    // 手指/手掌：永不畫線。筆活躍（正在寫、或 0.8 秒內寫過）時手掌觸點完全忽略——不殺筆、不捲動。
    if (sur.cur || Date.now() - ink.penAt < 800) return;
    sur.touches.set(e.pointerId, e.clientY);
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
    if (!sur.touches.has(e.pointerId)) return;
    e.preventDefault();
    if (Date.now() - ink.penAt < 800) return; // 筆剛寫過：手掌移動不捲動
    const prev = sur.touches.get(e.pointerId);
    sur.touches.set(e.pointerId, e.clientY);
    if (sur.touches.size >= 2) {
      const dy = (e.clientY - prev) / sur.touches.size; // 每指各觸發一次，除以指數避免加倍
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
  if (sur.key === 'calc' && y > sur.h - 48) inkExtend(320);
}
function inkUp(e, sur) {
  if (!ink) return;
  if (e.pointerType === 'touch') { sur.touches.delete(e.pointerId); return; }
  if (!sur.cur) return;
  const cur = sur.cur; sur.cur = null;
  if (cur.pts.length > 1) { cur.t1 = Date.now(); inkArr(sur).push(cur); }
}
function inkUndo() {
  if (!ink) return;
  const st = inkStore(ink.qid);
  let best = null;
  for (const arr of [st.s, st.q, st.a]) {
    for (const s of arr) if (!s.dead && !s.arch && (!best || s.t0 > best.t0)) best = s;
  }
  if (!best) return;
  best.dead = Date.now();
  st.e.push(Date.now());
  inkRedrawAll();
}
function inkDrawStroke(ctx, s, w) {
  ctx.strokeStyle = INK_COLORS[s.c] || INK_COLORS.k;
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
  for (const k of Object.keys(ink.sur)) {
    const cv = ink.sur[k].cv;
    cv.onpointerdown = cv.onpointermove = cv.onpointerup = cv.onpointercancel = null;
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
/* 把某書寫面（'s'=計算區 / 'a'=答案區）輸出成裁切過的 PNG base64（給 AI 批改或縮圖） */
function inkCapture(qid, key, asDataURL) {
  const st = sessionInk[qid];
  if (!st) return null;
  const arr = ((key === 'a' ? st.a : st.s) || []).filter((s) => !s.dead && !s.arch);
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
  const url = cv.toDataURL('image/png');
  return asDataURL ? url : url.split(',')[1];
}
function inkSummary(p) {
  if (!p) return '';
  const longest = p.hes.length ? Math.max(...p.hes.map((h) => h[1])) : 0;
  return `<p class="dim">✍️ 過程：起筆 ${p.fi != null ? p.fi + 's' : '—'}｜題中停頓 ${p.hes.length} 次${longest ? `（最長 ${longest}s）` : ''}｜塗改 ${p.era} 次｜最後一筆到送出 ${p.tail != null ? p.tail + 's' : '—'}</p>`;
}
function mergeProc(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { fi: a.fi != null ? a.fi : b.fi, hes: a.hes.concat(b.hes).slice(0, 12), era: a.era + b.era, tail: b.tail != null ? b.tail : a.tail, n: a.n + b.n };
}
async function inkReplay(qid, t0) {
  const cv = $('#ink-cv'); if (!cv || replaying) return;
  replaying = true;
  const ctx = cv.getContext('2d');
  const st = inkStore(qid);
  const all = st.s.filter((s) => s.t0 >= t0);
  const evs = all.filter((s) => !s.sub).sort((a, b) => a.t0 - b.t0);
  const deaths = all.filter((s) => s.dead).map((s) => s.dead);
  const f = $('#ink-flash');
  const flash = (msg) => { if (f) { f.textContent = msg; f.style.display = 'block'; } };
  const unflash = () => { if (f) f.style.display = 'none'; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gone = () => !cv.isConnected; // 換頁/換題後舊 canvas 脫離 DOM → 中止回放（replaying 由 inkStart 重設）
  const aliveAt = (t) => all.filter((s) => s.t0 <= t && (!s.dead || s.dead > t));
  inkWipe(cv, ctx);
  let prevEnd = null;
  for (const s of evs) {
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
  replaying = false;
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
/* 稱讚引擎：只講真的——難題拿下、曾錯今對、比過去快。在 recordAttempt 之前呼叫。 */
function praiseFor(q, ok, ms, target) {
  if (!ok) return '';
  const past = attemptsOf(q.id);
  const msgs = [];
  if (past.some((a) => !a.ok)) msgs.push('這題你之前錯過，這次拿下了——這就是真實的進步');
  if (q.diff === 3) msgs.push('★★★ 難題，你把它算出來了');
  const bestMs = past.length ? Math.min(...past.map((a) => a.ms)) : null;
  if (bestMs && ms < bestMs) msgs.push(`比你過去最快的一次還快（${fmtSec(ms)} vs ${fmtSec(bestMs)}）`);
  if (!msgs.length && ms <= target) msgs.push(`在目標時間內完成（${fmtSec(ms)} ≤ ${fmtSec(target)}）`);
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
  alert('已儲存。登入同一帳號的每台裝置（桌機/手機/平板）都會自動拿到這支 key，記得按「測試連線」確認。');
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
  return `<div class="card"><h2>🤖 AI 批改設定</h2>
    <p class="dim">填入 API key 後：手寫答案按「算完了」就由 AI 即時批改——認你的字、判對錯（不限定答案順序與形式）、
    從計算過程指出<b>從哪一步開始算錯</b>、該稱讚時稱讚。<b>key 跟著雲端同步：任一台裝置填一次，桌機/手機/平板全部生效</b>。
    沒填也能用：改為「看正解自評」模式（一樣不用打字）。</p>
    <p class="dim">⚠️ <b>要用 platform.claude.com 建立的正式 API key（sk-ant-api03 開頭）</b>，且該帳號要在 Billing 儲值——
    Claude 訂閱（Pro/Max）的額度<b>不含</b> API。訂閱抓出來的 OAuth token（sk-ant-oat 開頭）雖可暫用，但幾小時就過期、且跟你的 Claude Code 共用限流，不建議。
    填完先按「測試連線」確認。（離線 artifact 版封鎖外連，AI 批改只在正式站可用）</p>
    <input id="aikey" class="ans-input" type="password" autocomplete="off" placeholder="sk-ant-api03-..." value="${aiKey() ? '••••••••（已設定）' : ''}">
    <p id="aitest-msg" class="dim"></p>
    <div class="actr">
      ${aiKey() ? '<button class="btn" onclick="aiKeyClear()">清除 key</button>' : ''}
      ${aiKey() ? '<button class="btn" onclick="aiTest()">測試連線</button>' : ''}
      <button class="btn primary" onclick="aiKeySave()">儲存</button>
    </div></div>`;
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escH(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// 放進 inline onclick 單引號字串裡的 id（extbank 題 id 來源不可控，要跳脫）
function jsA(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
async function aiGradeCall(q, correctTxt, calcB64) {
  const content = [];
  if (calcB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: calcB64 } });
  const teach = S.teach && S.teach[q.id];
  content.push({
    type: 'text',
    text: `你是嚴謹但溫暖的數學閱卷老師。以下是一位學測考生的完整手寫計算過程（單張圖）。
題目：${stripTags(q.q)}
正確答案：${correctTxt}
${q.sol ? `參考詳解：${stripTags(q.sol)}` : ''}
${teach && teach.sol ? `他補習班老師教這題的方法（指出錯誤或建議路線時優先對照這個教法）：${stripTags(teach.sol)}${teach.tip ? '｜老師口訣：' + stripTags(teach.tip) : ''}` : ''}
任務：
1. 辨識最終答案：考生會把答案寫在計算的末尾（可能圈起來或另起一行）；有多個候選時以最末、被圈選者為準。
2. 判定對錯：所有等價形式都算對——多根/多解順序不同（如「5,-1」vs「-1,5」）、分數/小數、未化簡但數值相等、有沒有寫 x= 都算對。但**座標/有序數對（如 (3,4)）順序不可交換**，題目明確要求特定形式時依題目。
3. 答錯時：對照計算過程，指出「從哪一步開始出錯」（引用他寫的式子），一句話講清楚錯在哪。
4. 答對時：從過程裡挑一個值得保留的好習慣具體稱讚；過程若有繞遠路或危險寫法也提醒一句。
只回傳 JSON（不要其他文字）：{"read":"辨識出的答案","correct":true或false,"firstError":"哪一步開始錯（答對時為 null）","praise":"具體稱讚（沒有就 null）","habit":"要注意的計算習慣（沒有就 null）"}`,
  });
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), 60000); // 60 秒沒回就放棄，退回自評
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
  return `<div class="ai-fb"><p><b>🤖 AI 批改：</b>讀到你的答案「<b>${v.read != null ? escH(v.read) : '—'}</b>」→ 判定 ${v.correct ? '<span class="okc">答對 ✔</span>' : '<span class="badc">答錯 ✘</span>'}</p>
    ${v.firstError ? `<p class="badc"><b>從這裡開始錯：</b>${escH(v.firstError)}</p>` : ''}
    ${v.praise ? `<p class="praise">🎉 ${escH(v.praise)}</p>` : ''}
    ${v.habit ? `<p class="warnc">✏️ 習慣提醒：${escH(v.habit)}</p>` : ''}</div>`;
}

/* ═══════════ 🧑‍🏫 老師方法庫（1662 條，Supabase teacher_methods 表） ═══════════
   概念洞 UI：答錯看詳解時、或錯題本頁，一鍵調出該單元老師的所有方法與口訣。
   雲端載一次後快取到本機（localStorage），之後離線也能看。 */
let METHODLIB = null;
const MLIB_LS = 'mathA13_mlib_v1';
async function loadMethodLib() {
  if (METHODLIB) return METHODLIB;
  try {
    const c = localStorage.getItem(MLIB_LS);
    if (c) { METHODLIB = JSON.parse(c); return METHODLIB; }
  } catch (e) {}
  if (!supa || !syncState.user) return null;
  try {
    const rows = [];
    for (let page = 0; page < 5; page++) { // 分頁抓（PostgREST 單次上限 1000）
      const { data, error } = await supa.from('teacher_methods')
        .select('unit,lec,concept,method,mnemonic,black,ex')
        .order('id').range(page * 1000, page * 1000 + 999);
      if (error || !data) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    if (!rows.length) return null;
    const lib = {};
    for (const m of rows) (lib[m.unit] = lib[m.unit] || []).push(m);
    METHODLIB = lib;
    try { localStorage.setItem(MLIB_LS, JSON.stringify(lib)); } catch (e) {}
    return lib;
  } catch (e) { return null; }
}
function mlibEmptyMsg() {
  if (!supa) return '離線版無法載入方法庫——請用正式站 yen-2cats.github.io/matha13。';
  if (!syncState.user) return '登入雲端同步後，才能載入老師方法庫。';
  return '方法庫資料還沒上雲（teacher_methods 表未建立或還沒灌資料）——跟接手的 Claude 說一聲就能補上。';
}
function mlibCard() {
  return `<div class="card"><h2>🧑‍🏫 老師方法庫</h2>
      <p class="dim">概念不熟（概念洞）就先調出該單元老師的方法與口訣，看懂再限時重做——1662 條，從 42 堂課逐字稿蒸餾。</p>
      <div class="chips r">${Object.keys(TOPICS).map((k) => `<button class="btn sm" onclick="showMethods('${k}')">${TOPICS[k]}</button>`).join('')}</div>
      <div id="mlib-box"></div></div>`;
}
async function showMethods(unit) {
  const box = $('#mlib-box');
  if (!box) return;
  box.innerHTML = '<p class="dim">🧑‍🏫 載入老師方法庫…</p>';
  const lib = await loadMethodLib();
  const cur = $('#mlib-box');
  if (!cur) return; // 載入期間已換頁
  if (!lib) { cur.innerHTML = `<p class="dim">${mlibEmptyMsg()}</p>`; return; }
  const ms = lib[unit] || [];
  if (!ms.length) { cur.innerHTML = `<p class="dim">「${TOPICS[unit]}」沒有對應的老師方法（課程未涵蓋這單元）。</p>`; return; }
  cur.innerHTML = `<div class="mlib">
    <p><b>🧑‍🏫 ${TOPICS[unit]}</b>｜老師方法 <b>${ms.length}</b> 條（42 堂課逐字稿蒸餾）——點開概念看他怎麼教：</p>
    ${ms.map((m) => `<details><summary>${escH(m.concept)}${m.ex ? ` <span class="dim">（${escH(m.ex)}）</span>` : ''}</summary>
      <p>${escH(m.method)}</p>
      ${m.mnemonic ? `<p class="teach-tip">🔑 ${escH(m.mnemonic)}</p>` : ''}
      ${m.black ? `<p class="dim">黑板答案：${escH(m.black)}</p>` : ''}</details>`).join('')}
  </div>`;
  cur.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
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
  const m = s.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]) / parseFloat(m[2]);
  const n = parseFloat(s);
  return /^-?\d+(?:\.\d+)?$/.test(s) ? n : NaN;
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
function bankById(id) { return BANK.find((q) => q.id === id); }
function teachProfileCard() {
  const p = S.teachProfile;
  if (!p) return '';
  const nEnrich = S.teach ? Object.keys(S.teach).length : 0;
  return `<div class="card teach-profile">
    <h2>🧑‍🏫 老師的教法（從 42 堂課蒸餾）</h2>
    <p class="dim">你買了整套課卻沒空上——系統把老師怎麼教吸收進來了。刷題時對得上的題（共 ${nEnrich} 題）會顯示「老師這樣教」；概念洞就用他的方法補。</p>
    <details><summary>他鋪陳觀念的固定順序</summary><p>${p.sequence || ''}</p></details>
    <details><summary>他反覆強調什麼</summary><p>${p.emphasis || ''}</p></details>
    <details><summary>語氣與比喻風格</summary><p>${p.voice || ''}</p></details>
    <details><summary>各單元他特別強調的重點</summary><p style="white-space:pre-wrap">${p.perUnitFocus || ''}</p></details>
    <p style="margin-top:8px"><b>標誌性口訣：</b></p>
    <div>${(p.catchphrases || []).map((c) => `<span class="cp">${c}</span>`).join('')}</div>
  </div>`;
}
function teachBlock(qid) {
  const t = S.teach && S.teach[qid];
  if (!t || !t.sol) return '';
  return `<div class="teach">
    <p><b>🧑‍🏫 老師這樣教：</b>${t.sol}</p>
    ${t.tip ? `<p class="teach-tip">🔑 ${t.tip}</p>` : ''}
    ${t.ba ? `<p class="dim">（黑板答案：${t.ba}）</p>` : ''}
  </div>`;
}

/* ═══════════ 計時器 ═══════════ */
let ticker = null;
function startTicker(fn) { stopTicker(); ticker = setInterval(fn, 250); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

/* ═══════════ 紀錄 ═══════════ */
function recordAttempt(q, ok, ms, err, mode, proc) {
  const rec = { qid: q.id, ok, ms, err: err || null, d: today(), mode, ts: Date.now() };
  if (proc) rec.p = proc;
  S.attempts.push(rec);
  if (!ok || err === '超時') {
    const w = S.wrong[q.id] || { fails: 0, wins: 0, itv: 0 };
    w.fails += ok ? 0 : 1;
    w.err = err || w.err || '概念不熟';
    w.itv = 1;
    w.due = addDays(today(), 1);
    S.wrong[q.id] = w;
  }
  save();
}
function reviewResult(qid, ok) {
  const w = S.wrong[qid];
  if (!w) return;
  if (ok) {
    w.wins += 1;
    const next = { 1: 3, 3: 7, 7: 14 }[w.itv] || 0;
    if (next === 0) { delete S.wrong[qid]; } // 畢業
    else { w.itv = next; w.due = addDays(today(), next); }
  } else {
    w.fails += 1; w.itv = 1; w.due = addDays(today(), 1);
  }
  save();
}
function dueWrong() {
  const t = today();
  return Object.keys(S.wrong).filter((id) => S.wrong[id].due <= t);
}

/* ═══════════ ▶ 今日菜單一鍵啟動 ═══════════
   自動排程：速度特訓（挑最該練的）→ 清到期錯題 → 主題刷題 8 題（挑最弱單元），
   每段完成自動打勾，不用自己對照清單、選單元、回頭打勾。 */
let dailyFlow = null;
function dailyPick() {
  // 挑最該練的特訓：沒練過 > 上次未達標 > 達標最久沒碰的
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
  return keys[0];
}
function startPracAuto() {
  // 自動挑最弱單元（答對率最低/耗時比最高），沒數據就全範圍
  const byTopic = {};
  for (const a of S.attempts) {
    const q = bankById(a.qid); if (!q) continue;
    const t = (byTopic[q.topic] = byTopic[q.topic] || { n: 0, ok: 0, ms: 0, target: 0 });
    t.n++; t.ok += a.ok ? 1 : 0; t.ms += a.ms; t.target += qTarget(q);
  }
  const worst = Object.keys(byTopic)
    .map((k) => ({ k, acc: byTopic[k].ok / byTopic[k].n, speed: byTopic[k].ms / byTopic[k].target }))
    .sort((a, b) => (a.acc - b.acc) || (b.speed - a.speed))
    .slice(0, 3).map((t) => t.k);
  let pool = worst.length ? BANK.filter((q) => worst.includes(q.topic)) : BANK.slice();
  if (pool.length < 8) pool = BANK.slice();
  pool = shuffle(pool).sort((a, b) => attemptsOf(a.id).length - attemptsOf(b.id).length);
  prac = { queue: pool.slice(0, 8), i: 0, results: [], mode: 'practice' };
  sessionActive = true;
  sessionMode = 'prac';
  snapSession();
  pracNext();
}
function startDaily() {
  dailyFlow = { stage: 0 };
  dailyNext();
}
function dailyNext() {
  if (!dailyFlow) return;
  const t = today();
  S.daily[t] = S.daily[t] || {};
  const st = dailyFlow.stage;
  if (st === 0) { dailyFlow.stage = 1; startDrill(dailyPick()); return; }
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
  const add = (d, n, ok, ms) => {
    if (!d) return;
    const x = (days[d] = days[d] || { n: 0, ok: 0, ms: 0 });
    x.n += n; x.ok += ok; x.ms += ms;
  };
  for (const a of S.attempts) add(a.d, 1, a.ok ? 1 : 0, a.ms || 0);
  for (const k of Object.keys(S.drills)) {
    for (const h of S.drills[k]) add(h.d, 12, Math.round(12 * (h.acc || 0) / 100), (h.med || 0) * 12);
  }
  if (S.phone && S.phone.days) {
    for (const d of Object.keys(S.phone.days)) { const p = S.phone.days[d]; add(d, p.n, p.ok, p.ms || 0); }
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
  const vals = ds.map((d) => (days[d] ? days[d].n : 0));
  const accs = ds.map((d) => (days[d] && days[d].n ? days[d].ok / days[d].n : null));
  const max = Math.max(10, ...vals);
  const W = 700, top = 18, bh = 104, axY = top + bh, accY = 158, accH = 42, H = 216;
  const bw = 34, gap = 16;
  const xc = (i) => i * (bw + gap) + gap / 2 + bw / 2;
  const maxIdx = vals.indexOf(Math.max(...vals));
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="近14天每日題數與答對率">`;
  s += `<text x="0" y="11" font-size="11" fill="var(--dim)">每日題數</text>`;
  s += `<line x1="0" y1="${axY}" x2="${W}" y2="${axY}" stroke="var(--border)"/>`;
  ds.forEach((d, i) => {
    const x = i * (bw + gap) + gap / 2;
    if (vals[i] > 0) {
      const h = Math.max(3, Math.round(bh * vals[i] / max));
      s += `<rect x="${x}" y="${axY - h}" width="${bw}" height="${h}" rx="4" fill="#0d9488"><title>${d}：${vals[i]} 題、答對率 ${accs[i] != null ? (accs[i] * 100).toFixed(0) + '%' : '—'}</title></rect>`;
      if (i === maxIdx || i === 13) s += `<text x="${xc(i)}" y="${axY - h - 5}" text-anchor="middle" font-size="12" fill="var(--dim)">${vals[i]}</text>`;
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
    if (prev) s += `<line x1="${prev[0]}" y1="${prev[1]}" x2="${x}" y2="${y}" stroke="#0d9488" stroke-width="2"/>`;
    prev = [x, y];
  });
  ds.forEach((d, i) => {
    if (accs[i] == null) return;
    const x = xc(i), y = accY + accH - accs[i] * accH;
    s += `<circle cx="${x}" cy="${y}" r="4" fill="#0d9488" stroke="#fff" stroke-width="2"><title>${d}：${(accs[i] * 100).toFixed(0)}%</title></circle>`;
  });
  s += '</svg>';
  return s;
}
const DAY_GOAL = 30; // 每日題數目標（速訓12＋錯題＋刷題8＋手機零碎 ≈ 30）
function dailyCard() {
  const days = dayAgg();
  if (!Object.keys(days).length) return '';
  const t = today();
  const tn = days[t] ? days[t].n : 0;
  const streak = streakOf(days);
  let w1 = 0, w0 = 0;
  for (let i = 0; i < 7; i++) { const a = days[addDays(t, -i)]; if (a) w1 += a.n; }
  for (let i = 7; i < 14; i++) { const a = days[addDays(t, -i)]; if (a) w0 += a.n; }
  const totalMin = Math.round(Object.values(days).reduce((x, y) => x + y.ms, 0) / 60000);
  const best = Object.entries(days).sort((a, b) => b[1].n - a[1].n)[0];
  const cheers = [];
  if (streak >= 3) cheers.push(`🔥 連續 <b>${streak}</b> 天有練——持續性比單日爆量更值錢`);
  if (best && best[0] === t && tn > 0 && Object.keys(days).length > 1) cheers.push(`🏆 今天是至今題量最高的一天（${tn} 題）`);
  if (w0 > 0 && w1 > w0) cheers.push(`📈 近 7 天 ${w1} 題，比前 7 天多 <b>${Math.round(100 * (w1 - w0) / w0)}%</b>`);
  else if (w0 > 0 && w1 > 0 && w1 < w0) cheers.push(`近 7 天 ${w1} 題、前 7 天 ${w0} 題——再 <b>${w0 - w1 + 1}</b> 題就超車自己`);
  return `<div class="card"><h2>📈 每日投入（近 14 天）</h2>
    <div class="today-row"><span>🔥 連續 <b>${streak}</b> 天</span><span>今日 <b>${tn}</b> / ${DAY_GOAL} 題</span><span class="dim">累計投入約 ${totalMin} 分鐘</span></div>
    <div class="goalbar"><div style="width:${Math.min(100, Math.round(100 * tn / DAY_GOAL))}%"></div></div>
    <div class="chartwrap">${dailyChartSVG(days)}</div>
    ${cheers.length ? `<div class="praise">${cheers.join('<br>')}</div>` : '<p class="dim">連續執行一兩週，這裡就會長出你的趨勢線——目標是讓長條圖不斷檔。</p>'}
  </div>`;
}
function todayCard() {
  const days = dayAgg();
  const t = today();
  const tn = days[t] ? days[t].n : 0;
  const streak = streakOf(days);
  return `<div class="card"><div class="today-row">
      <span>🔥 連續 <b>${streak}</b> 天｜今日 <b>${tn}</b> / ${DAY_GOAL} 題</span>
      <span class="shr"><button class="btn" onclick="nav('phone')">📱 手機專區</button>
      <button class="btn primary" onclick="startDaily()">▶ 一鍵開始今日菜單</button></span>
    </div>
    <div class="goalbar"><div style="width:${Math.min(100, Math.round(100 * tn / DAY_GOAL))}%"></div></div></div>`;
}

/* ═══════════ 導覽 ═══════════ */
const VIEWS = {
  home:  { label: '📋 診斷', fn: renderHome },
  phone: { label: '📱 手機專區', fn: renderPhone },
  drill: { label: '⚡ 速度特訓', fn: renderDrillMenu },
  prac:  { label: '🎯 主題刷題', fn: renderPracConfig },
  mock:  { label: '⏱️ 模擬實戰', fn: renderMockIntro },
  wrong: { label: '📓 錯題本', fn: renderWrong },
  stats: { label: '📊 數據', fn: renderStats },
  plan:  { label: '🗓️ 作戰計畫', fn: renderPlan },
};
let sessionActive = false;
let sessionMode = null; // 'prac' | 'review' | 'mock' | 'drill'
let sessSnap = null;    // 進場快照，用於「不保留紀錄」離開時復原
function snapSession() { sessSnap = { att: S.attempts.length, wrong: JSON.stringify(S.wrong) }; }
function rollbackSession() {
  if (!sessSnap) return;
  S.attempts.length = Math.min(S.attempts.length, sessSnap.att);
  S.wrong = JSON.parse(sessSnap.wrong);
  save();
}
function endSession() {
  sessionActive = false;
  sessionMode = null;
  dailyFlow = null; // 中途離開＝取消今日菜單接力
  stopTicker();
  if (ink) inkStop();
  if (drill && drill.nextTimer) { clearTimeout(drill.nextTimer); drill.nextTimer = null; }
  if (phone && phone.nextTimer) clearTimeout(phone.nextTimer);
  phone = null; // 手機專區進行中的輪次作廢
  qsess = null; // 讓遲到的 AI 批改回呼認得出「這一題已經結束了」
  sessionChrome(false);
  modalClose();
}
/* 中途退出：讓飼主自己選「已作答的要不要留紀錄」，不預設丟掉 */
function exitFlow(view) {
  const goto = view || 'home';
  if (!sessionActive) { nav(goto); return; }
  // 開著確認框的時間不算作答時間：按「繼續」時把計時起點往後平移
  const pausedAt = Date.now();
  const resume = () => {
    const d = Date.now() - pausedAt;
    if (sessionMode === 'mock' && mock) { mock.t0 += d; mock.tEnd += d; }
    else if (sessionMode === 'drill' && drill) drill.t0 += d;
    else if (qsess) qsess.t0 += d;
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
  // drill / 手機專區：整輪結果尚未寫入，離開即不保留本輪
  modal('<h2>要中途離開嗎？</h2><p>這一輪還沒結束，離開不會保留本輪成績。</p>', [
    ['繼續', resume, 'primary'],
    ['離開', () => { endSession(); nav(goto); }],
  ]);
}
function nav(view) {
  if (sessionActive) { exitFlow(view); return; }
  sessionMode = null;
  stopTicker();
  if (ink) inkStop();
  sessionChrome(false);
  document.querySelectorAll('nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  VIEWS[view].fn();
  updateBadge();
}
function updateBadge() {
  const n = dueWrong().length;
  const b = $('nav button[data-view="wrong"]');
  b.innerHTML = '📓 錯題本' + (n ? ` <span class="badge">${n}</span>` : '');
}

/* ═══════════ 首頁：診斷 ═══════════ */
function renderHome() {
  const days = Math.ceil((new Date(EXAM_DATE) - new Date()) / 86400000);
  const attempts = S.attempts.length;
  const mocks = S.mocks.length;
  let status;
  if (mocks === 0) {
    status = `<div class="card warn"><b>第一步：先做一次「模擬實戰」摸底。</b><br>
      你現在最缺的不是題目，是<b>數據</b>——先花 36 分鐘產生第一筆「每題耗時 × 錯因」紀錄，系統才知道你卡在哪。
      <div class="actr"><button class="btn primary" onclick="nav('mock')">開始摸底模擬 →</button></div></div>`;
  } else {
    const recent = S.attempts.slice(-30);
    const acc = recent.filter((a) => a.ok).length / recent.length;
    status = `<div class="card"><b>目前體感級分（近 30 題答對率 ${(acc * 100).toFixed(0)}%）：${gradeOf(acc)}</b><br>
      已累積 ${attempts} 筆做題紀錄、${mocks} 次模擬。到「📊 數據」看你的時間都被哪個單元吃掉。</div>`;
  }
  app().innerHTML = `
  <div class="hero">
    <h1>數A 13級分特訓系統</h1>
    <p>距離 116 學測（2027/1/22）還有 <b class="accent">${days} 天</b>｜目標：9 → 13 級分｜台大獸醫</p>
  </div>
  ${todayCard()}
  ${status}
  ${teachProfileCard()}
  <div class="card">
    <h2>你的問題在哪（診斷書）</h2>
    <p>「我會，但寫不完」＋ 兩次都停在 9 級分 ＋ 公式都背了 —— 這個組合指向的<b>不是知識缺口，是輸出速度與考試工程</b>：</p>
    <ol>
      <li><b>「會」的定義錯了。</b>線上課＋參考書是輸入型學習：看得懂解答、想得起來公式，會產生「熟悉感」。
        但學測要的是<b>多數題在 90～240 秒內獨立產出</b>（帳面平均 5 分鐘一題，扣掉檢查、讓難題超支後，基本與中等題就剩這個額度）。「看懂」到「限時寫出」中間差一整個訓練量，
        而你過去的讀書法幾乎沒有練到後者。這叫「熟練度錯覺」——不是比喻，是有實驗證據的效應：集中式練習後，
        學生對自己考試成績的預測被研究者形容為「嚴重過度自信」。它正是你兩次考出同樣分數的原因：輸入再多，輸出速度沒變。</li>
      <li><b>你沒有自己的耗時數據。</b>寫不完是「結果」，不是「原因」。真正的原因通常是：某 2~3 類題型你的單題耗時是別人的 2~3 倍
        （常見兇手：多選逐項判斷、條件機率長題幹、需要翻譯題意的應用題）。不量測就永遠不知道兇手是誰，
        只會籠統地覺得「時間不夠」。</li>
      <li><b>基本運算沒有自動化。</b>指對數化簡、特殊角三角值、配方、餘式——這些動作如果還要「想 3 秒」，
        工作記憶就被占滿，難題沒腦力、簡單題變慢。公式「背得出來」和「不經思考直接用」是兩個等級。</li>
      <li><b>缺考試工程：</b>沒有跳題紀律（90 秒無路線就跳）、沒有兩輪作答、沒有把「會的題 100% 拿到」當第一目標。
        9 級分的人常常不是難題不會，而是<b>會的題目只拿到七成</b>——超時、粗心、沒時間檢查。</li>
    </ol>
    <p><b>換算給你聽（113~115 官方對照表核實過）：</b>得分率約 50% ≈ 9 級分，三年皆成立。
    而 13 級分門檻其實只要 <b>69~74%</b>（113 年 74.0 分、114 年 73.5、115 年 68.7）——80 分在近兩年已經是 14 級分。
    所以目標線是<b>雙線制：73% 保底 13 級、80% 進攻 14 級</b>。你要補的 20~25 個百分點裡，
    相當大一部分不是「學新東西」，而是把<b>你已經會的題目的失分（超時未完成＋粗心）</b>收回來
    （這個佔比是本系統的估計，你的錯因數據會逐週驗證它）。這就是為什麼這個系統練的是速度與流程，不是再上一輪課。</p>
  </div>
  <div class="card">
    <h2>切角：四條訓練線</h2>
    <table class="tbl">
      <tr><th>訓練線</th><th>解決什麼</th><th>頻率</th></tr>
      <tr><td><b>⚡ 速度特訓</b><br>基本運算限時連發</td><td>把公式從「背得出」練到「反射」，釋放工作記憶</td><td>每天 10 分鐘（暖身）</td></tr>
      <tr><td><b>🎯 主題刷題</b><br>每題帶碼表＋錯因分類</td><td>找出吃時間的單元；「會但慢」的題現形</td><td>每天 30~40 分鐘</td></tr>
      <tr><td><b>⏱️ 模擬實戰</b><br>兩輪作答法訓練</td><td>跳題紀律、時間分配、先收會的分</td><td>每週 2 次</td></tr>
      <tr><td><b>📓 錯題本</b><br>間隔重測（1→3→7→14天）</td><td>錯過的題不再錯第二次；連對四次才畢業</td><td>每天 10 分鐘（到期題）</td></tr>
    </table>
    <p class="dim">內建題庫是自製訓練題，用來練「速度與流程」。進入 9~11 月後，主戰場換成大考中心的<b>歷屆試題</b>（108 課綱後的數A卷），本系統的模擬實戰改為輔助維持手感。</p>
  </div>`;
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
  tri: { name: '三角函數值', desc: '特殊角 sin/cos/tan，看到就要有答案', target: 12,
    gen() {
      const fn = pick(['sin', 'cos', 'tan']);
      const angles = Object.keys(TRI_VAL[fn]).map(Number);
      const a = pick(angles);
      const correct = TRI_VAL[fn][a];
      const pool = [...new Set(Object.values(TRI_VAL[fn]))].filter((v) => v !== correct);
      const opts = shuffle([correct, ...shuffle(pool).slice(0, 3)]);
      return { q: `${fn} ${a}° = ?`, kind: 'opts', opts, ans: opts.indexOf(correct) };
    } },
  logexp: { name: '指對數速算', desc: 'log 與分數指數，目標 15 秒內', target: 15,
    gen() {
      const t = rint(1, 3);
      if (t === 1) { const b = pick([2, 3, 5]); const k = rint(2, 5); return { q: `log<sub>${b}</sub>(${b ** k}) = ?`, kind: 'num', ans: String(k) }; }
      if (t === 2) { const p = pick(POWERS); return { q: `${p[0]}<sup>${p[1]}</sup> = ?`, kind: 'num', ans: String(p[2]) }; }
      const x = rint(2, 4), y = rint(2, 4);
      return pick([
        { q: `2<sup>${x}</sup> × 2<sup>${y}</sup> = 2<sup>?</sup>`, kind: 'num', ans: String(x + y) },
        { q: `(2<sup>${x}</sup>)<sup>${y}</sup> = 2<sup>?</sup>`, kind: 'num', ans: String(x * y) },
      ]);
    } },
  quad: { name: '二次函數最小值', desc: 'y = x²+bx+c 直接讀出最小值', target: 25,
    gen() {
      const b = pick([-8, -6, -4, -2, 2, 4, 6, 8]); const c = rint(-9, 9);
      const min = c - (b * b) / 4;
      return { q: `y = x² ${b < 0 ? '−' : '+'} ${Math.abs(b)}x ${c < 0 ? '−' : '+'} ${Math.abs(c)} 的最小值 = ?`, kind: 'num', ans: String(min) };
    } },
  rem: { name: '餘式定理', desc: 'f(x) 除以 (x−k)，答案就是 f(k)', target: 25,
    gen() {
      const a = rint(1, 3), b = rint(-5, 5), c = rint(-5, 5);
      const k = pick([-3, -2, -1, 1, 2, 3]);
      const val = a * k * k + b * k + c;
      const bs = b === 0 ? '' : ` ${b < 0 ? '−' : '+'} ${Math.abs(b)}x`;
      const cs = c === 0 ? '' : ` ${c < 0 ? '−' : '+'} ${Math.abs(c)}`;
      return { q: `${a === 1 ? '' : a}x²${bs}${cs} 除以 (x ${k < 0 ? '+' : '−'} ${Math.abs(k)}) 的餘式 = ?`, kind: 'num', ans: String(val) };
    } },
  cnk: { name: 'C 與 P 速算', desc: '組合數/排列數小數字，考場不許卡', target: 20,
    gen() {
      if (Math.random() < 0.6) {
        const n = rint(5, 10), k = rint(2, 4);
        let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1);
        return { q: `C(${n}, ${k}) = ?`, kind: 'num', ans: String(Math.round(v)) };
      }
      const n = rint(4, 8), k = rint(2, 3);
      let v = 1; for (let i = 0; i < k; i++) v *= (n - i);
      return { q: `P(${n}, ${k}) = ?`, kind: 'num', ans: String(v) };
    } },
  dot: { name: '向量內積與長度', desc: '內積、畢氏長度，全部心算', target: 15,
    gen() {
      if (Math.random() < 0.7) {
        const v = [rint(-6, 6), rint(-6, 6), rint(-6, 6), rint(-6, 6)];
        return { q: `(${v[0]}, ${v[1]}) · (${v[2]}, ${v[3]}) = ?`, kind: 'num', ans: String(v[0] * v[2] + v[1] * v[3]) };
      }
      const p = pick(PYTH);
      return { q: `|(${p[0]}, ${p[1]})| = ?`, kind: 'num', ans: String(p[2]) };
    } },
  seqd: { name: '等差等比速算', desc: '第 n 項與求和公式即代即出', target: 20,
    gen() {
      const t = rint(1, 3);
      if (t === 1) { const a = rint(-5, 5), d = rint(2, 6), n = rint(5, 12); return { q: `等差：a₁=${a}、d=${d}，a${String(n).split('').map(c=>'₀₁₂₃₄₅₆₇₈₉'[+c]).join('')} = ?`, kind: 'num', ans: String(a + (n - 1) * d) }; }
      if (t === 2) { const a = rint(1, 3), r = pick([2, 3]), n = rint(3, 6); return { q: `等比：a₁=${a}、r=${r}，第 ${n} 項 = ?`, kind: 'num', ans: String(a * r ** (n - 1)) }; }
      const n = rint(5, 15);
      return { q: `1 + 2 + … + ${n} = ?`, kind: 'num', ans: String(n * (n + 1) / 2) };
    } },
  mul: { name: '兩位數心算', desc: '乘法與平方——計算慢，全卷都慢', target: 25,
    gen() {
      if (Math.random() < 0.5) { const a = rint(12, 29), b = rint(11, 19); return { q: `${a} × ${b} = ?`, kind: 'num', ans: String(a * b) }; }
      const a = rint(11, 25);
      return { q: `${a}² = ?`, kind: 'num', ans: String(a * a) };
    } },
  quadroot: { name: '解一元二次', desc: '十字交乘直接報兩根——全卷最高頻的機械步驟（近5年約10題用到）', target: 20,
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
  frac: { name: '分數四則', desc: '機率、期望值的隱形時間殺手兼粗心大戶——答案一律最簡分數', target: 15,
    gen() {
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const red = (p, q) => {
        if (q < 0) { p = -p; q = -q; }
        const d = gcd(Math.abs(p), q) || 1;
        p /= d; q /= d;
        return q === 1 ? String(p) : `${p}/${q}`;
      };
      const t = rint(1, 4);
      const a = rint(1, 9), b = rint(2, 9), c = rint(1, 9), d = rint(2, 9);
      if (t === 1) {
        const plus = Math.random() < 0.5;
        return { q: `${a}/${b} ${plus ? '+' : '−'} ${c}/${d} = ?（最簡分數）`, kind: 'num', ans: red(plus ? a * d + c * b : a * d - c * b, b * d) };
      }
      if (t === 2) return { q: `${a}/${b} × ${c}/${d} = ?（最簡分數）`, kind: 'num', ans: red(a * c, b * d) };
      if (t === 3) return { q: `(${a}/${b}) ÷ (${c}/${d}) = ?（最簡分數）`, kind: 'num', ans: red(a * d, b * c) };
      const k = rint(2, 6), p = rint(2, 9), q2 = rint(p + 1, 12);
      return { q: `約分到最簡：${p * k}/${q2 * k} = ?`, kind: 'num', ans: red(p, q2) };
    } },
  root: { name: '根式化簡', desc: '√48 要一眼變 4√3——所有距離、長度計算的收尾動作', target: 12,
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
        return { q: `有理化：${tt * b}/√${b} = ?`, opts, ans: opts.indexOf(right) };
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
      const [x, y, right, wrongs] = pick(cases);
      const opts = shuffle([right, ...wrongs]);
      return { q: `√(${x}² + ${y}²) = ?（距離計算的收尾）`, opts, ans: opts.indexOf(right) };
    } },
  mat2: { name: '2×2 矩陣速算', desc: 'det、面積、矩陣作用——112 起連三年必考的新主角', target: 18,
    gen() {
      const t = rint(1, 3);
      for (let tries = 0; tries < 8; tries++) {
        const a = rint(-6, 6), b = rint(-6, 6), c = rint(-6, 6), d = rint(-6, 6);
        if (t === 1) return { q: `二階行列式：第一列 (${a}, ${b})、第二列 (${c}, ${d})，ad−bc = ?`, kind: 'num', ans: String(a * d - b * c) };
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
        return { q: `矩陣 A：第一列 (${a}, ${b})、第二列 (${c}, ${d})。A 作用在向量 (${x}, ${y}) 的結果 = ?`, opts: sh, ans: sh.indexOf(right) };
      }
      return { q: `二階行列式：第一列 (2, 3)、第二列 (1, 4)，ad−bc = ?`, kind: 'num', ans: '5' };
    } },
};

/* ═══════════ 📱 手機專區 ═══════════
   零碎時間、單手、全按鈕作答（不手寫不打字）。內容＝學測數A該背/該心算的：
   公式、定理、幾何原則、特殊值＋老師 42 堂課強調的口訣。紀錄存 S.phone → 雲端同步。 */
const FLASH = [
  // 數與式/多項式
  { id: 'f1', unit: 'num', front: '算幾不等式', back: '(a+b)/2 ≥ √(ab)（a,b>0；等號成立 ⇔ a=b）' },
  { id: 'f2', unit: 'num', front: '|x−a| < r 拆開來是？', back: 'a−r < x < a+r（絕對值＝到 a 的距離小於 r）' },
  { id: 'f3', unit: 'num', front: '和/差的立方公式 a³±b³', back: 'a³±b³ = (a±b)(a²∓ab+b²)' },
  { id: 'f4', unit: 'poly', front: '根與係數（ax²+bx+c=0）', back: '兩根和 = −b/a、兩根積 = c/a' },
  { id: 'f5', unit: 'poly', front: '判別式判根', back: 'b²−4ac：>0 兩相異實根、=0 重根、<0 無實根' },
  { id: 'f6', unit: 'poly', front: '拋物線 y=ax²+bx+c 的頂點 x 座標', back: 'x = −b/(2a)（最大/最小值發生處）' },
  { id: 'f7', unit: 'poly', front: '餘式定理', back: 'f(x) 除以 (x−a) 的餘式 = f(a)' },
  { id: 'f8', unit: 'poly', front: '因式定理', back: 'f(a) = 0 ⇔ (x−a) 是 f(x) 的因式' },
  // 直線與圓
  { id: 'f9', unit: 'line', front: '點 (x₀,y₀) 到直線 ax+by+c=0 的距離', back: '|ax₀+by₀+c| / √(a²+b²)' },
  { id: 'f10', unit: 'line', front: '兩直線垂直的斜率條件', back: 'm₁·m₂ = −1（平行則 m₁ = m₂）' },
  { id: 'f11', unit: 'line', front: '圓 x²+y²+dx+ey+f=0 的圓心', back: '(−d/2, −e/2)，半徑 = √(d²/4+e²/4−f)' },
  { id: 'f12', unit: 'line', front: '直線與圓的位置關係怎麼判？', back: '比圓心到直線距離 d 與半徑 r：d<r 交兩點、d=r 相切、d>r 不相交' },
  { id: 'f13', unit: 'line', front: '圓外一點的切線長', back: '√(d²−r²)（d=點到圓心距離）' },
  { id: 'f14', unit: 'line', front: '三角形的外心／內心／重心是什麼線的交點？', back: '外心＝中垂線交點（到三頂點等距）；內心＝角平分線交點（到三邊等距）；重心＝中線交點（分中線 2:1）' },
  // 指對數
  { id: 'f15', unit: 'exp', front: '指數律三條', back: 'aᵐ·aⁿ = aᵐ⁺ⁿ；(aᵐ)ⁿ = aᵐⁿ；aᵐ/aⁿ = aᵐ⁻ⁿ' },
  { id: 'f16', unit: 'exp', front: '對數律三條', back: 'log(ab)=log a+log b；log(a/b)=log a−log b；log aⁿ = n·log a' },
  { id: 'f17', unit: 'exp', front: '換底公式', back: 'log_a b = log b / log a（任何新底都行）；log_a b · log_b a = 1' },
  { id: 'f18', unit: 'exp', front: '正整數 N 的位數', back: '位數 = ⌊log₁₀N⌋ + 1' },
  { id: 'f19', unit: 'exp', front: 'y=aˣ 與 y=log_a x 必過的點', back: 'aˣ 過 (0,1)；log_a x 過 (1,0)；兩圖形對 y=x 對稱' },
  // 數列級數
  { id: 'f20', unit: 'seq', front: '等差數列 aₙ 與前 n 項和', back: 'aₙ = a₁+(n−1)d；Sₙ = n(a₁+aₙ)/2' },
  { id: 'f21', unit: 'seq', front: '等比數列 aₙ 與前 n 項和', back: 'aₙ = a₁·rⁿ⁻¹；Sₙ = a₁(1−rⁿ)/(1−r)（r≠1）' },
  { id: 'f22', unit: 'seq', front: '1+2+…+n 與 1²+2²+…+n²', back: 'n(n+1)/2；n(n+1)(2n+1)/6' },
  { id: 'f23', unit: 'seq', front: '無窮等比級數和（|r|<1）', back: 'a₁/(1−r)' },
  // 排列組合
  { id: 'f24', unit: 'comb', front: 'C(n,k) 與 P(n,k) 的公式', back: 'C(n,k)=n!/(k!(n−k)!)；P(n,k)=n!/(n−k)!；C(n,k)=C(n,n−k)' },
  { id: 'f25', unit: 'comb', front: '環狀排列', back: 'n 人圍圓桌 = (n−1)!' },
  { id: 'f26', unit: 'comb', front: '重複組合 H', back: 'H(n,k) = C(n+k−1, k)（n 類選 k 個可重複）' },
  { id: 'f27', unit: 'comb', front: '二項式定理的一般項', back: '(x+y)ⁿ 的一般項 = C(n,k)·xⁿ⁻ᵏ·yᵏ' },
  { id: 'f28', unit: 'comb', front: '取捨原理（兩集合）', back: '|A∪B| = |A|+|B|−|A∩B|' },
  // 機率統計
  { id: 'f29', unit: 'prob', front: '條件機率', back: 'P(A|B) = P(A∩B)/P(B)' },
  { id: 'f30', unit: 'prob', front: '獨立事件的判定', back: 'A、B 獨立 ⇔ P(A∩B) = P(A)·P(B)' },
  { id: 'f31', unit: 'prob', front: '期望值', back: 'E = Σ（值 × 機率）' },
  { id: 'f32', unit: 'data', front: '資料全部做 ax+b 變換後，平均與標準差？', back: '平均 → aμ+b；標準差 → |a|σ（平移不改變標準差）' },
  { id: 'f33', unit: 'data', front: '相關係數 r 的範圍與迴歸直線必過點', back: '−1 ≤ r ≤ 1；迴歸直線必過 (x̄, ȳ)' },
  // 三角
  { id: 'f34', unit: 'trig1', front: 'sin/cos/tan 30°、45°、60°', back: 'sin: 1/2、√2/2、√3/2｜cos: √3/2、√2/2、1/2｜tan: √3/3、1、√3' },
  { id: 'f35', unit: 'trig1', front: '平方關係與商數關係', back: 'sin²θ+cos²θ=1；tanθ = sinθ/cosθ' },
  { id: 'f36', unit: 'trig1', front: '正弦定理', back: 'a/sinA = b/sinB = c/sinC = 2R（R=外接圓半徑）' },
  { id: 'f37', unit: 'trig1', front: '餘弦定理', back: 'c² = a²+b²−2ab·cosC（求邊）；cosC = (a²+b²−c²)/2ab（求角）' },
  { id: 'f38', unit: 'trig1', front: '三角形面積（兩邊夾角）與海龍公式', back: '面積 = (1/2)ab·sinC；海龍 = √(s(s−a)(s−b)(s−c))，s=半周長' },
  { id: 'f39', unit: 'trig1', front: 'sin(180°−θ)、cos(180°−θ)', back: 'sin(180°−θ)=sinθ；cos(180°−θ)=−cosθ（補角）' },
  { id: 'f40', unit: 'trig2', front: '和角公式 sin(A±B)、cos(A±B)', back: 'sin(A±B)=sinAcosB±cosAsinB；cos(A±B)=cosAcosB∓sinAsinB（cos 符號相反）' },
  { id: 'f41', unit: 'trig2', front: '倍角公式', back: 'sin2θ=2sinθcosθ；cos2θ=cos²θ−sin²θ=2cos²θ−1=1−2sin²θ' },
  { id: 'f42', unit: 'trig2', front: '疊合 a·sinθ + b·cosθ', back: '= √(a²+b²)·sin(θ+φ)，最大值 √(a²+b²)、最小值 −√(a²+b²)' },
  { id: 'f43', unit: 'trig2', front: 'y = sin(bx) 的週期', back: '2π/|b|（tan 的週期是 π/|b|）' },
  // 平面向量
  { id: 'f44', unit: 'vec', front: '內積的兩種算法', back: 'a·b = |a||b|cosθ = x₁x₂+y₁y₂' },
  { id: 'f45', unit: 'vec', front: '向量垂直與平行的判定', back: '垂直 ⇔ 內積=0；平行 ⇔ x₁y₂−x₂y₁=0' },
  { id: 'f46', unit: 'vec', front: '正射影向量', back: 'a 在 b 上的正射影 = (a·b/|b|²)·b；長度 = |a·b|/|b|' },
  { id: 'f47', unit: 'vec', front: '兩向量張出的三角形面積', back: '(1/2)|x₁y₂−x₂y₁|（平行四邊形不除 2）' },
  { id: 'f48', unit: 'vec', front: '分點公式（AP:PB = m:n）', back: 'P = (n·A + m·B)/(m+n)——靠近誰，誰的權重反而小' },
  { id: 'f49', unit: 'vec', front: '三角形重心（向量）', back: 'G = (A+B+C)/3' },
  { id: 'f50', unit: 'vec', front: '柯西不等式（二維）', back: '(a²+b²)(c²+d²) ≥ (ac+bd)²；等號 ⇔ ad=bc（平行時）' },
  // 空間
  { id: 'f51', unit: 'svec', front: '空間兩點距離', back: '√(Δx²+Δy²+Δz²)' },
  { id: 'f52', unit: 'svec', front: '外積的幾何意義', back: '|a×b| = 兩向量張出的平行四邊形面積；方向依右手定則、同時垂直 a 與 b' },
  { id: 'f53', unit: 'splane', front: '平面 ax+by+cz=d 的法向量', back: '(a, b, c)——係數直接讀' },
  { id: 'f54', unit: 'splane', front: '點到平面距離', back: '|ax₀+by₀+cz₀−d| / √(a²+b²+c²)' },
  { id: 'f55', unit: 'splane', front: '兩平面的夾角', back: '＝兩法向量的夾角（取銳角）；平行 ⇔ 法向量平行' },
  { id: 'f56', unit: 'svec', front: '三垂線定理', back: '平面外一點的斜線在平面上的投影若垂直平面內某直線，則斜線本身也垂直該直線（垂直投影 ⇒ 垂直斜線）' },
  // 矩陣
  { id: 'f57', unit: 'mat', front: '二階行列式與面積放大率', back: 'det = ad−bc；線性變換把面積放大 |det| 倍' },
  { id: 'f58', unit: 'mat', front: '二階反矩陣', back: '(1/(ad−bc))·[d −b; −c a]——主對角線互換、副對角線變號' },
  { id: 'f59', unit: 'mat', front: '旋轉 θ 的矩陣', back: '[cosθ −sinθ; sinθ cosθ]' },
  { id: 'f60', unit: 'mat', front: '轉移矩陣的特徵', back: '每一行（欄）的和 = 1、元素皆 ≥0；穩定狀態＝乘再多次也不變的分布' },
  // 幾何原則
  { id: 'f61', unit: 'line', front: '平行四邊形對角線性質', back: '互相平分（交點是兩對角線中點）' },
  { id: 'f62', unit: 'line', front: '三角形兩邊中點連線', back: '平行第三邊、長度是第三邊的一半' },
  { id: 'f63', unit: 'prob', front: '至少一次的機率', back: 'P(至少一次) = 1 − P(一次都沒有)——「至少」先想補集' },
  { id: 'f64', unit: 'num', front: '√a·√b 與 √(a²b) 的化簡', back: '√48 = √(16·3) = 4√3——先抓最大平方因數' },
  { id: 'f65', unit: 'exp', front: '2¹⁰ ≈ ?（常用近似）', back: '2¹⁰ = 1024 ≈ 10³；log₁₀2 ≈ 0.3010、log₁₀3 ≈ 0.4771' },
  { id: 'f66', unit: 'data', front: '中位數/四分位數要先做什麼？', back: '先排序！Q1、Q3 分別是前半、後半的中位數；IQR = Q3−Q1' },
];

/* 把數值答案的生成題自動變成 4 選 1（手機純按鈕用） */
function optionize(it) {
  if (it.opts) return { q: it.q, opts: it.opts, ans: it.ans };
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
  return { q: it.q, opts, ans: opts.indexOf(s) };
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
    <p class="dim">通勤、排隊、零碎時間用：全程<b>按鈕作答</b>——不手寫、不打字、單手就能練。
    內容鎖定學測數A「該背得出來、該心算得出來」的公式、定理、幾何原則、特殊值，以及老師 42 堂課強調要背的口訣。紀錄一樣自動上雲。</p>
    <div class="grid">
      <div class="card drill-card"><b>⚡ 心算快答</b>
        <p class="dim">特殊角、指對數、二次頂點、C/P、內積、行列式、根式化簡……12 題連發、4 選 1。</p>
        <button class="btn primary" onclick="startPhoneQuiz()">開始 12 題</button></div>
      <div class="card drill-card"><b>🧠 公式必背卡</b>
        <p class="dim">學測範圍必背公式／定理／幾何原則（${FLASH.length} 張）：看題面→翻面→按「記得/忘了」。忘過的卡會更常出現。</p>
        <button class="btn primary" onclick="startPhoneFlash('formula')">抽 10 張</button></div>
      <div class="card drill-card"><b>🧑‍🏫 老師口訣卡</b>
        <p class="dim">42 堂課蒸餾的口訣（1500+ 條）——老師上課強調該背的都在這。第一次要登入載入。</p>
        <button class="btn primary" onclick="startPhoneFlash('mn')">抽 10 張</button></div>
    </div>
    ${p ? `<div class="card"><p>📅 今日手機練：<b>${p.n}</b> 題/卡｜答對/記得 <b>${p.ok}</b>（${p.n ? Math.round(100 * p.ok / p.n) : 0}%）</p></div>` : ''}
    ${hist.length ? `<div class="card"><h2>近幾輪</h2><table class="tbl"><tr><th>日期</th><th>模式</th><th>成績</th></tr>
      ${hist.map((h) => `<tr><td>${h.d}</td><td>${h.mode === 'quiz' ? '⚡ 心算' : h.mode === 'mn' ? '🧑‍🏫 口訣' : '🧠 公式'}</td><td>${h.ok}/${h.n}</td></tr>`).reverse().join('')}</table></div>` : ''}`;
}
let phone = null;
function startPhoneQuiz() {
  if (!syncGate()) return;
  phone = { mode: 'quiz', items: [], i: 0, ok: 0, t0: 0, results: [], tapped: false };
  const keys = ['tri', 'logexp', 'quad', 'rem', 'cnk', 'dot', 'seqd', 'mul', 'root', 'mat2', 'frac'];
  let guard = 0;
  while (phone.items.length < 12 && guard++ < 100) {
    const k = pick(keys);
    const o = optionize(DRILLS[k].gen());
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
      <span class="shr"><span id="ptimer" class="timer">0.0s</span>
      <button class="btn sm xbtn" onclick="exitFlow()">✕</button></span></div>
    <div class="card qcard"><div class="qtext big">${it.q}</div>
      <div class="pbtns">${it.opts.map((o, i) => `<button class="btn pbtn" onclick="phoneTap(${i})">${o}</button>`).join('')}</div>
      <div id="pfb"></div></div>
    <p class="dim" style="text-align:center">${it.src}｜全按鈕作答</p>`;
  sessionChrome(true);
  startTicker(() => { const t = $('#ptimer'); if (t) t.textContent = ((Date.now() - phone.t0) / 1000).toFixed(1) + 's'; });
}
function phoneTap(idx) {
  if (!phone || phone.tapped) return;
  phone.tapped = true;
  stopTicker();
  const it = phone.items[phone.i];
  const ms = Date.now() - phone.t0;
  const ok = idx === it.ans;
  phone.results.push({ ok, ms });
  if (ok) phone.ok++;
  phoneLog(ok, ms);
  document.querySelectorAll('.pbtn').forEach((b, i) => {
    b.disabled = true;
    if (i === it.ans) b.classList.add('good');
    else if (i === idx) b.classList.add('badpick');
  });
  const fb = $('#pfb');
  if (ok) {
    fb.innerHTML = `<p class="ok">✔（${(ms / 1000).toFixed(1)}s）</p>`;
    phone.nextTimer = setTimeout(() => { if (phone && sessionMode === 'phone') { phone.i++; phoneQuizNext(); } }, 450);
  } else {
    fb.innerHTML = `<p class="bad">✘ 正解：<b>${it.opts[it.ans]}</b></p>
      <div class="actr"><button class="btn primary" onclick="phone.i++;phoneQuizNext()">下一題</button></div>`;
  }
}
function phoneQuizDone() {
  sessionActive = false; sessionMode = null; sessionChrome(false);
  const n = phone.results.length;
  const med = median(phone.results.map((r) => r.ms));
  S.phone.hist.push({ d: today(), mode: 'quiz', n, ok: phone.ok });
  if (S.phone.hist.length > 200) S.phone.hist = S.phone.hist.slice(-200);
  save();
  const acc = n ? Math.round(100 * phone.ok / n) : 0;
  app().innerHTML = `<h1>心算快答 — 結果</h1>
    <div class="card ${acc === 100 ? 'good' : ''}">
      <p class="big">答對 <b>${phone.ok} / ${n}</b>（${acc}%）｜中位數 <b>${(med / 1000).toFixed(1)}s</b></p>
      ${acc === 100 ? '<p class="praise">🎉 全對——這些基本運算正在變成反射！</p>' : acc >= 80 ? '<p class="praise">🎉 手感不錯，錯的那幾題就是還沒自動化的位置。</p>' : ''}
      <div class="actr"><button class="btn" onclick="nav('phone')">回手機專區</button>
      <button class="btn primary" onclick="startPhoneQuiz()">再來 12 題</button></div>
    </div>`;
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
  if (kind === 'formula') { go(FLASH); return; }
  loadMethodLib().then((lib) => {
    if (!lib) { alert(mlibEmptyMsg()); return; }
    const deck = [];
    for (const u of Object.keys(lib)) lib[u].forEach((m, i) => {
      if (m.mnemonic) deck.push({ id: `mn:${u}:${m.lec}:${i}`, unit: u, front: m.concept, back: `🔑 ${m.mnemonic}`, extra: m.method });
    });
    go(deck);
  });
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
      <div class="flash-front">${escH(c.front)}</div>
      <div id="flash-back" style="display:none">
        <div class="flash-backtxt">${escH(c.back)}</div>
        ${c.extra ? `<p class="dim flash-extra">${escH(c.extra)}</p>` : ''}
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
  S.phone.hist.push({ d: today(), mode: phone.kind === 'mn' ? 'mn' : 'flash', n: phone.cards.length, ok: phone.mem });
  if (S.phone.hist.length > 200) S.phone.hist = S.phone.hist.slice(-200);
  save();
  const all = phone.mem === phone.cards.length && phone.cards.length > 0;
  app().innerHTML = `<h1>背誦結果</h1><div class="card ${all ? 'good' : ''}">
    <p class="big">記得 <b>${phone.mem} / ${phone.cards.length}</b></p>
    ${all ? '<p class="praise">🎉 這疊全部記得——它們已經在你腦裡站穩了！</p>' : '<p class="dim">忘掉的卡之後會更常抽到，抽到你背熟為止。</p>'}
    <div class="actr"><button class="btn" onclick="nav('phone')">回手機專區</button>
    <button class="btn primary" onclick="startPhoneFlash('${phone.kind === 'mn' ? 'mn' : 'formula'}')">再抽 10 張</button></div></div>`;
}

function renderDrillMenu() {
  const cards = Object.keys(DRILLS).map((k) => {
    const d = DRILLS[k];
    const hist = S.drills[k] || [];
    const last = hist[hist.length - 1];
    const stat = last
      ? `上次：中位數 ${(last.med / 1000).toFixed(1)}s／答對 ${last.acc}%${last.med / 1000 <= d.target && last.acc === 100 ? ' ✅' : ''}`
      : '尚未練過';
    return `<div class="card drill-card">
      <b>${d.name}</b><span class="dim"> 目標 ${d.target}s/題</span>
      <p class="dim">${d.desc}</p>
      <p class="dim">${stat}</p>
      <button class="btn primary" onclick="startDrill('${k}')">開始 12 題</button>
    </div>`;
  }).join('');
  app().innerHTML = `
    <h1>⚡ 速度特訓</h1>
    <p>目的：把基本運算練到<b>不經思考</b>。每輪 12 題。<b>達標＝中位數 ≤ 目標秒數，且 12 題全對</b>——兩個條件缺一不可，「快但會錯」在考場上比「慢」更貴。<br>
    <span class="dim">建議當作每天開始讀數學的 10 分鐘暖身，挑 2~3 種輪流——優先「上次未達標」的和新上架的四種（解一元二次、分數四則、根式化簡、2×2 矩陣）。</span></p>
    <div class="grid">${cards}</div>`;
}

let drill = null;
function startDrill(key) {
  if (!syncGate()) return;
  drill = { key, items: [], i: 0, results: [], t0: 0, pend: null };
  for (let i = 0; i < 12; i++) drill.items.push(DRILLS[key].gen());
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
  const input = it.kind === 'num'
    ? `<p class="dim">✍️ 在下方計算區作答，答案寫在最後：</p>
       <div class="actr"><button class="btn primary big" onclick="drillSubmit()">✅ 算完了</button></div>
       <details class="typed-opt"><summary class="dim">改用打字（選用）</summary>
       <input id="din" class="ans-input" inputmode="text" autocomplete="off" placeholder="答案" onkeydown="if(event.key==='Enter')drillSubmit()"></details>`
    : it.opts.map((o, idx) => `<button class="btn opt" onclick="drillSubmit(${idx})">${o}</button>`).join('');
  app().innerHTML = `
    <div class="session-head">
      <span>${d.name}｜第 ${drill.i + 1} / 12 題</span>
      <span class="shr"><span id="dtimer" class="timer">0.0s</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div class="card qcard"><div class="qwrap"><div class="qtext big">${it.q}</div><canvas id="qink-cv" class="qink"></canvas></div>
      <div class="ansrow">${input}</div>
      <div id="dfb"></div>
    </div>
    ${inkHTML({ small: true })}`;
  sessionChrome(true);
  inkStart(drill.qid, drill.t0);
  startTicker(() => {
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
    $('#dfb').innerHTML = `<div class="judge-box"><p>正解：<b class="big accent">${it.ans}</b>　對照你答案區寫的——一樣嗎？</p>
      <div class="actr"><button class="btn err" onclick="drillJudge(false)">✗ 我錯了</button>
      <button class="btn primary" onclick="drillJudge(true)">✓ 我對了</button></div></div>`;
  };
  if (ms >= 360000) {
    modal(`<h2>⏸ 這題用了 ${fmtSec(ms)}</h2><p>是不是有中途離開座位？有的話這題不列入本輪，避免污染速度數據。</p>`, [
      ['有離開，這題不列入', () => { drill.pend = null; drill.lock = false; drill.items[drill.i] = DRILLS[drill.key].gen(); drillNext(); }],
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
  drill.results.push({ ok, ms, q: it.q, ans: ansTxt, given });
  syncInk(drill.qid, drill.t0, Object.assign({ mode: 'drill', ok }, proc || {}));
  const fb = $('#dfb');
  if (ok) {
    fb.innerHTML = `<p class="ok">✔ 正確（${(ms / 1000).toFixed(1)}s）</p>`;
    drill.i++;
    drill.nextTimer = setTimeout(drillNext, 500); // endSession 會清掉，避免退出後殭屍題復活
  } else {
    fb.innerHTML = `<p class="bad">✘ 錯了，正確答案：<b>${ansTxt}</b></p>
      <div class="actr"><button class="btn primary" onclick="drill.i++;drillNext()">下一題</button></div>`;
  }
}
function drillDone() {
  sessionActive = false;
  sessionMode = null;
  sessionChrome(false);
  if (!drill.results.length) { nav('drill'); return; }
  const d = DRILLS[drill.key];
  const times = drill.results.map((r) => r.ms);
  const med = median(times);
  const acc = Math.round(100 * drill.results.filter((r) => r.ok).length / drill.results.length);
  (S.drills[drill.key] = S.drills[drill.key] || []).push({ d: today(), med, acc });
  save();
  const hist = S.drills[drill.key];
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  const speedOK = med / 1000 <= d.target;
  const accOK = acc === 100;
  const pass = speedOK && accOK;
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
      <td>${i + 1}</td><td>${r.q}</td>
      <td>${r.ok ? '<span class="okc">✔</span>' : `<span class="badc">✘ ${escH(r.given || '（空白）')}</span>`}</td>
      <td><b>${r.ans}</b></td>
      <td class="${slow ? 'warnc' : ''}" style="font-variant-numeric:tabular-nums">${(r.ms / 1000).toFixed(1)}s${slow ? ' ⚠' : ''}</td></tr>`;
  }).join('');
  app().innerHTML = `
    <h1>${d.name} — 結果</h1>
    ${dailyBanner(1)}
    <div class="card ${pass ? 'good' : ''}">
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
      <ul>${wrongs.map((r) => `<li>${r.q}　你答 <span class="badc">${escH(r.given || '（空白）')}</span>，正解 <b>${r.ans}</b>（${(r.ms / 1000).toFixed(1)}s${r.ms < med ? '——比你的中位數還快，十之八九是搶快' : ''}）</li>`).join('')}</ul></div>` : ''}
    ${slows.length ? `<div class="card"><h2>⚠ 卡頓題 ${slows.length} 題（吃掉全輪 ${slowShare}% 的時間）</h2>
      <p class="dim">耗時超過自己中位數兩倍的題——這幾種數字組合就是你「還沒自動化」的精確位置，下一輪特別注意它們有沒有變快：</p>
      <ul>${slows.map((r) => `<li>${r.q}　<b class="warnc">${(r.ms / 1000).toFixed(1)}s</b></li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>逐題明細</h2>
      <div style="overflow-x:auto"><table class="tbl"><tr><th>#</th><th>題目</th><th>作答</th><th>正解</th><th>耗時</th></tr>${rows}</table></div>
      <div class="actr"><button class="btn" onclick="nav('drill')">回特訓選單</button>
      <button class="btn primary" onclick="startDrill('${drill.key}')">再來一輪</button></div>
    </div>`;
}

/* ═══════════ 主題刷題 ═══════════ */
function attemptsOf(qid) { return S.attempts.filter((a) => a.qid === qid); }
function renderPracConfig() {
  const chips = Object.keys(TOPICS).map((k) => {
    const qs = BANK.filter((q) => q.topic === k);
    const seen = qs.filter((q) => attemptsOf(q.id).length);
    return `<label class="chip"><input type="checkbox" value="${k}" checked> ${TOPICS[k]} <span class="dim">${seen.length}/${qs.length}</span></label>`;
  }).join('');
  app().innerHTML = `
    <h1>🎯 主題刷題</h1>
    <p>每題帶碼表；到達「理想中該答完的時間點」會提醒一次（就一次，不疲勞轟炸）。答錯要選錯因——錯因數據決定你之後練什麼。</p>
    <div class="card">
      <h3>單元（預設全選）</h3>
      <div class="actr" style="justify-content:flex-end">
        <button class="btn sm" onclick="pracSel('none')">全不選</button>
        <button class="btn sm" onclick="pracSel('all')">全選</button>
        <button class="btn sm" onclick="pracSel('weak')">🎯 選最近弱項</button>
      </div>
      <div class="chips" id="topicChips">${chips}</div>
      <h3>難度</h3>
      <div class="chips" id="diffChips">
        <label class="chip"><input type="checkbox" value="1" checked> 易</label>
        <label class="chip"><input type="checkbox" value="2" checked> 中</label>
        <label class="chip"><input type="checkbox" value="3" checked> 難</label>
      </div>
      <h3>題數</h3>
      <div class="chips" id="cntChips">
        <label class="chip"><input type="radio" name="cnt" value="5"> 5 題</label>
        <label class="chip"><input type="radio" name="cnt" value="8" checked> 8 題</label>
        <label class="chip"><input type="radio" name="cnt" value="12"> 12 題</label>
      </div>
      <div class="actr"><button class="btn primary" onclick="startPrac()">開始（未做過的題優先）</button></div>
    </div>`;
}
/* 單元快速選取：全選／全不選／選最近表現弱的（近14天答對率<80% 或 耗時比>1.2；資料太少退回全期） */
function pracSel(mode) {
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
  if (!weak.size) { alert('最近的數據裡還看不出明顯弱項（或做題數太少）——先全選刷一輪，累積數據後這顆按鈕就會準了。'); return; }
  boxes.forEach((b) => (b.checked = weak.has(b.value)));
}
let prac = null;
function startPrac() {
  if (!syncGate()) return;
  const topics = [...document.querySelectorAll('#topicChips input:checked')].map((i) => i.value);
  const diffs = [...document.querySelectorAll('#diffChips input:checked')].map((i) => +i.value);
  const cnt = +document.querySelector('#cntChips input:checked').value;
  let pool = BANK.filter((q) => topics.includes(q.topic) && diffs.includes(q.diff));
  if (!pool.length) { alert('沒有符合條件的題目'); return; }
  // 未做過優先，其次做過次數少的
  pool = shuffle(pool).sort((a, b) => attemptsOf(a.id).length - attemptsOf(b.id).length);
  prac = { queue: pool.slice(0, cnt), i: 0, results: [], mode: 'practice' };
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
  const slowOk = r.filter((x) => x.ok && x.ms > x.target * 1.5).length;
  const hardWins = all.filter((x, i) => !x.excluded && x.ok && prac.queue[i].diff === 3).length;
  const rows = all.map((x, i) => {
    const q = prac.queue[i];
    if (x.excluded) return `<tr><td>${TOPICS[q.topic]}</td><td colspan="3" class="dim">（中途離開，未列入紀錄）</td></tr>`;
    return `<tr><td>${TOPICS[q.topic]}</td><td>${x.ok ? '✔' : '✘'}</td>
      <td class="${x.ms > x.target ? 'badc' : 'okc'}">${fmtSec(x.ms)} / ${fmtSec(x.target)}</td>
      <td>${x.err || '—'}</td></tr>`;
  }).join('');
  const cheer = r.length && okN === r.length ? '整輪全對——這種穩定度就是考場要的！'
    : hardWins ? `其中 ${hardWins} 題是★★★難題你也拿下了，難題手感正在長出來。`
    : r.length && okN >= Math.ceil(r.length * 0.7) ? '大部分都拿下了，把錯的釘進錯題本，這輪就值回票價。' : '';
  app().innerHTML = `
    <h1>刷題結果</h1>
    ${dailyBanner(3)}
    <div class="card">
      <p class="big">答對 <b>${okN} / ${r.length}</b>${slowOk ? `，其中 <b class="warnc">${slowOk} 題「對但超時」</b>（考場上等於失分，已加入錯題本重練速度）` : ''}</p>
      ${cheer ? `<p class="praise">🎉 ${cheer}</p>` : ''}
      <table class="tbl"><tr><th>單元</th><th>結果</th><th>耗時/目標</th><th>錯因</th></tr>${rows}</table>
      <div class="actr"><button class="btn" onclick="nav('stats')">看數據</button>
      <button class="btn primary" onclick="nav('prac')">再刷一輪</button></div>
    </div>`;
}

/* ═══════════ 單題渲染（刷題與錯題重測共用） ═══════════ */
let qsess = null;
function renderQuestion(q, cfg) {
  qsess = { q, cfg, t0: Date.now(), warned: false, locked: false };
  const target = qTarget(q);
  let ansUI;
  if (q.type === 'single') {
    ansUI = q.opts.map((o, i) =>
      `<button class="btn opt block" onclick="qSubmit(${i})">(${i + 1}) ${o}</button>`).join('');
  } else if (q.type === 'multi') {
    ansUI = q.opts.map((o, i) =>
      `<label class="opt block check"><input type="checkbox" value="${i}"> (${i + 1}) ${o}</label>`).join('')
      + `<div class="actr"><button class="btn primary" onclick="qSubmit()">送出（多選）</button></div>`;
  } else {
    ansUI = `<p class="dim">✍️ 在下方計算區作答，<b>最終答案寫在最後</b>，寫完按：</p>
      <div class="actr"><button class="btn primary big" onclick="qSubmit()">✅ 算完了，開始批改</button></div>
      <details class="typed-opt"><summary class="dim">改用打字（選用）</summary>
      <input id="qin" class="ans-input" autocomplete="off" placeholder="輸入答案（分數用 a/b）" onkeydown="if(event.key==='Enter')qSubmit()"></details>`;
  }
  app().innerHTML = `
    <div class="session-head">
      <span>${cfg.head}｜${TOPICS[q.topic]}${q.src ? `｜<b class="accent">${q.src}</b>` : ''}｜${'★'.repeat(q.diff)}${'☆'.repeat(3 - q.diff)}｜目標 ${fmtSec(target)}</span>
      <span class="shr"><span id="qtimer" class="timer">00:00</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div class="timebar"><div id="tbfill" class="timebar-fill"></div></div>
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    <div class="card qcard">
      <div class="qwrap"><div class="qtext">${q.q}</div><canvas id="qink-cv" class="qink"></canvas></div>
      <div class="ansarea">${ansUI}</div>
      <div id="qfb"></div>
    </div>
    ${inkHTML()}`;
  sessionChrome(true);
  inkStart(q.id, qsess.t0);
  startTicker(() => {
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
function qSubmit(optIdx) {
  if (!qsess || qsess.locked) return;
  qsess.locked = true;
  const ms = Date.now() - qsess.t0;
  qsess.ms = ms;
  stopTicker();
  qsess.proc = inkStop();
  document.querySelectorAll('.ansarea button, .ansarea input').forEach((b) => (b.disabled = true));
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
    const chosen = [...document.querySelectorAll('.ansarea input:checked')].map((i) => +i.value);
    qsess.yourAns = chosen.length ? chosen.map((c) => `(${c + 1})`).join('') : '（未選）';
    qResolve(chosen.length === q.ans.length && q.ans.every((a) => chosen.includes(a)));
    return;
  }
  // 填充：打字（選用）自動判；手寫 → AI 批改，沒設 AI 就看正解自評。都不用鍵盤。
  const typed = $('#qin') ? $('#qin').value.trim() : '';
  if (typed) { qsess.yourAns = typed; qResolve(checkFill(typed, q.ans)); return; }
  qsess.yourAns = '（手寫作答）';
  const calcB64 = inkCapture(q.id, 's');
  if (aiKey() && calcB64) {
    $('#qfb').innerHTML = '<p class="dim">🤖 AI 批改中…（認字、對答案、檢查過程哪裡開始錯）</p>';
    const sess = qsess; // 綁定本題：離開或換題後，遲到的回應直接丟棄
    aiGradeCall(q, q.ans.join(' 或 '), calcB64)
      .then((v) => { if (qsess !== sess) return; qsess.ai = v; qShowJudge(true); })
      .catch((e) => { if (qsess !== sess) return; qsess.aiErr = (e && e.message) || String(e); qShowJudge(false); });
  } else qShowJudge(false);
}
function qShowJudge(hasAI) {
  const { q } = qsess;
  const v = qsess.ai;
  const peek = `<div class="sol"><p>正解：<b class="big">${q.ans[0]}</b></p></div>`;
  if (hasAI && v) {
    $('#qfb').innerHTML = `${aiFeedbackHTML(v)}${peek}
      <p class="dim">AI 判得對就繼續；判錯了可以改判。</p>
      <div class="actr"><button class="btn" onclick="qResolve(${!v.correct})">改判：其實我${v.correct ? '錯了' : '對了'}</button>
      <button class="btn primary" onclick="qResolve(${!!v.correct})">${v.correct ? '✓ 沒錯，我答對了' : '✗ 對，我答錯了'}——繼續</button></div>`;
  } else {
    const noKeyHint = !qsess.aiErr && !aiKey() && supa && syncState.user
      ? '<p class="warnc">⚠ 這台裝置還沒拿到 AI key——如果你已在別台填過，重新整理此頁同步後就會自動批改。</p>' : '';
    $('#qfb').innerHTML = `${qsess.aiErr ? `<p class="warnc">⚠ AI 批改失敗：${escH(qsess.aiErr)}——先自評，key 問題到「📊 數據」頁按「測試連線」檢查。</p>` : noKeyHint}${peek}
      <p><b>對照你答案區寫的——答對了嗎？</b><span class="dim">（等價形式都算對：多根順序不同、沒化簡、有沒有寫 x= 都算；座標類順序要照題目）</span></p>
      <div class="actr"><button class="btn err" onclick="qResolve(false)">✗ 我錯了</button>
      <button class="btn primary" onclick="qResolve(true)">✓ 我對了</button></div>`;
  }
}
function qResolve(ok) {
  const { q } = qsess;
  const ms = qsess.ms;
  const target = qTarget(q);
  const overtime = ok && ms > target * 1.5;
  const correctTxt = q.type === 'fill' ? q.ans[0] : q.ans.map((a) => `(${a + 1})`).join('');
  // 筆跡一律上傳（珍貴分析資料）；被排除的標記 excluded，統計時可濾掉
  syncInk(q.id, qsess.t0, Object.assign(
    { mode: qsess.cfg.review ? 'review' : 'practice', ok, excluded: !!qsess.exclude, ai: qsess.ai || null }, qsess.proc || {}));
  const fb = $('#qfb');
  const solBlock = `
    <div class="sol">
      <p>${ok ? '<span class="ok">✔ 答對</span>' : `<span class="bad">✘ 答錯</span>（你的答案：${escH(qsess.yourAns)}）`}
         ｜正解：<b>${correctTxt}</b>｜耗時 ${fmtSec(ms)}（目標 ${fmtSec(target)}）
         ${overtime ? '<span class="warnc"><b>⚠ 對但超時 1.5 倍——考場上這題等於沒拿到</b></span>' : ''}</p>
      ${ok ? praiseFor(q, ok, ms, target) : ''}
      ${qsess.ai ? aiFeedbackHTML(qsess.ai) : ''}
      <p><b>詳解：</b>${q.sol}</p>
      ${q.tip ? `<p class="tip">💡 <b>快解：</b>${q.tip}</p>` : ''}
      ${teachBlock(q.id)}
      <div class="actr"><button class="btn sm" onclick="showMethods('${q.topic}')">🧑‍🏫 調出老師方法庫：${TOPICS[q.topic]}</button></div>
      <div id="mlib-box"></div>
      ${inkSummary(qsess.proc)}
      ${qsess.proc && qsess.proc.n ? `<div class="actr"><button class="btn sm" onclick="inkReplay('${jsA(q.id)}', ${qsess.t0})">▶ 回放解題過程</button></div>` : ''}
      ${qsess.exclude ? '<p class="warnc">（依你的選擇，這筆不列入紀錄）</p>' : ''}
    </div>`;
  if (!ok) {
    fb.innerHTML = solBlock + `
      <p><b>錯因是什麼？（誠實選，這決定你之後練什麼）</b></p>
      <div class="chips r">${ERR_TYPES.slice(0, 4).map((e) =>
        `<button class="btn err" onclick="qFinish(false, ${ms}, '${e}')">${e}</button>`).join('')}
      </div>`;
  } else if (overtime) {
    fb.innerHTML = solBlock + `<div class="actr"><button class="btn primary" onclick="qFinish(true, ${ms}, '超時')">下一題</button></div>`;
  } else {
    fb.innerHTML = solBlock + `<div class="actr"><button class="btn primary" onclick="qFinish(true, ${ms}, null)">下一題</button></div>`;
  }
}
function qFinish(ok, ms, err) {
  const { q, cfg } = qsess;
  if (!qsess.exclude) {
    if (cfg.review) reviewResult(q.id, ok);
    else recordAttempt(q, ok, ms, err, prac ? prac.mode : 'practice', qsess.proc);
  }
  cfg.onDone({ ok, ms, err, target: qTarget(q), excluded: !!qsess.exclude });
}

/* ═══════════ 模擬實戰 ═══════════ */
function renderMockIntro() {
  const n = S.mocks.length;
  app().innerHTML = `
    <h1>⏱️ 模擬實戰（兩輪作答法訓練）</h1>
    <div class="card">
      <p><b>12 題、36 分鐘</b>，難度混合。節奏刻意比帳面快：學測是 100 分鐘約 20 題，帳面平均 5 分鐘一題——
      但扣掉 15~20 分鐘檢查，再讓最難的 3~4 題與混合題各吃 6~10 分鐘，<b>剩下的基本題、中等題實際只分得到約 3 分鐘</b>
      （名師實戰配速表同一個方向：單選約 3.6 分／題、多選約 4.2 分／題，全卷預留 10~20 分鐘驗算＋畫卡）。
      每題都照 5 分鐘的節奏寫，就是「寫不完」的節奏。規則就是考場規則：</p>
      <ol>
        <li><b>第一輪：</b>每題先花 20 秒判斷「我知不知道第一步」。知道 → 做；不知道或猶豫 → <b>按跳過</b>，不辯論。</li>
        <li><b>第二輪：</b>回頭處理跳過的題，直到時間用完。</li>
        <li>作答中<b>不會顯示對錯</b>（跟考場一樣），全部結束才對答案。</li>
        <li>每題顯示建議時間上限，超過就該停損——系統會記錄你「該跳沒跳」幾次。</li>
      </ol>
      <p class="dim">已完成 ${n} 次模擬。${n === 0 ? '第一次就是摸底，考差完全沒關係——我們要的是數據。' : ''}</p>
      <div class="actr"><button class="btn primary big" onclick="startMock()">開始模擬（36:00 倒數）</button></div>
    </div>`;
}
let mock = null;
function buildPaper() {
  const byDiff = (d, n) => {
    const pool = shuffle(BANK.filter((q) => q.diff === d));
    const picked = []; const used = new Set();
    for (const q of pool) { // 儘量不同單元
      if (picked.length >= n) break;
      if (!used.has(q.topic)) { picked.push(q); used.add(q.topic); }
    }
    for (const q of pool) { if (picked.length >= n) break; if (!picked.includes(q)) picked.push(q); }
    return picked;
  };
  return shuffle([...byDiff(1, 5), ...byDiff(2, 5), ...byDiff(3, 2)]);
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
  mock.qwarned = false;
  mock.qlock = false;
  let ansUI;
  if (q.type === 'single') {
    ansUI = q.opts.map((o, i) => `<button class="btn opt block" onclick="mockAns(${i})">(${i + 1}) ${o}</button>`).join('');
  } else if (q.type === 'multi') {
    ansUI = q.opts.map((o, i) => `<label class="opt block check"><input type="checkbox" value="${i}"> (${i + 1}) ${o}</label>`).join('')
      + `<div class="actr"><button class="btn primary" onclick="mockAns()">送出此題</button></div>`;
  } else {
    ansUI = `<p class="dim">✍️ 在下方計算區作答，<b>最終答案寫在最後</b>，寫完按：</p>
      <div class="actr"><button class="btn primary big" onclick="mockAns()">✅ 算完了 → 下一題</button></div>
      <details class="typed-opt"><summary class="dim">改用打字（選用）</summary>
      <input id="qin" class="ans-input" autocomplete="off" placeholder="答案（分數用 a/b）" onkeydown="if(event.key==='Enter')mockAns()"></details>`;
  }
  app().innerHTML = `
    <div class="session-head">
      <span>第${mock.round === 1 ? '一' : '二'}輪｜第 ${mock.i + 1} / ${mock.paper.length} 題｜建議 ≤ ${fmtSec(cap)}</span>
      <span class="shr"><span id="mclock" class="timer">${fmtClock(mock.tEnd - Date.now())}</span>
      <button class="btn sm xbtn" onclick="exitFlow()" title="離開">✕</button></span>
    </div>
    <div id="q-flash" class="ink-flash" style="display:none"></div>
    <div class="card qcard">
      <div class="qwrap"><div class="qtext">${q.q}</div><canvas id="qink-cv" class="qink"></canvas></div>
      <div class="ansarea">${ansUI}</div>
      <div class="mock-actions">
        ${mock.round === 1 ? `<button class="btn skip" onclick="mockSkip()">跳過 → 第二輪</button>` : `<button class="btn skip" onclick="mockGiveup()">放棄此題</button>`}
        <span id="mqtimer" class="dim"></span>
      </div>
    </div>
    ${inkHTML()}`;
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
function mockAns(optIdx) {
  if (!mock || mock.qlock || Date.now() - mock.t0 < 350) return; // 350ms 內＝double-tap 殘留，忽略
  mock.qlock = true;
  const q = mock.paper[mock.i];
  const elapsed = Date.now() - mock.t0;
  let ans;
  if (q.type === 'single') ans = { type: 'single', v: optIdx };
  else if (q.type === 'multi') ans = { type: 'multi', v: [...document.querySelectorAll('.ansarea input:checked')].map((i) => +i.value) };
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
    const img = inkCapture(q.id, 's', true);
    return `<div class="judge-item">
      <div class="judge-img">${img ? `<img src="${img}" alt="手寫過程">` : '<span class="dim">（沒有筆跡）</span>'}</div>
      <div class="judge-info">
        <p class="dim">${TOPICS[q.topic]}｜正解：<b class="big">${q.ans[0]}</b></p>
        <div id="jai-${i}"></div>
        <div class="actr"><button class="btn sm" id="jbad-${i}" onclick="mockJudgeSet(${i}, false)">✗ 錯</button>
        <button class="btn sm" id="jok-${i}" onclick="mockJudgeSet(${i}, true)">✓ 對</button></div>
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
  if (a) a.className = 'btn sm' + (ok ? ' active' : '');
  if (b) b.className = 'btn sm' + (!ok ? ' active' : '');
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
      const v = await aiGradeCall(q, q.ans.join(' 或 '), inkCapture(q.id, 's'));
      if (mock !== m || sessionMode !== 'judging') return;
      m.aiv[q.id] = v;
      const box = $('#jai-' + i);
      if (box) box.innerHTML = aiFeedbackHTML(v);
      if (m.judge[q.id] === undefined) mockJudgeSet(i, !!v.correct);
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
    recordAttempt(q, ok, ms, ok ? (ms > target * 1.5 ? '超時' : null) : '概念不熟', 'mock', mock.proc[q.id] || null);
    return { q, ok, ms, target, yourAns, answered: !!a };
  });
  const acc = paper.length ? okN / paper.length : 0;
  const overStuck = detail.filter((d) => !d.ok && d.answered && d.ms > d.target * 1.5);
  const slowOk = detail.filter((d) => d.ok && d.ms > d.target * 1.5);
  const unused = mock.tEnd - Date.now();
  if (!mock.partial) S.mocks.push({ d: today(), ok: okN, n: paper.length, acc });
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
    return v && v.firstError ? `<li>${TOPICS[q.topic]}：<b>從這裡開始錯</b>——${v.firstError}</li>` : '';
  }).filter(Boolean).join('') : '';
  const rows = detail.map((x) => `
    <tr><td>${TOPICS[x.q.topic]} ${'★'.repeat(x.q.diff)}</td>
    <td>${x.ok ? '✔' : x.answered ? '✘' : '⊘'}</td>
    <td>${escH(x.yourAns)}</td>
    <td>${x.q.type === 'fill' ? x.q.ans[0] : x.q.ans.map((a) => `(${a + 1})`).join('')}</td>
    <td class="${x.ms > x.target ? 'badc' : ''}">${fmtSec(x.ms)}/${fmtSec(x.target)}</td></tr>`).join('');
  app().innerHTML = `
    <h1>模擬結果 — ${mock.reason}</h1>
    ${mock.partial ? '<div class="card warn">中途結束：只結算你作答過的題，不列入模擬成績走勢（每題紀錄與筆跡照樣保存）。</div>' : ''}
    <div class="card">
      <p class="big">答對 <b>${okN} / ${paper.length}</b>（${(acc * 100).toFixed(0)}%）${mock.partial ? '' : `→ 體感 <b class="accent">${gradeOf(acc)}</b>`}</p>
      ${cheers ? `<div class="praise"><b>先說做得好的：</b><ul>${cheers}</ul></div>` : ''}
      <ul>
        <li>「該跳沒跳」（答錯且耗時超過上限 1.5 倍）：<b class="${overStuck.length ? 'badc' : 'okc'}">${overStuck.length} 題</b>${overStuck.length ? ' ← 這是你寫不完的直接原因' : ' ✅'}</li>
        <li>「對但太慢」：<b class="${slowOk.length ? 'warnc' : 'okc'}">${slowOk.length} 題</b>${slowOk.length ? ' ← 已加入錯題本重練速度' : ''}</li>
        <li>剩餘未用時間：${unused > 0 ? fmtClock(unused) : '0（時間用罄）'}</li>
      </ul>
      ${aiNotes ? `<div class="sol"><b>🤖 AI 抓到的出錯點：</b><ul>${aiNotes}</ul></div>` : ''}
      <table class="tbl"><tr><th>題目</th><th>結果</th><th>你的答案</th><th>正解</th><th>耗時/建議</th></tr>${rows}</table>
      <p class="dim">錯題與超時題已自動加入錯題本，明天到期重測。詳解請到錯題本逐題看。</p>
      <div class="actr"><button class="btn" onclick="nav('stats')">看數據</button>
      <button class="btn primary" onclick="nav('wrong')">去看錯題詳解</button></div>
    </div>`;
}

/* ═══════════ 錯題本 ═══════════ */
function renderWrong() {
  const ids = Object.keys(S.wrong);
  const due = dueWrong();
  if (!ids.length) {
    app().innerHTML = `<h1>📓 錯題本</h1><div class="card"><p>目前沒有錯題。去「主題刷題」或「模擬實戰」產生一些吧——錯題是最高價值的訓練材料。</p></div>${mlibCard()}`;
    return;
  }
  const rows = ids.map((id) => {
    const w = S.wrong[id]; const q = bankById(id);
    if (!q) return '';
    const isDue = w.due <= today();
    return `<tr class="${isDue ? 'due' : ''}">
      <td>${TOPICS[q.topic]} ${'★'.repeat(q.diff)}</td>
      <td>${w.err || '—'}</td><td>錯 ${w.fails} 次</td>
      <td>${isDue ? '<b class="warnc">今天到期</b>' : w.due}</td>
      <td><button class="btn sm" onclick="reviewOne('${jsA(id)}')">重測</button></td></tr>`;
  }).join('');
  app().innerHTML = `
    <h1>📓 錯題本 <span class="dim">（間隔重測 1→3→7→14 天，連過四關畢業）</span></h1>
    ${due.length ? `<div class="card warn"><b>${due.length} 題今天到期。</b>先清這些，再刷新題——重測到期錯題的投報率是刷新題的 3 倍。
      <div class="actr"><button class="btn primary" onclick="reviewDue()">開始重測到期題（${due.length}）</button></div></div>` : '<div class="card good">今天沒有到期的錯題 ✅</div>'}
    <div class="card"><table class="tbl"><tr><th>題目</th><th>錯因</th><th>次數</th><th>下次重測</th><th></th></tr>${rows}</table></div>
    ${mlibCard()}
    <div class="card"><p class="dim"><b>訂正標準（名師版）：</b>不是「看懂詳解」，是能自己說出<b>題目的關鍵條件 → 對應的工具（公式/定理）→ 第一步</b>這條鏈。
    說不出來就還沒訂正完，重測時會原形畢露。</p></div>`;
}
let review = null;
function reviewDue() { if (!syncGate()) return; startReview(dueWrong()); }
function reviewOne(id) { if (!syncGate()) return; startReview([id]); }
function startReview(ids) {
  ids = ids.filter((id) => bankById(id)); // 題庫載不到的失效 id（如雲端題包未載入）直接略過，避免炸畫面
  if (!ids.length) { alert('這些錯題對應的題目不在目前的題庫裡（可能來自尚未載入的雲端題包），暫時無法重測。'); return; }
  review = { ids: shuffle(ids), i: 0, okN: 0, excl: 0 };
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
    app().innerHTML = `<h1>重測完成</h1>${dailyBanner(2)}<div class="card good">
      <p class="big">過關 ${review.okN} / ${denom}</p>
      ${review.excl ? `<p class="dim">（另有 ${review.excl} 題因中途離開未列入）</p>` : ''}
      ${allPass ? '<p class="praise">🎉 到期錯題全數過關——之前跌倒的地方都站起來了，這是最扎實的一種進步！</p>' : ''}
      <p>答對的題進入下一個間隔；答錯的明天再來。</p>
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
      else if (res.ok) review.okN++;
      review.i++;
      reviewNext();
    },
  });
}

/* ═══════════ 數據 ═══════════ */
function renderStats() {
  if (!S.attempts.length) {
    app().innerHTML = `<h1>📊 數據</h1>${dailyCard()}<div class="card"><p>還沒有做題數據。先去做一次「模擬實戰」摸底，或刷一輪主題題。</p>
      <div class="actr"><button class="btn primary" onclick="nav('mock')">去摸底</button></div></div>${aiCard()}${syncCard()}${backupCard()}`;
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
  const worst = topicRows.slice(0, 3).filter((t) => t.acc < 0.8 || t.speed > 1.2);
  const bars = topicRows.map((t) => `
    <div class="bar-row"><span class="bar-label">${TOPICS[t.k]} <span class="dim">(${t.n}題)</span></span>
      <div class="bar"><div class="bar-fill ${t.acc >= 0.8 ? 'g' : t.acc >= 0.6 ? 'y' : 'r'}" style="width:${(t.acc * 100).toFixed(0)}%"></div></div>
      <span class="bar-val">${(t.acc * 100).toFixed(0)}%｜速度 ${t.speed > 1 ? '<b class="badc">' : '<b class="okc">'}${t.speed.toFixed(2)}×</b></span>
    </div>`).join('');
  // 錯因統計
  const errCount = {};
  for (const a of S.attempts) if (a.err) errCount[a.err] = (errCount[a.err] || 0) + 1;
  const errTotal = Object.values(errCount).reduce((x, y) => x + y, 0) || 1;
  const errBars = ERR_TYPES.filter((e) => errCount[e]).map((e) => `
    <div class="bar-row"><span class="bar-label">${e}</span>
      <div class="bar"><div class="bar-fill y" style="width:${(errCount[e] / errTotal * 100).toFixed(0)}%"></div></div>
      <span class="bar-val">${errCount[e]} 次</span></div>`).join('') || '<p class="dim">尚無錯因紀錄</p>';
  const ERR_RX = {
    '概念不熟': '先到「📓 錯題本」頁調出該單元的老師方法庫（口訣＋方法），看完立刻限時重做同型題——看懂不算數，寫出來才算。',
    '計算失誤': '不是粗心，是計算量訓練不足——加練「⚡兩位數心算」與該單元速度特訓。',
    '看錯題意': '養成「動筆前圈出問句關鍵字」的固定動作：求什麼？最大最小？正確錯誤？',
    '用猜的': '該題型完全沒把握——列入概念補強清單，優先級最高。',
    '超時': '會但慢：這種題重測時目標時間砍半練，或找它的「快解」套路。',
  };
  const advice = Object.keys(errCount).sort((a, b) => errCount[b] - errCount[a]).slice(0, 2)
    .map((e) => `<li><b>${e}（${errCount[e]} 次）：</b>${ERR_RX[e]}</li>`).join('');
  // 過程診斷（手寫板）
  const procAtt = S.attempts.filter((a) => a.p);
  let procCard = '';
  if (procAtt.length) {
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
      <p class="dim">判讀：<b>起筆慢</b>（>30s）→ 讀題轉化慢，練「看到題型就知道第一步」；<b>題中長停頓</b> → 解法鏈中段斷裂，
      該題型的完整路線沒背熟；<b>塗改多</b> → 動筆前先想 5 秒路線再寫；<b>長停頓後放棄</b> → 跳題紀律其實是對的，問題在第一步判讀。</p></div>`;
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
    ${worst.length ? `<div class="card warn"><b>本週優先攻擊目標：</b>${worst.map((t) => TOPICS[t.k]).join('、')}
      <span class="dim">（答對率最低／耗時比最高的單元——把刷題時間集中在這裡，不要平均分配）</span></div>` : ''}
    <div class="card"><h2>單元答對率與速度比</h2>
      <p class="dim">速度比 = 實際耗時 ÷ 目標時間。大於 1.00× 代表這個單元在吃你的考試時間。</p>${bars}</div>
    <div class="card"><h2>錯因分布 → 對症處方</h2>${errBars}${advice ? `<ul>${advice}</ul>` : ''}</div>
    ${procCard}
    ${drillRows ? `<div class="card"><h2>速度特訓進度</h2><table class="tbl"><tr><th>項目</th><th>輪數</th><th>中位數變化</th><th>狀態</th></tr>${drillRows}</table></div>` : ''}
    ${mockRows ? `<div class="card"><h2>模擬成績走勢</h2><table class="tbl"><tr><th>日期</th><th>答對</th><th>答對率</th><th>體感級分</th></tr>${mockRows}</table></div>` : ''}
    ${aiCard()}
    ${syncCard()}
    ${backupCard()}`;
}

/* ═══════════ 作戰計畫 ═══════════ */
function renderPlan() {
  const days = Math.ceil((new Date(EXAM_DATE) - new Date()) / 86400000);
  const weeks = Math.floor(days / 7);
  const t = today();
  const done = S.daily[t] || {};
  const tasks = [
    ['drill', '⚡ 速度特訓 1~2 輪（10 分）'],
    ['wrongq', '📓 清空到期錯題（10 分）'],
    ['prac', '🎯 主題限時 8 題——打「數據」頁的優先單元（35 分）'],
    ['log', '看一眼 📊 數據，確認明天打哪個單元（2 分）'],
  ];
  const checklist = tasks.map(([k, label]) =>
    `<label class="task ${done[k] ? 'done' : ''}"><input type="checkbox" ${done[k] ? 'checked' : ''} onchange="toggleTask('${k}')"> ${label}</label>`).join('');
  const streak = Object.keys(S.daily).filter((d) => Object.values(S.daily[d]).some(Boolean)).length;
  app().innerHTML = `
    <h1>🗓️ 作戰計畫 <span class="dim">距學測 ${days} 天（約 ${weeks} 週）</span></h1>
    <div class="card">
      <h2>今日清單（每天約 60 分鐘數A）</h2>
      <div class="actr"><button class="btn primary big" onclick="startDaily()">▶ 一鍵開始今日菜單</button></div>
      <p class="dim">一鍵＝自動排程「速訓（挑最該練的）→ 清到期錯題 → 刷題 8 題（挑最弱單元）」，每段做完自動打勾，不用自己選。</p>
      ${checklist}
      <p class="dim">已執行 ${streak} 天。每週三、六把「主題限時」換成一次「⏱️ 模擬實戰」。</p>
    </div>
    <div class="card">
      <h2>三階段路線（現在 → 2027/1/22）</h2>
      <table class="tbl">
        <tr><th>階段</th><th>期間</th><th>主軸</th><th>13 級分檢查點</th></tr>
        <tr><td><b>① 自動化＋補洞</b></td><td>7~8 月（8 週）</td>
          <td>速度特訓全部達標；用本系統地毯式限時刷完 14 單元；錯題滾動清零。<b>新的線上課一律停掉</b>；唯一例外：
          錯因數據指出某單元是真概念洞（連續錯在「概念不熟」），才回去看該單元的課或詳解，
          且 24 小時內必須限時重做同型題——看懂不算數，寫出來才算。</td>
          <td>8 月底：模擬答對率穩定 ≥ 70%，「該跳沒跳」= 0</td></tr>
        <tr><td><b>② 歷屆實戰</b></td><td>9~11 月（12 週）</td>
          <td>主戰場換成<b>大考中心歷屆數A卷</b>（111~115），每週 1 份全真限時＋逐題耗時分析（照本系統的格式手記或拍照記錄）；本系統改當暖身與錯題庫。</td>
          <td>11 月底：歷屆卷得分率 ≥ 78%，全卷寫得完且留 15 分鐘檢查</td></tr>
        <tr><td><b>③ 穩定輸出</b></td><td>12~1 月（6 週）</td>
          <td>每週 2 次全真模擬（含塗卡）；不碰新題型，只重測錯題本；把考場流程（先易後難、90 秒停損、最後 15~20 分鐘檢查）練成儀式。</td>
          <td>考前：連續 3 次模擬 ≥ 78%（≥ 80% 已是 14 級分區）</td></tr>
      </table>
      <p><b>唯一鐵律：</b>從今天起，<b>沒有計時的數學練習一律不算練習</b>。</p>
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
function toggleTask(k) {
  const t = today();
  S.daily[t] = S.daily[t] || {};
  S.daily[t][k] = !S.daily[t][k];
  save();
  renderPlan();
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
    if (syncState.user && syncState.user.id !== was) syncPull();
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
/* 裝置配對連結（免打字登入）：網址帶 #pair=base64(email|密碼) 時自動登入一次，
   成功後 session 永久存在該裝置（自動續期）——體感等同「認裝置」。
   憑證只存在飼主自己書籤裡的連結；這裡先清掉網址再登入，不落地、不上雲。 */
async function autoLoginFromHash() {
  const m = location.hash.match(/#pair=([A-Za-z0-9+/=_-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const i = raw.indexOf('|');
    if (i < 1) return;
    const { data: s } = await supa.auth.getSession();
    if (s && s.session) { syncState.msg = '這台裝置已配對過'; syncPill(); return; }
    const { error } = await supa.auth.signInWithPassword({ email: raw.slice(0, i), password: raw.slice(i + 1) });
    syncState.msg = error ? '配對連結登入失敗：' + error.message : '✅ 裝置配對完成，之後開頁自動同步';
    syncPill();
  } catch (e) {}
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
  if (!supa) { el.textContent = '⚫ 離線版（無法同步）'; el.className = 'off'; return; }
  if (!syncState.user) { el.textContent = '🔴 未登入——紀錄只存本機'; el.className = 'warn'; return; }
  el.textContent = syncState.pushErr ? '🟡 ' + syncState.msg : '🟢 ☁ ' + (syncState.msg || '已登入');
  el.className = syncState.pushErr ? 'mid' : 'ok';
}
function syncGate() {
  // 回傳 true = 放行。沒登入時攔下來問，避免「做了題但沒上雲」而不自知。
  if (!supa || syncState.user) return true;
  if (confirm('⚠️ 尚未登入雲端同步！\n\n現在開始做題，紀錄只會存在這台裝置的瀏覽器裡——換裝置、清瀏覽器就沒了。\n\n按「確定」先去登入（推薦）\n按「取消」仍然開始（僅本機保存）')) {
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
      localStorage.setItem(KEY, JSON.stringify(S));
      applyExtBank();
      syncState.msg = '已從雲端合併';
      updateBadge();
    }
    syncPush();
  } catch (e) { syncState.msg = '離線（資料在本機）'; syncPill(); }
}
function mergeState(a, b) {
  // 兩台裝置各自累積也不丟資料：紀錄類取聯集，其餘欄位取較「多」的一方
  const akey = (x) => x.ts ? String(x.ts) : `${x.qid}|${x.d}|${x.ms}|${x.ok}`;
  const seen = new Set(); const attempts = [];
  for (const x of [...(a.attempts || []), ...(b.attempts || [])]) {
    const k = akey(x);
    if (!seen.has(k)) { seen.add(k); attempts.push(x); }
  }
  attempts.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  const extbank = unionById(a.extbank, b.extbank);
  const wrong = { ...(b.wrong || {}), ...(a.wrong || {}) };
  for (const q of Object.keys(b.wrong || {})) {
    const A = (a.wrong || {})[q], B = b.wrong[q];
    if (A && B) wrong[q] = (B.fails + B.wins > A.fails + A.wins) ? B : A;
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
  const daily = { ...(b.daily || {}) };
  for (const d of Object.keys(a.daily || {})) daily[d] = { ...(daily[d] || {}), ...a.daily[d] };
  const merged = { ...b, ...a, attempts, wrong, drills, mocks, daily, extbank };
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
  // 完整書寫錄影進雲端：計算區(s)＋題目畫記(q)＋答案區(a)＋塗改事件(e)，供後續 AI 統整分析
  const strokes = st.s.filter((s) => s.t0 >= t0);
  const qmarks = (st.q || []).filter((s) => s.t0 >= t0);
  const answers = (st.a || []).filter((s) => s.t0 >= t0);
  const eras = st.e.filter((t) => t >= t0);
  if (!strokes.length && !qmarks.length && !answers.length && !eras.length) return;
  supaInkInsert({ user_id: syncState.user.id, qid, t0, proc: proc || null, strokes: { s: strokes, e: eras, q: qmarks, a: answers } });
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
    <p class="dim">登入後：做題紀錄跨裝置自動同步、手寫筆跡永久保存（換裝置、清瀏覽器都不怕）。帳號打使用者名稱就好，不用完整 email。</p>
    <input id="sy-email" class="ans-input" autocomplete="username" placeholder="帳號（不用打 @gmail.com）" value="${escH((() => { try { return (localStorage.getItem('mathA13_email') || '').replace(/@gmail\.com$/, ''); } catch (e) { return ''; } })())}">
    <input id="sy-pass" class="ans-input" type="password" autocomplete="current-password" placeholder="密碼（至少 6 碼）">
    <div class="actr">
      <button class="btn" onclick="syncLogin(true)">註冊</button>
      <button class="btn primary" onclick="syncLogin(false)">登入</button>
    </div>
    ${syncState.msg ? `<p class="dim">${syncState.msg}</p>` : ''}</div>`;
  return `<div class="card"><h2>☁️ 雲端同步 <span class="okc">已登入</span></h2>
    <p class="dim">${syncState.user.email}｜${syncState.msg || '自動同步中：每次做完題幾秒內上傳'}</p>
    <div class="actr"><button class="btn" onclick="syncLogout()">登出</button>
    <button class="btn" onclick="syncPushNow()">立即同步</button></div></div>`;
}

/* ═══════════ 啟動 ═══════════ */
function boot() {
  const navEl = $('nav');
  navEl.innerHTML = Object.keys(VIEWS).map((v) =>
    `<button data-view="${v}" onclick="nav('${v}')">${VIEWS[v].label}</button>`).join('');
  applyExtBank();
  aiKeyMigrate();
  supaInit();
  nav('home');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
