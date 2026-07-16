# 數A 特訓系統 — Web App 系統設計（交接文件）

> 2026-07-09 建立。給接手開發 app 的模型：這份講**程式本身的架構、資料模型、功能系統、修改與部署方式**。內容生產線（題庫/類題/蒸餾）看 OPERATIONS.md。戰略與診斷看 README.md。
> `HANDOFF_數A_0713d.md` 與 `HANDOFF_數A_0712h.md` 是舊環境的歷史交接檔，並未納入本 repository；目前請以 repository 內的 `README.md`、自動測試與本文件為準。

## 0716f 正確 repo、私有題庫與單一 Supabase（2026-07-16，最新，先讀這段）

- 正式 repo 是 `uqrqmmw/matha`，預設分支 `master`，Pages 主入口是 <https://uqrqmmw.github.io/matha/>。`yen-2cats/matha` 只是一度誤用的救援來源，不再部署正式版。
- `rrihysbxhsbxjteqmtdu` 現在同時承擔 Auth、學習狀態、手寫歸檔、私有 `matha-content` Storage 與 `openai-proxy`；前端與 Edge Function 都不再依賴舊 `jahqjaipeekkynpjjafw`。
- 4521 題原始來源由 `scripts/build-private-bank.js` 清洗為 4092 題、10 個單元包與 SHA-256 manifest。前端登入後下載、驗雜湊、驗 schema，再併入 `CONTENT.packs`；缺檔或雜湊錯誤時保持 362 題核心庫可用。
- 私有題庫不進公開 Git、`app_state` 或 `content_packs` 上傳路徑；Storage policy 只有 authenticated select，更新由專案擁有者在後台執行。

## 0716e 9→13 級分閉環

- 新增 `practice-bank.js`：用固定公式產生 280 題可重算核心變式，14 單元各 20 題；內建總題數由 82 增為 362。`grp` 防同模板在單輪重複，跨輪仍會抽未做過變式。
- 級分校準不再使用自適應弱項練習的近題答對率。`mockCalibration` 優先採近三場實體／補習班模考，沒有才用近三場完整系統模擬；系統模擬顯示 Wilson 小樣本區間。
- `nextBestAction` 固定排序：到期錯題 → 尚未／過期的校準 → 最弱或樣本不足單元 → 維持菜單。首頁以單一主 CTA 顯示理由與預估時間。
- 13 級操作門檻明示為 72%、12 題至少 9 題，連續三場才標穩定；練習答對率只顯示為「練習脈搏」。
- 答對可標「猜中」：保留 `confidence:'guess'`、隔日排入錯題重測、但 `fails` 不增加。類題紀錄區分 `independent-transfer` 與 `guided-redo`，另存來源錯因、單元與難度。
- `recoveryPlanCard` 產生三個修分槓桿，整合 AI 錯法機制、弱單元、到期錯題、類題遷移率及紙本模考失分標籤。
- 紙本／補習班模考新增結構化欄位：剩餘時間、最多三個失分單元、主要錯因。資料會進級分證據、修分卡與 AI 老師摘要。
- 完整策略、指標與風險邊界見 `PRODUCT_STRATEGY_9_TO_13.md`。

## 0716c UI／UX 與端到端修復（2026-07-16，歷史基線）

- 視覺系統改為暖白紙張、石墨字、低彩度灰褐／橄欖／磚紅；縮小圓角、陰影與高彩度狀態面積，保留考卷與紙張感。
- `index.html` 內建自製 SVG symbol sprite，導覽、狀態、標題與按鈕皆使用一致線性圖示；`decorateUi` 會處理動態內容，把舊 emoji 換成 SVG 或乾淨文字，原生 alert／confirm／prompt 也會清理。
- 頂部品牌與九功能導覽重做；手機 ≤700px 改成固定底部、可橫向滑動的圖示導覽。390×844 實測 `scrollWidth <= innerWidth`，無水平溢出。
- 今日計數首次使用預設收合；同步狀態改成可存取 button，桌機顯示說明、手機縮成 32px 狀態點，完整訊息保留在 title／aria-label。
- 批改後不論有沒有實際手寫筆跡，黑／紅／綠筆、復原與加長都會恢復；答案按鈕／輸入欄仍鎖定。真瀏覽器已跑過填充作答與批改。
- `fbInView` 會把上一題捲到回饋區；下一題現在由 `scrollQuestionTop()` 強制回到頁首。真瀏覽器量測由 `scrollY=586` 回到 `0`。
- App 版號 `0716d`，`index.html` 以 `app.js?v=0716d` 避免舊 PWA 黏住；Service Worker cache 為 `matha-v29`，仍採 network-first 與自有 prefix 清理。
- 遠端 `0714c` 的 AI 修補已逐段納入：回饋、卡點與錯題建議統一經 `rtAi` 渲染；`$`／`$$`／混合界定符不再吞散文，速算與提示會先重算驗證再指出錯誤。
- Node 回歸測試目前 25 項；桌機、390px 手機與九個主畫面均已檢查沒有可見 emoji。

