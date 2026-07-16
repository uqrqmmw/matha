# matha 搶救稽核（2026-07-16）

## 結論

最初救援誤在 `yen-2cats/matha` 進行；追查後確認真正原始專案是 `uqrqmmw/matha`，預設分支為 `master`，原始基線 commit 為 `88ef8fa`。最終版從該正確基線建立全新工作區與 `codex/uqr-rescue-4521` 分支，再逐項移植已驗證的安全修復、無印 UI、9→13 學習迴路與私有題庫載入器；舊錯誤 repo 只保留作遷移來源，不再當正式基線。

0716f 的語法與 40 個 Node 回歸案例均通過。4521 題來源經可重跑管線清洗後，4092 題進入私有 Storage；300 題缺圖、6 題超範圍、123 題重複而隔離。OpenAI Key 已透過正式 Supabase Edge Function 實際呼叫成功（HTTP 200、回覆 `OK`、模型 `gpt-5.6-sol`）；代理現已改用同一個可管理 Supabase 專案的 Auth，未登入請求確認回到 401。仍未驗證：新 Auth 真帳號的 AI 端到端與跨裝置同步、實體平板觸控筆。

## 已修復問題

| 風險 | 問題 | 修復與保護 |
|---|---|---|
| 高 | IndexedDB 可讀但曾寫入失敗時，新內容只在 localStorage；舊邏輯用全 store 最大 revision 二選一，可能漏掉另一側獨有題包 | 改為逐 pack 合併；同 pack 的 items 依 id/revision 聯集；metadata-only 更新也保留舊 items |
| 高 | Service Worker activation 會刪除同 origin 下所有非目前 cache，可能傷到同 GitHub Pages origin 的其他 PWA | 只清 `matha-v*` 自有 prefix，並以測試模擬外部 cache 不被刪除 |
| 中 | 送出題目會停用整張題卡按鈕；舊修復只有存在手寫筆跡時才恢復工具，沒有落筆的選擇／打字題仍維持 disabled | 批改一律排程恢復黑／紅／綠筆、復原、加長；答案選項與輸入欄維持鎖定，並以真瀏覽器重跑 |
| 中 | 批改後畫面會捲到詳解；按下一題時沿用舊 scroll position，導致新題從半頁開始 | `renderQuestion` 每次換題呼叫 `scrollQuestionTop()`；實測由 586px 回到 0px |
| 中 | 一般登出與「撤銷所有配對連結」語意混在一起，UI 誤稱任一裝置登出即可全域撤銷 | 一般登出固定 local scope；新增經確認的 global scope；同步修正文案與錯誤處理 |
| 中 | 同步狀態訊息與帳號 email 直接插入 HTML | 經 `escH` 跳脫後再渲染，並加入惡意字串回歸案例 |
| 中 | AI 回饋欄位只做 HTML escaping，會把模型傳回的 LaTeX 當普通文字；提示也可能誤判學生正確步驟 | 所有 AI 回饋、卡點與舊建議統一走 `rtAi`；補上 `$`／`$$`／混用界定符案例，提示詞要求先重算驗證再指出錯誤 |
| 低 | 單選題用可點擊 `div`，沒有原生鍵盤／輔助技術語意；KaTeX 手機選項缺清楚名稱 | 改用原生 button、focus-visible 與明確 `aria-label`；瀏覽器 accessibility tree 實查 |
| 低 | manifest theme color 與 HTML 不一致；README 幾乎空白；沒有可重跑的測試或 CI | 統一色碼；補齊執行／架構／安全／發版文件；加入零第三方依賴測試與 GitHub Actions |
| 低 | 全站充斥不一致、高彩度 emoji，桌機導覽密集，手機浮動狀態遮內容 | 改為低彩度無印風 token、自製 SVG sprite、動態 emoji 清理、桌機頂部／手機底部導覽與精簡狀態點 |

## 驗證紀錄

### 自動檢查

- `npm test`：40/40 通過。
- Node syntax：`app.js`、`bank.js`、`practice-bank.js`、`sw.js` 與私有題庫建置器通過。
- ESLint：`no-undef`、重複 key、unreachable、constant-condition 通過。
- 題庫：內建 schema 與 id 唯一性通過；私有題庫清洗、模板分群、缺圖／超範圍隔離、manifest 與 SHA-256 拒絕污染路徑通過。
- 模擬卷：連續產生 20 份，每份 12 題且不重複。
- 日期：台灣日界與跨年加減通過。
- PWA：shell 本機資產、KaTeX woff2、manifest、cache prefix 通過。
- Git：`git diff --check` 與 `git fsck --strict` 通過。
- 祕密掃描：工作樹與所有可達 commit 未找到 OpenAI／Supabase service-role／GitHub token 形狀的憑證；OpenAI Key 只存在 Supabase Secret，前端 publishable key 不視為 service secret。

