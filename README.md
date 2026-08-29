# 數A特訓

給學測數A考生使用的離線優先 PWA。它把十一單元空白默寫、全真模考、破題方向訓練、隔日三級訂正、重要定義理解、手寫 AI 比對與跨裝置同步放在同一個純前端 app 裡。

目前整體施工的唯一優先順序、完成定義、關鍵路徑與阻塞，統一維護在 [`SYSTEM_COMPLETION_BLUEPRINT.md`](SYSTEM_COMPLETION_BLUEPRINT.md)；後續工作先讀該檔，不以零散對話或舊交接文件取代它。

目前版本以 `app.js` 開頭的 `APP_VER` 為準（`index.html` 的 `?v=` 與 `sw.js` 的 `APP_STAMP` 必須同值，`tests/assets.test.js` 會驗），正式站是 <https://uqrqmmw.github.io/matha/>。全站使用暖白、石墨字與低彩度灰褐／橄欖色；正式 UI 圖示由專案內建 SVG 提供，不使用 emoji。離線核心題庫有 363 題，來源是人工撰寫與程式生成的數字變式，不是掃描 OCR。舊版 4,138 題掃描辨識私有題庫已撤出正式出題路徑，遠端檔案與平板舊快取即使仍存在也不會被抽到。25 份數學 PDF、6,720 頁的新 Mistral OCR 已完成，但在逐題對照原卷、圖形與答案校驗完成前仍不發布。S Pen 側鍵在掃描題本、逐題模考及十一單元默寫的所有書寫面皆為按住暫時擦除、放開恢復畫筆；橡皮擦以整段筆畫命中，快速直線的取樣點間隙也能擦除。

主要流程只有五個入口：「今日、大綱默寫、模考與破題、隔日訂正、觀念理解」。完整模考固定 20 題、100 分鐘，當天只批分；隔天依「直接會寫／只看答案能算出／必須看詳解」分成三級。隔日訂正沿用完整原卷工作台，可在放大的批改卷上直接重算；每道當前錯題都有固定的「看本題詳解」按鈕，首次產生後會保存內容與查看紀錄。考試原稿、第一次 AI 紅筆與隔日新增筆跡分層保存，看過詳解後仍須重新作答並通過 AI 批改才完成第三級。眼睛刷題同樣固定為一整回 20 題學測結構，只找切入點、不展開計算；完全沒方向的題鎖到隔天再想。使用者提供的十一單元大綱已建立 11/11 語意核對基準；三回紙本模考從私有高解析掃描即時拆成單頁，保留原數學式與圖形，並可直接在題目及右側留白書寫。原卷書寫採逐筆增量日誌：完成筆畫與刪除立即落到 IndexedDB、約一秒內小批次補傳 Supabase，長筆畫每 650ms 保存當前版本，整頁快照只作低頻檢查點；當機重開會保留最後頁碼與剩餘時間，也可手動匯出本回救援檔。舊速度工具、舊錯題庫與舊分析頁已從操作入口移除。完整設計與紙本整回匯入規格見 [`TEACHER_WORKFLOW_V2.md`](TEACHER_WORKFLOW_V2.md)。

從 `0825n` 起，AI 第一次簡批若看錯手寫答案，可只修正當前頁的辨識答案與分數，不必重跑整卷且保留覆核歷史。隔日訂正用四個固定步驟顯示目前該做的事；老師檢視可輸出單頁摘要或完整逐題紀錄。教材推薦題也能用零成本按鈕標記「一眼就會／換一題／單元不對／題目有問題」：這類動作不算作答、不污染能力證據，有問題的題會停止推薦並可從進度頁恢復。進度頁另顯示可由原始紀錄核對的進步事件，不用單純答題量製造成就感。

從 `0826a` 起，日常教材精選先收真正到期的錯題／2、7 日保留重測，再按目前能力證據混合打底、銜接、伸展三個訓練帶；冷啟動 10 題預設約 3／5／2，明顯斷裂時增加打底，穩定後才增加伸展。新版教材題庫校驗完成前由 363 題核心庫補位。`vec3`／`space` 舊製作代碼也會在匯入邊界轉成正式的 `svec`／`splane`。

## 快速開始

這個專案沒有 build step，也不需要 npm 才能執行。請用本機 HTTP server 開啟，讓 Service Worker、IndexedDB 與 PWA 行為符合正式站：