OpenAI 付費 API 已透過 Supabase Edge Function 實際呼叫成功（HTTP 200、`OK`、模型 `gpt-5.6-sol`），一次性測試入口已移除。仍未宣稱通過：Supabase 真帳號跨裝置同步、實體觸控筆手感／掌觸／旋轉。

## 0716a 功能搶救基線（2026-07-16，歷史基線）

已從 `yen-2cats/matha` 重新 clone 成乾淨工作副本，建立 `codex/rescue-20260716` 分支並完成以下修復：

- 交付前重新同步 `origin/main` 的 `0713z`、`0714a`、`0714b`，並在最後一次 fetch 後逐段納入 `0714c`；保留上標字元、數A範圍過濾、AI 數學界定符與回饋渲染修復，並納入回歸測試。
- 從舊 `matha13/.claude` 隱藏 worktree 找回尚未 commit 的 `fixAiMath` 邊界修復：保留 LaTeX `\\`、正確處理 `\$`，且落單 `$`／`$$` 不再吞掉後續散文；已併入本分支並補測試。
- IndexedDB 與 localStorage 題包改為逐包合併，不再以整份 revision 二選一而漏掉只存在單側的題包。
- 題目批改後會重新啟用黑／紅／綠筆、復原與延伸畫布；答案仍維持鎖定。
- Supabase「登出這台」使用 local scope；另提供經確認後撤銷全部 session 的 global scope，並修正 UI 文案與動態文字 escaping。
- Service Worker 只清除 `matha-v*` 自有舊 cache，不再刪除同網域其他應用的 CacheStorage。
- 單選題與手機快答選項具備 button semantics、鍵盤焦點與可讀的 accessible name。
- 新增零相依 Node 測試、`npm test`、GitHub Actions、`.gitattributes` 與可執行的 README。

仍需在真實環境人工確認：Anthropic API key 實際扣款呼叫、Supabase 真帳號跨裝置同步、實體觸控筆手感。自動測試不應宣稱涵蓋這三項。

## 0713a–0713d 健檢與修復摘要（2026-07-13，歷史）

一輪全系統健檢（後端/前端/UX 12 維度多agent 審查 + 每條對抗式查證 → 24 findings），修掉並上線 **20 條**，版本 `0712h` → **`0713d`**（兩站 matha13 + matha，每項真瀏覽器驗證）。關鍵變動：

- **全站零 CDN、真離線**：KaTeX 0.16.11 與 Supabase 都**自架同源** → `vendor/katex/{katex.min.js,katex.min.css,auto-render.min.js,fonts/*.woff2 × 20}`、`vendor/supabase.js`（2.110.2 UMD）。index.html 無任何 `cdn.jsdelivr` 連結。**更新這兩個庫＝重新下載對應 dist 檔覆蓋 `vendor/`**（KaTeX 字型從 css 的 `url(fonts/*.woff2)` 清單抓，只需 woff2）。`sw.js` SHELL 預快取 KaTeX js/css，字型由 fetch handler 首次線上渲染時快取；`CACHE` 目前 `matha13-v9`。
- **匯入內容 XSS 防護**：`rtTxt` 先過 `sanitizeContent`（切 `\(…\)` 島原封交 KaTeX、只白名單清洗島外散文 `<br>/<b>`＋剝屬性）；`fig`/`solFig` 過 `sanitizeSVG`。**改內容渲染別破壞「島不動、散文清洗」的分工**（實測全庫散文只用 `<br>/<b>`、零屬性）。
- **`today()` 改台灣本地日**（`Date.now()+8h`）：清晨/熬夜作答不再歸錯日、streak/每日目標/到期錯題不再錯位。**別退回 `toISOString()` UTC**。
- **內容分家同步**：`pullContent` 超集會 bump rev 回推、rev 相同才略過（本地較新也拉回合併）；`migrateContentFromS` 已 **async**、先 `await persistContent()`（回傳 bool）確認落地才刪 `S.ext*`。
- **配對連結改 session 權杖**（access+refresh，可登出撤銷、會過期）取代明文帳密；syncCard 有「📱 產生配對連結」鈕；`autoLoginFromHash` 相容舊 `base64(email|密碼)`。
- **其他**：`load()` 驗形狀防壞資料白屏（壞值備份到 `_corrupt`）、`exportData` 剝 `aikey`、備份還原 `idbWriteAll` 先 clear、SW network-first 加 3.5s 逾時、PWA controllerchange 更新提示、viewport 解鎖縮放、ink 死指（`lostpointercapture`）/回放尺寸重算、登入 Enter 送出、`praiseFor` 個人最速只算答對、卡點靛藍收進 `--insight` token、模考補 `ts` 去重。
- **刻意保留（非 bug）**：#13 手機單指在整卡書寫面既畫不了也捲不動（改動會傷觸控筆主作答面）、#18 `attempts` 無上限成長（需歸檔架構，雲端鏡像下無丟資料）、#19 開放自助註冊（飼主評估後接受——URL 未宣傳、最壞只是免費層被灌爆可偵測可復原）。
- 完整逐條報告見桌面 `HANDOFF_數A_0713d.md` 與健檢 artifact。

