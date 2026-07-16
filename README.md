# 數A特訓

給學測數A考生使用的離線優先 PWA。它把題庫、限時訓練、整卡手寫、AI 批改、錯題間隔複習、模擬卷與跨裝置同步放在同一個純前端 app 裡。

目前版本為 `0716f`，正式站是 <https://uqrqmmw.github.io/matha/>。全站已重做為暖白、石墨字與低彩度灰褐／橄欖色的簡潔介面；導覽與狀態圖示使用專案內建的 SVG，不以 emoji 當正式 UI。離線核心題庫有 362 題；登入後再載入 4092 題經清洗、雜湊驗證且不公開上 GitHub 的私有題庫，共 4454 題可用。首頁以完整模擬校準 9→13 級分，並依到期錯題、校準需求與弱項產生唯一的下一步。

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
- 280 題固定公式核心變式的數量、單元分布、模板欄位與跨單元答案抽查
- 完整模擬校準、三場穩定門檻、下一步優先序、猜中回收與實體模考訊號
- 分數、多根與座標答案判定
- 台灣日界與日期加減
- IndexedDB / localStorage 內容包合併，避免後備切換時丟資料
- 跨裝置狀態合併
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
| `practice-bank.js` | 280 題可重算的核心數字變式；14 單元各 20 題 |
| `app.js` | 狀態、題目流程、手寫、AI、錯題、模擬、同步與所有畫面 |
| `scripts/build-private-bank.js` | 把本機原始題庫清洗、分包並產生 SHA-256 manifest；輸出目錄不得進 Git |
| `sw.js` | network-first + 離線 shell 快取 |
| `vendor/` | 自架 KaTeX 與 Supabase browser client，正式站不依賴 CDN |
| `supabase/schema.sql` | `app_state`、`ink_sessions`、`teacher_methods`、`content_packs` 與 RLS |
| `tests/` | Node 內建 test runner 的回歸測試，沒有第三方依賴 |

執行時資料分三層：

1. `localStorage`：輕量作答狀態與離線鏡像。
2. `IndexedDB`：大型內容包與錯題手寫縮圖。
3. Supabase：登入後的跨裝置狀態、內容包、手寫歸檔與唯讀私有題庫；所有個人資料表與 Storage 都必須開 RLS。

## 安全與資料規則

- 公開 repo 只能放可公開的程式與內建內容；付費講義、官方受限內容、帳密、營運手冊與 service-role key 禁止提交。
- Supabase publishable key 可放前端；service-role key 絕對不可放前端。
- OpenAI API key 只保存在 Supabase 專案 `rrihysbxhsbxjteqmtdu` 的 Edge Function Secret；瀏覽器、`app_state`、localStorage 與備份都不保存 Key。AI 代理會以同一專案的登入權杖驗證使用者，未登入請求回傳 401。
- `matha-content` bucket 是私有且僅允許登入者讀取。4521 題原始來源中，4092 題通過清洗；300 題因缺圖、6 題超出數A範圍、123 題重複而隔離，不會默默混入練習。
- 配對連結含 session 權杖，等同登入能力。一般「登出這台」只清本機；要讓舊配對連結失效，必須使用「撤銷所有登入／配對連結」。既有 access token 仍會到期才完全失效。
- 匯入題目文字一律走白名單清洗；SVG 走獨立 SVG 白名單。不要把外部字串直接塞進 `innerHTML`。

## 發版檢查

1. 修改程式後更新 `app.js` 的 `APP_VER`。
2. 修改會影響離線 shell 的檔案時，更新 `sw.js` 的 `CACHE` 版本；CacheStorage 是同 origin 共用，清理時只能刪本 app 的 prefix。
3. 執行 `npm test`。
4. 用瀏覽器實跑桌機與約 390px 手機寬度：首頁、手機心算、公式卡、主題刷題、模擬、錯題、數據與作戰計畫。
5. 作答流程至少驗證一次「送出 → 批改 → 畫筆恢復但答案仍鎖定 → 下一題回到頁首」。手寫相關變更另需用 PointerEvent／實際畫筆驗證繼續加寫、復原與旋轉 resize。
6. 有真實憑證與硬體時，再補 AI 端到端、登入同步與平板觸控筆 smoke test；沒有實跑就不能宣稱這三條已驗證。

## 私有題庫重建

原始題庫與產物都不能提交到公開 repo。需要重建時指定來源與 repo 外輸出目錄：

```powershell
npm run build:private-bank -- --source "C:\path\to\_ALL.qpack.json" --output "C:\path\outside\repo\matha-private-content"
```

將輸出的 10 個單元包與 `manifest.json` 上傳到私有 `matha-content` bucket。前端只在登入後下載，逐檔比對 SHA-256；任一檔案不符就拒絕加入題庫，並退回 362 題離線核心庫。

9→13 的閉環、成效指標與下一階段見 `PRODUCT_STRATEGY_9_TO_13.md`；本次搶救的 findings、驗證範圍與未驗證邊界見 `RESCUE_AUDIT_2026-07-16.md`。更完整的系統沿革與設計決策見 `WEB_APP_DESIGN.md`；其中舊行號與舊部署拓撲可能已過時，實作以目前程式與測試為準。