```powershell
py -3 -m http.server 8899 --bind 127.0.0.1
```

瀏覽 `http://127.0.0.1:8899/`。

## 驗證

Node 20 以上可執行完整的零依賴檢查：

```powershell
npm test
```

整份施工藍圖另有 fail-closed 完工稽核；它會重新核對完整卷來源、真機 JSON、詳批 gold／prediction、真人題庫簽核與私有部署記錄，不會用測試綠燈替代尚未發生的真人證據：

```powershell
python scripts/audit-blueprint-readiness.py
```

結果固定輸出到桌面的 `數學系統完工稽核.md` 與 `.json`。只有六道外部關卡全部以 exact-hash、具名真人或真機證據通過時，`complete` 才會是 `true`。

檢查內容包括：

- `app.js`、`bank.js`、`practice-bank.js`、`sw.js` 語法
- 內建題庫 schema 與 id 唯一性
- 私有題庫清洗、缺圖／超範圍隔離、emoji 移除、模板分群與下載雜湊驗證
- 固定公式核心變式的數量、單元分布、模板欄位與跨單元答案抽查
- 十一單元固定空白頁、兩日重測、破題方向兩日鎖定與定義卡排程
- 20 題／100 分正式模考結構、末三題共享題幹、多選部分給分、三級訂正與老師報告
- 三回私有原版模考的高解析單頁拆分、題上筆跡、暫停續寫、隔日鎖定與只讀 Storage 規則
- 分數、多根與座標答案判定
- 台灣日界與日期加減
- IndexedDB / localStorage 內容包與狀態合併，避免後備切換時丟資料
- 跨裝置 revision compare-and-swap 衝突重試
- 手寫原始筆畫逐筆日誌、刪除墓碑、低頻快照、批次冪等補傳、舊版上傳回報競態、當機時間／頁碼恢復與一次性裝置配對安全規則
- 6 頁、1200 筆的長時模考壓力情境、80 分鐘心跳復原，以及 400% 放大時每頁 12MP 畫布上限
- 逐題 AI 詳批的黃金案例：引用的第一錯步必須能在卷面轉錄中核對，否則降級且不寫入弱點模型
- AI 當頁誤讀覆核、四階段訂正、老師單頁摘要、題目品質隔離與跨裝置回報合併
- 批改後畫筆工具回復
- 無手寫筆跡時的批改後畫筆回復、換題自動回到題目頂端
- AI 回饋中的 LaTeX 界定符、落單貨幣符號與舊建議渲染
- 登出與配對權杖撤銷 scope
- 作答選項的鍵盤與螢幕閱讀器語意
- 公式卡、模擬卷、PWA shell、KaTeX 字型與 manifest 資產完整性
- 自製 SVG 圖示、純文字導覽、emoji 清理與低彩度設計 token

GitHub Actions 會在 push 與 pull request 自動執行同一套檢查。

## 架構

| 檔案 | 作用 |
|---|---|
| `index.html` | 靜態外殼、同源 vendor 載入、Service Worker 註冊 |
| `style.css` | 桌機／手機版面、考卷與整卡書寫層 |
| `bank.js` | 14 單元內建題庫、難度目標與級分表 |
| `practice-bank.js` | 可重算的核心數字變式與基準題 |
| `app.js` | 狀態、十一單元默寫、全真模考、破題方向、三級訂正、觀念理解、手寫 AI、同步與所有畫面 |
| `scripts/build-private-bank.js` | 把本機原始題庫清洗、分包並產生 SHA-256 manifest；輸出目錄不得進 Git |
| `sw.js` | network-first + 離線 shell 快取 |
| `vendor/` | 自架 KaTeX 與 Supabase browser client，正式站不依賴 CDN |
| `supabase/schema.sql` | 帶 revision 的 `app_state`、冪等 `ink_sessions`、`teacher_methods`、`content_packs`、私有原卷 bucket 與 RLS |
| `supabase/functions/device-pair/` | 為已登入帳號簽發一次性短效 magic-link token，不傳遞帳密或 session 權杖 |
| `tests/` | Node 內建 test runner 的回歸測試，沒有第三方依賴 |

執行時資料分三層：