## ⚡ 0712d–0712h 摘要（2026-07-12/13，接在 0712a 之後）
- **0712d 內容/狀態分家**：題庫/重點/公式卡進 `CONTENT.packs`（IndexedDB＋雲端 content_packs 表），S 只剩輕狀態；存取走 `extBankArr/extFlashArr/extNotesArr`；`probeContent` 偵測表→啟用+`migrateContentFromS` 遷移；表沒建則維持舊行為（進 S.extbank）零風險降級。
- **0712e**：訂正重算（答錯→看解答攤開再手寫一遍，共用 side 支線 `cfg.redo`）、手機筆記卡手指畫線（`inkSurface.allowTouch`）、口訣快答 `startMnQuiz`（看口訣選概念，取代召回難度過高的口訣背卡）。
- **0712f**：修內容匯入持久化競態（`reloadAfterContent`＝寫入→讀回驗證→才 reload；`idbOpen` 快取連線）。
- **0712g**：模擬葛雁用講義的 6 情境回報修正——mock/批改面板 fill 正解走 mDispOpt、錯題卡/衝刺/批改補 `q.stem`＋選項、級分門檻校正 72/78、薄單元標庫存、`buildPaper` 題型配額。
- **0712h**：對抗式 code review 修 10 bug——備份還原三情境丟資料（改 reloadAfterContent＋非分家折回 S.ext*）、`buildPaper` 難度分散（改難度桶+題型配額=易5中5難2/單3多2填7）、`pullContent` 聯集、同步 churn（只在內容變才重傳）、`contentInit` 取較新來源、手指雙指捲動死指。
- **十本講義進料**：4521 題+309 重點（私有夾 `20260711-ghost/`，絕不進 repo）；管線見桌面 handoff §3。
- **還沒做（只有飼主能做，卡憑證/硬體）**：Supabase 建 content_packs 表、匯入內容、平板真機 smoke——見桌面 handoff §7。

## ⚡ 0712a 大改版摘要（2026-07-11 UI/UX 重設計，先讀這段）

對準飼主五大需求（練對範圍量／受激勵／錯題人話學習／弱點追蹤應用／手寫分析有意義）的一輪整體重設計：

