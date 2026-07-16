# 數A特訓

給學測數A考生使用的離線優先 PWA。它把十一單元空白默寫、全真模考、破題方向訓練、隔日三級訂正、重要定義理解、手寫 AI 比對與跨裝置同步放在同一個純前端 app 裡。

目前版本為 `0717a`，正式站是 <https://uqrqmmw.github.io/matha/>。全站使用暖白、石墨字與低彩度灰褐／橄欖色；正式 UI 圖示由專案內建 SVG 提供，不使用 emoji。離線核心題庫有 363 題；登入後再載入 4092 題經清洗、雜湊驗證且不公開上 GitHub 的私有題庫，共 4455 題可用。

主要流程只有五個入口：「今日、大綱默寫、模考與破題、隔日訂正、觀念理解」。完整模考固定 20 題、100 分鐘，當天只批分；隔天依「直接會寫／只看答案能算出／必須看詳解」分成三級。眼睛刷題只找一個切入點，完全沒方向的題鎖到隔天再想。舊速度工具、舊錯題庫與舊分析頁已從操作入口移除。完整設計與紙本整回匯入規格見 [`TEACHER_WORKFLOW_V2.md`](TEACHER_WORKFLOW_V2.md)。

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

檢查內容包括：

- `app.js`、`bank.js`、`practice-bank.js`、`sw.js` 語法
- 內建題庫 schema 與 id 唯一性
- 私有題庫清洗、缺圖／超範圍隔離、emoji 移除、模板分群與下載雜湊驗證
- 固定公式核心變式的數量、單元分布、模板欄位與跨單元答案抽查
- 十一單元固定空白頁、兩日重測、破題方向兩日鎖定與定義卡排程
- 20 題／100 分正式模考結構、末三題共享題幹、多選部分給分、三級訂正與老師報告
- 分數、多根與座標答案判定
- 台灣日界與日期加減
- IndexedDB / localStorage 內容包與狀態合併，避免後備切換時丟資料
- 跨裝置 revision compare-and-swap 衝突重試
- 手寫原始筆畫持久化、冪等補傳與一次性裝置配對安全規則
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
| `supabase/schema.sql` | 帶 revision 的 `app_state`、冪等 `ink_sessions`、`teacher_methods`、`content_packs` 與 RLS |
| `supabase/functions/device-pair/` | 為已登入帳號簽發一次性短效 magic-link token，不傳遞帳密或 session 權杖 |
| `tests/` | Node 內建 test runner 的回歸測試，沒有第三方依賴 |

執行時資料分三層：

1. `localStorage`：只作為快速啟動的輕量鏡像；空間滿了不會成為單點故障。
2. `IndexedDB`：本機權威狀態、大型內容包、錯題縮圖，以及尚未上傳的完整原始筆跡。
3. Supabase：登入後以 revision compare-and-swap 合併跨裝置狀態；筆跡以 `client_id` 冪等補傳，另保存內容包與唯讀私有題庫。所有個人資料表與 Storage 都必須開 RLS。

## 安全與資料規則

- 公開 repo 只能放可公開的程式與內建內容；付費講義、官方受限內容、帳密、營運手冊與 service-role key 禁止提交。
- Supabase publishable key 可放前端；service-role key 絕對不可放前端。
- OpenAI API key 只保存在 Supabase 專案 `rrihysbxhsbxjteqmtdu` 的 Edge Function Secret；瀏覽器、`app_state`、localStorage 與備份都不保存 Key。AI 代理會以同一專案的登入權杖驗證使用者，未登入請求回傳 401。
- `matha-content` bucket 是私有且僅允許登入者讀取。4521 題原始來源中，4092 題通過清洗；300 題因缺圖、6 題超出數A範圍、123 題重複而隔離，不會默默混入練習。
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

將輸出的 10 個單元包與 `manifest.json` 上傳到私有 `matha-content` bucket。前端只在登入後下載，逐檔比對 SHA-256；任一檔案不符就拒絕加入題庫，並退回 363 題離線核心庫。

9→13 的閉環、成效指標與下一階段見 `PRODUCT_STRATEGY_9_TO_13.md`；新版學習流程與紙本整回匯入規格見 `TEACHER_WORKFLOW_V2.md`；本次搶救的 findings、驗證範圍與未驗證邊界見 `RESCUE_AUDIT_2026-07-16.md`。更完整的系統沿革與設計決策見 `WEB_APP_DESIGN.md`；其中舊行號與舊部署拓撲可能已過時，實作以目前程式與測試為準。