1. `localStorage`：快速啟動的輕量鏡像，以及原卷每 5 秒一次的頁碼／剩餘時間恢復心跳；空間滿了不會成為單點故障。
2. `IndexedDB`：本機權威狀態、大型內容包、錯題縮圖，以及原卷逐筆／刪除增量日誌和低頻整頁快照。原卷不等待雲端才算保存。
3. Supabase：登入後以 revision compare-and-swap 合併跨裝置狀態；原卷增量日誌以 `client_id` 冪等、每批最多 80 筆補傳，依 `user_id + qid + updated_at` 索引分頁載回，另保存內容包與唯讀私有題庫。所有個人資料表與 Storage 都必須開 RLS。

## 安全與資料規則

- 公開 repo 只能放可公開的程式與內建內容；付費講義、官方受限內容、帳密、營運手冊與 service-role key 禁止提交。
- Supabase publishable key 可放前端；service-role key 絕對不可放前端。
- OpenAI API key 只保存在 Supabase 專案 `rrihysbxhsbxjteqmtdu` 的 Edge Function Secret；瀏覽器、`app_state`、localStorage 與備份都不保存 Key。AI 代理會以同一專案的登入權杖驗證使用者，未登入請求回傳 401。
- `matha-content` bucket 是私有且僅允許登入者讀取。舊版 4,138 題 manifest 已列為不可信世代，不再載入；檔案只保留作追溯，不代表可出題。新題庫必須符合 `textbook-catalog.js` 的 corpus generation、25 份來源 PDF canonical 清冊雜湊、Mistral OCR 來源與原卷／答案校驗政策，否則前端一律 fail closed。
- `matha-papers` bucket 同樣是私有、只允許登入者讀取，保存使用者提供的原版模考掃描；掃描檔不提交公開 repo，也不進 PWA 離線 shell。
- 配對連結只含一次性 magic-link token hash，有效一小時且使用後失效；不含密碼、access token 或 refresh token。舊版 base64 帳密與 session 配對格式不再接受。
- 匯入題目文字一律走白名單清洗；SVG 走獨立 SVG 白名單。不要把外部字串直接塞進 `innerHTML`。

## 發版檢查

1. 修改程式後更新 `app.js` 的 `APP_VER`。
2. 修改會影響離線 shell 的檔案時，更新 `sw.js` 的 `CACHE` 版本；CacheStorage 是同 origin 共用，清理時只能刪本 app 的 prefix。
3. 執行 `npm test`。
4. 用瀏覽器實跑桌機與約 390px 手機寬度：今日、大綱默寫、模考與破題、隔日訂正、觀念理解與進度設定。
5. 作答流程至少驗證一次「送出 → 批改 → 畫筆恢復但答案仍鎖定 → 下一題回到頁首」。手寫相關變更另需用 PointerEvent／實際畫筆驗證繼續加寫、復原與旋轉 resize。
6. 有真實憑證與硬體時，再補 AI 端到端、登入同步與平板觸控筆 smoke test；沒有實跑就不能宣稱這三條已驗證。

## 私有題庫重建

原始題庫與產物都不能提交到公開 repo。需要重建時指定來源與 repo 外輸出目錄：

```powershell
npm run build:private-bank -- --source "C:\path\to\_ALL.qpack.json" --output "C:\path\outside\repo\matha-private-content"
```

輸出的 manifest 預設不具發布資格；只有輸入明確帶齊 `corpusGeneration`、來源清冊雜湊、Mistral provider/model、原卷與答案校驗完成、數學正確性完成及獨立發布簽核時，`releaseReady` 才會是 `true`。通過後將內容雜湊題包上傳到私有 `matha-content` bucket，並把核准 manifest 同步為 `manifest-mistral-ocr4-verified-v1.json`；不能只更新未被前端讀取的 `manifest.json`。通過獨立複核的裁圖另上傳至私有 `matha-figures` bucket。前端逐檔比對 SHA-256；任何一層不符就拒絕整批加入並退回 363 題核心庫。

9→13 的閉環、成效指標與下一階段見 `PRODUCT_STRATEGY_9_TO_13.md`；新版學習流程與紙本整回匯入規格見 `TEACHER_WORKFLOW_V2.md`；本次搶救的 findings、驗證範圍與未驗證邊界見 `RESCUE_AUDIT_2026-07-16.md`。更完整的系統沿革與設計決策見 `WEB_APP_DESIGN.md`；其中舊行號與舊部署拓撲可能已過時，實作以目前程式與測試為準。