1. **首頁＝作戰儀表板**：`todayCard`（菜單預覽：⚡推薦速訓+理由、📓到期錯題數、🎯弱項單元+理由，各段可單獨啟動；streak 保衛戰；模擬節奏提醒 `mockDueHint`）＋級分梯 `gradeLadder`（9~15 格、🎯13 描邊、差距翻成「再多對 N 題」）＋**十四單元戰力地圖 `masteryMap`**（色階=答對率、⏱=耗時比>1.2、點 tile=`startPracTopic` 專攻 6 題、📚=`showUnitNotes` 單元重點 modal）＋`homeInsights`（🎓畢業數＋🧠最近卡點）。
2. **錯題本 2.0**（`renderWrong` 重寫）：錯題學習卡 `wrongCard`（題目全文＋「上次你這裡跑掉了」w.adv.fe＋「🎯下次這樣做」w.adv.nt＋1→3→7→14 畢業階梯＋最近5筆時間線＋錯因 chips 可改標＋詳解/老師教法摺疊＋同單元加練/重測）；🃏 衝刺複習 `startWrongFlash`（翻卡過建議、不動排程）；**畢業改標記不刪**（`w.grad=日期`，dueWrong 過濾、mergeState 以 witv=99 比較、再錯回鍋保留前科）＋畢業慶祝（qResolve 預告＋reviewNext 結算＋累計數）。
3. **AI 建議持久化**：`recordAttempt(q,ok,ms,err,mode,proc,ai,opts)` → `rec.ai={fe,nt}`（截160字）；錯題卡冗餘 `w.adv={fe,nt,d}`；非同步路徑（qProcReview/mockAIJudge）事後回寫。**複習也記 attempts**（mode:'review'、opts.skipWrong 防與 reviewResult 打架）→ 複習日不再斷 streak、計每日點數。**超時題複習有速度門檻**（answer 對但 > 目標 → reviewResult slow：不記 fails、打回第1關）。
4. **🧠 手寫卡點語意分析（需求5 核心）**：`inkStuckShots(qid,t0)` 把 ≥20s 停頓（最長≤3個）畫成證據圖（原色=停頓當下已寫、藍=之後頭幾筆）；掛進 `aiGradeCall/aiProcCall`（同一次 API），JSON 加 `stuck:[{phase(讀題|選方法|想公式|卡計算|驗算收尾),what,unstick}]`；`normStuck` 正規化後存 `rec.p.stuck`；無 AI 退 `stuckLabel` 位置啟發式（起步/中段/收尾卡）。顯示：單題 `stuckHTML` 區塊＋「⏸ 從卡點前回放」（inkReplay 第3參數 jumpMs）；數據頁「你最常卡的地方」phase 彙總＋處方直達；首頁最近卡點。
5. **激勵**：goalCrossBanner（每日30點跨線一次性慶祝，goalHit 存 S.daily）、drillDone 首次達標/已自動化 X/12/個人最速、renderDrillMenu 熟練五階色條+近6輪點陣+排序、pracDone 單元進步對照（樣本≥5、只講進步）、mockFinal 與上場比+級分跨檔+新高、phone hist 加 med+個人最速、praiseFor 拆史實類（AI 在場時保留曾錯今對/破最速）、milestoneCard。
6. **內容管線 v2（參考書就緒）**：匯入信封 `{kind:'qpack'|'flash'|'notes', name, items:[…]}`；`validateQ` 逐題驗證（壞題擋下並列名）；`unionById(inc,cur)` 改 **rev 覆蓋**（同 id 取 rev 大者，回報 新增/更新/略過）；notes → `S.extnotes[{id,topic,title,html,order,src,rev}]`（錯題本 notesLibCard、戰力地圖 📚 modal）；flash → `S.extflash`（併入手機公式卡）；packCard 題包管理（按 src 分組、可停用 S.packOff）；題目 schema 新欄 `rev/grp(題組id)/stem(共用題幹)/solFig(詳解配圖，不過 rtTxt)`；mergeState 對 extflash/extnotes/packOff 有合併規則。
7. **（0712c）ink 死碼清理完成**：舊「三書寫面」抽象（#qink-cv/#ans-cv、st.q/st.a、inkClickThru、inkMarkAuto、inkCapture 雙面拼圖）全數移除——現在只有單一整卡畫布（key 'calc'→st.s）＋手機獨立筆記卡；syncInk 只送 {s,e}（雲端舊列的 q/a 欄位僅歷史殘留）；順修 inkRedraw 的批改標記在 resize 後消失問題。§4.5 的三面描述已過時，以此為準。另：plan 頁手動打勾清單移除（改唯讀狀態，由今日菜單自動寫）、番茄鐘入口收進今日菜單 modal、單題 inkSummary 數字行移除（卡點卡取代）。
8. **修掉既有 bug**：`addDays` 本地 parse+UTC 輸出在 UTC+8 少一天（到期日提前、streak 跳算）→ 全 UTC；save() 包 quota try/catch；bankById 走 BANK_MAP（Map）；attemptsOf 排序比較改 attCountMap；口訣卡 id 改內容 hash（重灌方法庫不錯位，舊 mn:* 權重歸零重學）；dailyFlow 殭屍橫幅（nav 時清）；診斷黃框只在異常時顯示。
8. **視覺**：token 收斂（--accent-soft/--mark/--paper-*/熟練度 --m0~m4/圓角/陰影）、字階（h1 23/h2 17/h3 標籤體）、按鈕浮起+按壓回饋+focus-visible+粗指標加大、nav 觸控 36px+溢出漸隱、批改單浮層+回饋區改黑體、單元橫條 73/80 刻度+四段色、每日圖目標線+今日聚焦+全數值標籤、手機 bar-row 兩行 grid+表格 tblwrap+safe-area。theme-color 統一 #0f766e。

### 內容包格式（之後灌參考書用，餵給 📊 數據頁「匯入備份」即可）
```js
// 題包：{"kind":"qpack","name":"龍騰講義Ch3","items":[{id,topic,type,diff,q,opts?,ans,sol,tip?,target?,src,rev?,grp?,stem?,fig?,solFig?}]}
// 重點包：{"kind":"notes","name":"...","items":[{id,topic,title,html,order?,src?,rev?}]}  // html 用與 sol 相同的 \(…\) KaTeX 格式
// 公式卡包：{"kind":"flash","name":"...","items":[{id,unit,front,back,src?,rev?}]}
// 規則：同 id 重灌時 rev 較大者覆蓋；SVG 一律放 fig/solFig 欄位，嚴禁內嵌在 q/sol 字串（rtTxt 會咬爛 markup）。
```

## 0. 一句話架構

**單頁純前端 vanilla JS，無框架、無 build step、無 npm**。四個檔案（index.html/style.css/bank.js/app.js）直接開就能跑。資料離線優先存 localStorage，登入後鏡像同步到 Supabase。手機電腦皆可，響應式。

## 1. 檔案結構（worktree 分支 claude/math-exam-prep-7c2pg4）