### 真瀏覽器檢查

- 桌機與 390×844 手機 viewport 的九個主畫面均可渲染，無水平溢出，accessibility snapshot 與可見文字均無 emoji。
- 手機心算、公式翻卡、主題刷題、離開確認、手寫送出與自評流程可操作。
- 填充題以打字送出後，批改結果、詳解與下一題正常；五個畫筆工具恢復，答案欄仍鎖住。
- 從批改回饋按下一題後，頁面由 `scrollY=586` 回到 `0`，直接顯示新題題首。
- 正確工作區載入顯示 `0716f`；`app.js?v=0716f`、`practice-bank.js?v=0716f` 與 `matha-v31` 防止已安裝 PWA 沿用舊 JS。
- 桌機逐頁重跑九個主要功能，全部有內容、無水平溢出且 accessibility snapshot 不含 emoji；主題刷題實測「開始 5 題 → 放棄看答案 → 詳解 → 下一題」，下一題回到 `scrollY=0`。
- 單選與手機心算選項在 accessibility tree 中均為具名 button。

## 安全與資料邊界

- `supabase/schema.sql` 的個人資料表採 owner-only RLS；已在實際專案 `rrihysbxhsbxjteqmtdu` 套用。`matha-content` Storage 是 private bucket，只有 authenticated select policy；匿名讀寫均實測為拒絕。
- OpenAI Key 只存在同一專案的 Edge Function Secret，不進瀏覽器、備份或 `app_state`。函式透過同一專案 `/auth/v1/user` 驗證 Bearer token，未登入請求回傳 401，並只接受 `uqrqmmw.github.io` 與明列的本機來源。
- 配對 URL 含 session token，等同登入能力。global sign-out 會撤銷 refresh token；已簽發 access token 在到期前可能仍有效。
- AI 改用 OpenAI Responses API，預設要求 `gpt-5.6`，Structured Outputs 使用嚴格 JSON Schema，`store:false`，並傳送雜湊後的 `safety_identifier`。

官方參考：[Supabase sign-out scopes](https://supabase.com/docs/reference/javascript/auth-signout)、[Supabase Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets)、[OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)。

## 舊資料夾遷移

- 舊 `matha` 工作樹沒有未推送 commit，且就是正確 `uqrqmmw/matha` 的 `88ef8fa` 基線；最終工作不直接改動舊副本，而是另開 `matha-uqr-rescue-20260716`。
- 舊 `matha13` 主工作樹沒有未推送 commit，但落後其 upstream；其中兩個 untracked 檔已複製到獨立備份資料夾。隱藏 worktree 的未提交修改另見下方。
- 額外檢查 ignored files 後，發現 `.claude/`（36 檔、1,284,284 bytes）與 `20260711-ghost/`（2,484 檔、795,532,600 bytes，含講義 PDF、題包、抽取 JSON 與頁面圖）。兩者已完整複製至 legacy backup；逐檔 SHA-256 核對為 0 missing、0 extra、0 mismatch，且未放入公開 repo。
- `.claude` worktree 雖與遠端 commit 同步，仍有一份未提交的 `app.js`（12 additions／2 deletions）：它修正 `fixAiMath` 對 LaTeX `\\`、跳脫貨幣 `\$` 與落單 `$`／`$$` 的處理。該實質變更已人工比對、併入救援版並加入回歸案例，不只停留在備份裡。
- 本次沒有自動刪除任何舊資料夾。確認新副本與備份可開啟後，才建議由使用者刪除舊副本。

## 後續上線前必做

1. 在已登入的數A前端跑「測試連線、填充批改、追問、AI 老師」各一次，確認完整 UI 流程與費用。
2. 用兩個實際裝置登入同一 Supabase 帳號，交叉驗證作答、錯題、題包與 global sign-out；OpenAI Key 不應出現在任何裝置資料中。
3. 用真正觸控筆驗證 palm rejection、旋轉／resize、續寫、復原與批改紅框位置。
4. 0716f 合併到 `master` 後，在正式 GitHub Pages 重跑首頁、刷題、模擬、紙本模考登錄與未登入安全降級；真帳號建立後再補 AI 批改 smoke test。