```
index.html   16 行：外殼。<header><nav></nav></header> + <main id="app"></main> + supabase CDN + bank.js + app.js
style.css    ~230 行：白底考卷風（飼主指定：不分系統亮暗一律白底），CSS 變數在 :root；body.session-on 做題時隱藏 header/同步燈
bank.js      513 行：TOPICS(14單元) + DIFF_TARGET + BANK(83題陣列) + GRADE_TABLE
app.js       1621 行：全部邏輯。載入即 boot()，用 hash-less 的 nav() 切換 7 個 view，每個 view 是一個 render 函式把 HTML 塞進 #app
```

**渲染模型**：沒有虛擬 DOM。每個 view 是 `renderXxx()` 函式，直接 `app().innerHTML = \`...\``。互動用 inline `onclick="fn()"` 呼叫全域函式（所有函式都是全域，因為 app.js 不是 module）。狀態變了就重新 render 整個 view。

## 2. 資料模型

### 2.1 全域狀態 S（存 localStorage 的 key = 'mathA13'）
```js
S = {
  attempts: [ { qid, ok, ms, err, d(日期), mode, ts(時間戳), p?(手寫過程) } ],  // 每次作答
  wrong:    { <qid>: { fails, wins, itv(間隔天數), err, due(下次重測日) } },       // 錯題本
  drills:   { <drillKey>: [ { d, med(中位數ms), acc } ] },                          // 速度特訓歷史
  mocks:    [ { d, ok, n, acc } ],                                                  // 模擬成績
  daily:    { <日期>: { <taskKey>: true } },                                        // 每日清單打勾
  extbank:  [ …外部題(官方/講義/類題) ],   // 私有層題庫，見 OPERATIONS.md §3
  ver: 1,   // （舊資料可能殘留 inkcfg——橡皮擦已移除，欄位閒置無害）
}
```
`load()`(app.js:8) 讀 localStorage，`save()`(app.js:15) 寫回並觸發 `syncQueue()`（雲端 debounce 上傳）。

### 2.2 題目 schema（BANK 與 extbank 共用）
```js
{ id, topic(14單元鍵), type('single'|'multi'|'fill'), diff(1|2|3), q,
  opts?(選擇題陣列), ans(single/multi=0-based索引陣列; fill=[字串]),
  sol(詳解), tip(快解), target?(自訂目標秒數), src?(來源標記) }
```
- 14 單元鍵見 TOPICS：num line poly seq comb prob data trig1 trig2 exp vec svec splane mat
- `qTarget(q)`(app.js:473)：目標時間 = q.target || DIFF_TARGET[q.diff]（易90/中150/難240秒）
- `checkFill`(app.js:461)：填充題判分，先 norm() 正規化（全形/負號/空白/x=前綴），再 parseFrac 比數值
- `applyExtBank()`(app.js:30)：把 S.extbank 併進全域 BANK 陣列（id 去重），boot 時與雲端 pull 後都會呼叫

## 3. 七個 View（nav 切換，VIEWS 物件 app.js:518）

| view | 函式 | 功能 |
|---|---|---|
| 📋 診斷 home | renderHome:545 | 首頁：倒數天數、體感級分、診斷書、四訓練線、三階段路線、考場SOP |
| ⚡ 速度特訓 drill | renderDrillMenu:770 | 12 種基本運算限時連發（見 §4.1）|
| 🎯 主題刷題 prac | renderPracConfig:913 | 選單元→逐題計時作答→錯因分類（見 §4.2）|
| ⏱️ 模擬實戰 mock | renderMockIntro:1084 | 12題36分、兩輪作答、考場模式（見 §4.3）|
| 📓 錯題本 wrong | renderWrong:1267 | 間隔重測 1→3→7→14 天（見 §4.4）|
| 📊 數據 stats | renderStats:1322 | 單元答對率/速度、錯因處方、過程診斷、雲端同步卡、備份卡 |
| 🗓️ 作戰計畫 plan | renderPlan:1404 | 每日清單、三階段路線表、考場SOP |

`nav(view)`(app.js:528)：切 view 前若 sessionActive 會 confirm、關手寫板、停碼表。

## 4. 核心功能系統

### 4.1 速度特訓（DRILLS，app.js:610）
12 種程式隨機生成的基本運算，每輪 12 題。每種是 `{ name, desc, target(秒), gen() }`，gen 回傳一題。
- 種類：tri(特殊角三角值) logexp(指對數) quad(二次頂點) rem(餘式) cnk(排列組合數) dot(向量內積) seqd(等差等比) mul(兩位數心算) quadroot(解一元二次) frac(分數四則) root(根式化簡) mat2(2×2矩陣)。後四種是 2026-07-09 依歷屆原子運算頻率評選新增。
- 流程：startDrill→drillNext→drillSubmit→drillDone。**達標＝中位數≤目標秒 且 12題全對**（兩條件，drillDone:844 有逐條顯示）。結果頁有：判定(敗在速度or準度的對症處方)、錯題卡、卡頓題(耗時>中位數2倍)、逐題明細、近6輪走勢。

### 4.2 主題刷題（renderQuestion:988 共用單題渲染）
選單元→startPrac→pracNext→renderQuestion→qSubmit→qFinish。每題：碼表+目標時間進度條、手寫計算區(見§4.5)、作答後顯示詳解+快解+過程摘要+回放按鈕。答錯→錯因四分類 chips（概念不熟/計算失誤/看錯題意/用猜的）；對但超時1.5倍→標記進錯題本重練速度。`recordAttempt`(485) 記錄並更新 wrong。

### 4.3 模擬實戰（mock）
buildPaper 抽 12 題（易5中5難2、儘量不同單元）。兩輪作答：第一輪知道第一步就做、不知道按跳過；第二輪處理跳過題。36分倒數。手寫板與其他模式相同（飼主 2026-07-10 指示：加長/復原全模式保留）。作答中不顯示對錯；結算流程＝mockGrade→（有手寫填充）mockJudgePanel→mockFinal，見 §4.5b。

### 4.4 錯題本 + 間隔重測（renderWrong:1267）
Leitner 式：itv 1→3→7→14 天。`reviewResult`(499)：對了升級間隔、連對四次(itv>14)畢業移除；錯了打回 itv=1。`dueWrong`(512) 取今天到期題。到期題投報率標為刷新題3倍。訂正標準卡（林岳版：說得出關鍵條件→工具→第一步才算訂正完）。

### 4.5 手寫系統（ink，2026-07-10 大改版）★特色功能
**三個書寫面**：題目畫記層 `#qink-cv`（絕對定位蓋在 .qwrap 上）、計算區 `#ink-cv`、答案區 `#ans-cv`。`sessionInk[qid] = { s:計算筆畫, e:塗改時間, q:題目畫記, a:答案筆畫 }`，每筆 `{t0,t1,c(顏色鍵),pts}`。
- **輸入原則（防誤觸核心）**：三面全部 `touch-action:none`；pointerType `touch` 完全不畫線（手掌怎麼靠都安全），**兩指**手勢＝捲動（計算區捲 .ink-scroll、其他捲頁面）；只有 pen/mouse 畫線。已無「手指」勾選。
- **工具**：黑/紅/綠三色（`INK_COLORS`，預設黑）＋復原(inkUndo，跨三面砍最後一筆)＋加長(inkExtend，僅計算區)。**無橡皮擦**（全模式，含模擬——考場沒有橡皮擦，寫錯劃掉）。筆寬 `INK_W=1.35`。
- **偵測**：起筆猶豫(fi)、題中停頓(hes,≥15s)、塗改(era)、尾段(tail)——inkStop 只統計計算區(s)。
- **時間提醒**：只在「該題目標時間點」由 ticker 觸發 `flashOnce` 一次（頁面 `#q-flash`），無其他警示（inkWatch 已刪）。
- **回放** inkReplay（計算區）；**截圖** inkCapture(qid,'s'|'a')→裁切白底 PNG base64（給 AI 批改與批改面板縮圖）。
- **雲端**：syncInk 上傳完整 `{s,e,q,a}` 到 ink_sessions.strokes，proc 欄夾帶 `{mode, ok, ai}`＋過程指標；速訓也上傳（qid 格式 `drill:<key>:<t0>`）。

### 4.5b 手寫作答與 AI 批改（免鍵盤）
填充/數值題不再用鍵盤：**答案區手寫 → 按「✅ 算完了」**。
- 有 Anthropic API key（存 localStorage `mathA13_aikey`，數據頁 aiCard 設定，絕不進雲端/備份）→ `aiGradeCall` 直連 API（`anthropic-dangerous-direct-browser-access`，模型預設 claude-sonnet-5）傳答案區＋計算區 PNG，回 JSON `{read,correct,firstError,praise,habit}`；判定可人工改判。等價形式（多根順序不同/未化簡/x= 前綴）算對、座標有序對不可交換。**該題若有老師蒸餾解法（S.teach，279 題），prompt 會一併夾帶老師的教法與口訣，AI 指錯時優先對照老師路線**。
- 老師蒸餾整合共四點：首頁 teachProfileCard、詳解區 teachBlock（老師這樣教＋口訣＋黑板答案）、AI 批改 prompt、**老師方法庫（概念洞 UI）**。前三者資料在雲端 app_state（teachProfile＋teach 279 題，2026-07-10 驗證 205 對 extbank／74 對內建、零孤兒）。
- **老師方法庫（1662 條）**：獨立雲端表 `teacher_methods`（schema.sql；RLS owner-only），資料用 `supabase/upload_methodlib.py` 灌入（源檔在 E:\ 備份）。app 端 `loadMethodLib()` 分頁抓＋localStorage 快取（`mathA13_mlib_v1`，之後離線可看）；UI 進入點：①每題詳解區「調出老師方法庫：單元」按鈕 ②錯題本頁 mlibCard（14 單元 chips）③數據頁「概念不熟」處方指路。渲染一律 escH（方法文字含 < 符號）。
- **AI key 跨裝置**：存 `S.aikey`（＋`aikeyTs`）→ 隨 app_state 雲端同步到所有裝置；mergeState 以 aikeyTs 較新者勝；boot 時 aiKeyMigrate() 把舊版 localStorage key 搬進 S。離線 artifact 版仍僅本機（且 CSP 封鎖外連，AI 批改不可用）。
- **AI 憑證雙軌（2026-07-10 教訓）**：`aiAuthHeaders()` 自動辨識——`sk-ant-api03`（正式 API key，走 x-api-key，**長期正解**，需 platform.claude.com Billing 儲值，訂閱額度不含 API）vs `sk-ant-oat`（訂閱 OAuth token，走 Bearer＋`anthropic-beta: oauth-2025-04-20`，會過期＋與 Claude Code 共用限流，只能暫用）。批改呼叫：模型預設 `claude-opus-4-8`、`thinking:{type:'disabled'}`（防 adaptive thinking 吃掉 max_tokens 截斷 JSON）。**失敗不靜默**：錯誤顯示在批改介面，數據頁 aiCard 有「測試連線」按鈕。
- **PWA（2026-07-10）**：manifest.webmanifest＋icon-192/512.png（Pillow 生成，teal 底「數A/13級分」）＋sw.js（network-first、斷網退快取、跨域直通；改版時 bump `CACHE` 版本字串）。index.html 註冊 SW（非 http 環境靜默跳過）。三星手機/平板 Chrome「加到主畫面」即裝成 app。
- **所有動作按鈕（算完了/下一題/✓✗/送出/開始…）一律置右**（`.actr` flex 容器；飼主右撇子）。選項按鈕維持全寬。
- 沒 key → 顯示正解自評（✓我對了/✗我錯了），一樣免鍵盤。「改用打字（選用）」摺疊輸入框保留給桌機。
- 模擬實戰：作答中不對答案，`mockAns` 存 `{type:'inkfill'}`；結算時進 **批改面板 mockJudgePanel**（縮圖＋正解＋✓/✗，有 key 時 AI 先批＋標出「從哪一步開始錯」）→ mockFinal。
- 單題 ≥6 分鐘按送出時會先問「是否中途離開」，選「有離開」該筆完全不入紀錄（prac 丟棄、mock 排除該題），避免污染數據。
- 中途退出（✕ 或切頁籤）走 `exitFlow` modal：mock 可「保留已作答結算離開」（partial，不 push S.mocks）；prac/review 可「不保留」回滾（snapSession/rollbackSession 還原 attempts 長度與 wrong）。
- **稱讚引擎 praiseFor**：只講有依據的（曾錯今對/★★★拿下/破個人最速/目標內完成），刷題逐題顯示、模擬結果逐題列「先說做得好的」。

### 4.5c 手機專區／一鍵今日菜單／每日投入（2026-07-10 新增）
- **📱 手機專區（renderPhone）**：零碎時間全按鈕作答（不手寫不打字）。三模式：⚡心算快答（DRILLS 生成器 + `optionize()` 自動把數值答案變 4 選 1，12 題連發）、🧠公式必背卡（`FLASH` 常數 66 張：學測數A必背公式/定理/幾何原則，翻面自評記得/忘了）、🧑‍🏫老師口訣卡（methodlib 的 mnemonic 動態成卡，1500+ 條）。卡片記憶 `S.phone.cards`（忘過的權重高、優先再抽）；每日彙總 `S.phone.days`、輪次 `S.phone.hist`——都在 S 內隨 app_state 上雲，mergeState 有專屬合併（days 取大、hist 聯集、cards 取 seen 多者）。
- **▶ 一鍵今日菜單（startDaily/dailyNext/dailyBanner）**：自動排程 速訓（dailyPick 挑沒練過→未達標→達標最久）→ 清到期錯題 → startPracAuto 刷 8 題（自動挑答對率最低/耗時比最高的 3 單元），每段完成畫面出接力橫幅、自動打勾 S.daily（drill/wrongq/prac/log）。中途退出（endSession）即取消接力。入口：首頁 todayCard 與作戰計畫頁。
- **📈 每日投入（dayAgg/dailyChartSVG/dailyCard/todayCard）**：dayAgg 彙總 attempts＋drills（12題/輪估算）＋phone；14 天題數長條＋答對率點線（單色 #0d9488，過 dataviz palette 驗證；同 x 軸兩張小圖，不做雙軸）、🔥連續天數（今天沒練不斷 streak、從昨天回數）、週對比、每日目標 `DAY_GOAL=30` 進度條（首頁也有一份迷你卡）。鼓勵語只在有真實依據時出現（連續≥3天/破紀錄/週增長/差幾題超車）。

### 4.6 數據診斷（renderStats:1322）
單元答對率+速度比(實際耗時÷目標)橫條、錯因分布→對症處方、速度特訓進度、模擬走勢、**過程診斷卡**(起筆/停頓/塗改/最嚴重卡點Top3)、雲端同步卡、備份卡。worst 單元＝答對率最低/耗時比最高→「本週優先攻擊」。

### 4.7 級分換算（GRADE_TABLE bank.js:504, gradeOf app.js:474）
依 113~115 官方級距平均：15級≥84%、14級≥78%、13級🎯≥72%、12級≥66%…9級≥48%。目標雙線制 73%保底13級/80%攻14級。

## 5. 雲端同步（Supabase，app.js:1466~1610）

**離線優先**：沒登入/沒網路一切照常存 localStorage。登入後：
- `save()`→`syncQueue()`(1486) debounce 4秒→`syncPush()`(1514) upsert 整包 S 到 app_state 表
- 登入時 `syncPull()`(1524) 下載雲端 S、用 `mergeState`(1539) 與本機合併（attempts/mocks/drills 聯集、extbank 聯集，不丟資料）→ applyExtBank
- 手寫筆跡逐題 `syncInk`(1567) insert 到 ink_sessions 表（永久歸檔）
- `syncPill`(1492) 右上角常駐狀態燈（🟢已同步/🔴未登入/⚫離線版）；`syncGate`(1505) 開始做題前若未登入攔下來問
- 切分頁/斷網重連時強制補傳（supaInit 的事件監聽）
- **artifact 環境**（claude.ai）CSP 擋外部連線→ supa=null→ 自動降級純本機模式（syncCard 顯示提示）
- 後端細節（帳號、RLS、schema）見 memory `matha-supabase-backend` 與 OPERATIONS.md §二

## 6. 修改與部署

### 改碼流程
1. 在 worktree 改 app.js/bank.js/style.css
2. `node --check app.js && node --check bank.js` 語法檢查
3. preview 驗證：launch.json 有 `matha-static`（port 8737，用 scratchpad 的 serve.js 靜態服務）。preview_start→在瀏覽器實跑→改完 preview_stop
4. `git add … && git commit && git push origin claude/math-exam-prep-7c2pg4`

### 部署三處（順序固定，見 OPERATIONS.md §二）
1. worktree 分支（開發）
2. **`uqrqmmw/matha` 公開 repo → GitHub Pages**（正式站，使用者主入口 <https://uqrqmmw.github.io/matha/>）：在獨立工作區建立 `codex/*` 分支，跑 `npm test`，經 PR 合併到 `master`；不要再把檔案複製到其他 repo。
3. **artifact 離線備用版**：把 style.css/bank.js/app.js 內嵌成單一 HTML（結構見 OPERATIONS.md §二.3）→ Artifact 工具、favicon 📐、url ee29beef-8400-420d-b68a-a4f6ab489b21

### 測試手法（血淚）
- 背景分頁會節流 setTimeout（自動跳題的500ms變分鐘級）→ 測試時攔截 setTimeout 同步驅動，或保持分頁前景
- 大量互動測試前先 location.reload() 清掉殘留的計時器/session 狀態
- ink 相關測試用 PointerEvent 派發（pointerType:'mouse' 可繞過手掌防誤觸）

## 7. 設計決策（別重新翻案，見 OPERATIONS.md §五）
- 純 vanilla JS 無 build：使用者要能直接開檔、artifact 要能單檔內嵌、降低維護面
- 離線優先 + 雲端鏡像：考生不能因網路斷就不能練
- **白底、全模式同一套手寫工具、無橡皮擦**（2026-07-10 飼主核定，取代舊的「診斷/考場雙模式」設計）：模擬真實考卷、寫錯劃掉
- **作答免鍵盤**：手寫答案區＋「算完了」＋ AI 批改/自評；時間警示只在目標時間點一次（飼主明確要求，勿加回疲勞轟炸式警示）
- 達標雙條件(速度+準度)：手比腦快的錯比慢更貴
- 目標雙線制 73%/80%、檢查15~20分、90秒停損：見 README §五外部核對

## 8. 已知待辦（app 端）
- extbank 破千前把外部題庫從 app_state 搬獨立資料表（每次同步上傳好幾MB會撞瀏覽器上限）
- 需圖的題（needsFigure）目前略過，未來補 SVG 版
- 老師蒸餾的 sol/tip 回寫（見 OPERATIONS.md §3.5）：enrichment 注入雲端 extbank 對應題；教學風格檔案與按單元方法庫要決定存哪（app_state 新欄位 or 獨立結構）+ 做 UI 在錯題/概念洞時調出老師方法
