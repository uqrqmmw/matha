# OpenAI proxy

這個 Edge Function 是數A前端與 OpenAI Responses API 之間的安全代理。`OPENAI_API_KEY` 只存在 Supabase Secret，不會進入 `app.js`、localStorage、`app_state`、備份或公開 GitHub 程式碼。

目前支援六種嚴格 JSON Schema 回傳：一般手寫答案批改（`grade`）、解題過程分析（`process`）、十一單元手寫大綱比對（`outline`）、定義語意理解（`concept`）、原版掃描卷整卷批改（`paper_grade`）與逐題詳批（`paper_detail`）。另有三種不呼叫 OpenAI 的路由：`paper_key` 必須同時驗證 service-role 重讀的 immutable accepted submit attempt 與同回 app state 收據才回傳正式答案；`paper_solution` 必須驗證同題 DB-issued 隔日訂正 receipt，才從私有 `matha-solutions` bucket 簽發 15 分鐘官方詳解圖網址；`paper_audit_archive` 用 service role 重讀雲端作答狀態，只有 100 分鐘、Galaxy Tab、書寫、滑動翻頁、保存、canvas、恢復、PDF 內容綁定與本人逐頁像素核對全通過時，才把去識別、hash-addressed JSON 封存到 service-role-only 的 `matha-audit-private/runtime-audits`。逐題詳批同樣只接受這份收據：RPC 只在 accepted 後的下一個 `Asia/Taipei` 日期開始後核發，且必須驗證該題所在頁的雲端 client/revision/updated-at/strokes digest 與未刪除手寫筆跡。收據在同一交易中同時封存本題當下全部 live 筆跡與本輪 new 筆跡的 `id/qno/pts/c/w/t0/t1`、每筆 geometry digest；前者可完整重建多輪解題，後者證明本輪確有新 effort。兩組皆限制筆數、點數、座標、壓力、筆寬與 JSON bytes，後續驗證會重算並交叉核對 ID/digest/geometry，不能再從可變的 `ink_sessions` 補取、刪除或替換幾何。`app_state` 的 attempts/log 只作 UX 記錄，不是解鎖權威。逐題詳批固定回傳診斷信心、可驗證的正確前綴、第一錯步原式、錯因、最小修正與完整解法；低信心結果不寫入弱點模型。所有密集卷面都以 Responses API 圖片輸入的 `detail: original` 傳入，不先縮成低解析度；大綱原文只來自使用者的私人內容層。

訂正 AI 再批改不得直接走 generic `grade` 後就解鎖。Migration `202608300010` 提供 service-role-only 的 `matha_paper_correction_grade_job_claim`、`..._mark_dispatched`、`..._complete`、`..._status`：job 唯一綁定 user/run/source/question/retry receipt id+digest/model-input binding。`claim.action=invoke` 是唯一可呼叫模型的情況，且 Edge 必須先成功 `mark_dispatched`；之後任何重試只會收到 `pending`，不會自動重送。`complete` 由 DB 正規化雜湊 result/metadata 並建立 immutable result receipt；同內容重播回完全相同資料，內容或 binding 漂移一律拒絕。

## 專案配置

- 可管理的 Supabase 專案 `rrihysbxhsbxjteqmtdu` 同時負責登入、學習資料、私有題庫 Storage、`openai-proxy` 與 OpenAI Secret，不再依賴舊專案。
- Edge Function 的「Verify JWT with legacy secret」必須關閉；函式會自行把 Bearer token 交給同一專案 `/auth/v1/user` 驗證，未登入者一律回傳 401。
- `matha-solutions` bucket 必須維持 private 且不得建立 authenticated select policy；一般 Storage client 不能讀取，只有通過訂正閘門的 Edge Function 可用 service role 簽短效網址。物件路徑對照只存在後端，不進前端、離線快取或學習狀態。
- `matha-content` 是核准學員可讀的 JSON-only 題庫，不得存真機證據。`matha-audit-private` 必須維持 private、14 MiB、只允許 PDF/JSON，而且不得建立 authenticated/public 的 Storage policy；真機與能力證據只由 Edge service role 寫入並立即回讀。
- 整卷批改的模型輸入是瀏覽器合成影像；Edge 會把固定 prompt、逐頁影像雜湊、accepted submit attempt、服務端筆跡回讀與 grade receipt 一起封存，但不宣稱能在伺服器重建相同像素。能力關卡另要求登入本人逐頁查看後的 exact-input self-attestation；這是具名視覺確認，不是密碼學上的伺服器像素證明，任一頁或任一 digest 不符都 fail closed。
- `paper_grade_jobs` 是 service-role-only 的整卷批改狀態機。generation 0 對同一 accepted submit winner 只能有一個 DB winner；並發裝置只能取得 pending，完成後的重試只會讀回 DB 中同一份 JSON、model metadata 與完整私有 receipt envelope。租約只允許在「尚未標記送出模型」前逾時接管；一旦 `dispatched`，即使 Edge／網路逾時也絕不自動重送，因為模型可能已收件計費。使用者若明確選擇重新簡批，前端以目前已知 generation 作 compare-and-set base；兩台從同一代用不同 request id 申請時只會共用下一代，只有看見下一代後再次明確重批才可核發再下一代。
- 模型完成後，Edge 會先把 normalized JSON、model metadata 與完整 receipt envelope 寫到由 user/run/accepted attempt/generation/model-input digest 唯一決定的 `matha-audit-private/grade-completions` 路徑，再逐位元回讀並驗 SHA；DB 只能透過 service-role recovery RPC 從這個驗證過的 artifact 原子完成。migration 007 會撤銷舊的 `matha_paper_grade_job_complete` JSON-only RPC，並以 validated constraint 保證每一筆 `completed` row 都帶完整 artifact authority；service role 也沒有旁路。若 Edge 在 Storage 成功後、DB 完成前中斷，`paper_grade_status` 會從同一路徑恢復，絕不再呼叫模型；DB 已完成後即使原 Storage 物件稍後不可用，Edge 仍可從 immutable row 精確讀回同一結果與 artifact digest。若 `dispatched` 15 分鐘後仍無 artifact，狀態明示為 terminal `lost`，只接受使用者明確核發下一 generation，不會永久顯示假 pending。
- 不同裝置可能把同一筆跡合成為不同 JPEG bytes。同一 accepted attempt＋generation 已存在時，DB 會先依 generation 回既有 completed/pending，不會因新 composite digest 漂移而隱藏結果或再次呼叫模型。只有從未 leased 的純 `reserved` job，或租約已過期且從未 `dispatched` 的 job，可在 advisory lock 內安全改綁 retry composite 並換發 lease；舊 worker 的 binding/token 隨即失效。`dispatched` 之後 binding 永久不可變。`paper_grade_status` 是不建立、不租用 job 的指定世代私有查詢；`paper_grade_latest_status` 則只讀取伺服器最高世代，供兩台裝置合併不同重批意圖時對帳。兩者都不扣額度、不建立 job、不取得 lease，也不呼叫模型。
- 在組出模型 composite 前，瀏覽器會用 accepted run 的逐頁 reference 重讀 cloud `proc/strokes`、重建與 immutable submit attempt 相同 schema 的 snapshot digest，並確認目前唯讀 session 的可見筆跡完全相同。superseded 裝置若保有另一份筆跡，只能用 status-only 路徑讀既有 completed/pending；不存在 job 時 fail closed，模型不會被呼叫。Edge 也會自行從 service-role ink readback 重算相同 digest，並在 claim/model 前比對 DB accepted attempt。
- Accepted submit RPC 會在與 ink write 相同的 advisory lock 內，逐頁比對 qid/client/revision/updated-at/strokes digest，並把 winner manifest 寫入 immutable attempt。之後的恢復、批改、結果、重批與 PDF 都只載入 manifest 指定的 winner client checkpoint；同 run 其他裝置的筆跡保留救援但不混入正式產物。
- `paper-mock-1` 使用 Edge 內建的 server-owned 20 題答案與固定 PDF 頁面/content digest，可作為 `calibrationEligible:false` 的歷史練習安全批改；它仍不在 `CAPABILITY_FRESH_SOURCE_IDS`，不能進正式能力封存。沒有新版 immutable accepted submit receipt 的舊 run 只能查看舊批改或人工修正，UI 不會追溯偽造收據或送出一個必然 403 的重批。
- PDF 格式、頁數、位元 SHA 與 `contentBindingSha256` 只證明檔案完整性及其 run／題本資產版本／版面／逐頁雲端筆跡／批改版本綁定，**不等於逐像素內容正確**。正式真機封存還需要本人逐頁開啟 PDF 後產生、且綁定相同兩個 SHA 的 `pdfPixelQa`。

## Secrets

- `OPENAI_API_KEY`：必要。OpenAI Project API key。
- 模型固定在程式內的 `gpt-5.5`。所有 AI 功能共用這一個模型，不讀取模型環境變數，也不做自動升級、降級或模型分流。
- `OPENAI_ALLOWED_EMAILS` 或 `OPENAI_ALLOWED_USER_IDS`：必要，至少設定一項。只有列入白名單的數A帳號能使用；多個值用逗號分隔。未設定時函式會拒絕服務，避免意外成為付費公開代理。
- `OPENAI_ALLOWED_ORIGINS`：選填。程式已內建正式 GitHub Pages 與 `127.0.0.1:8899`、`localhost:8899`；只有新增其他網站來源時才需要設定。
- `PAPER_ANSWER_KEYS_JSON`：啟用未作答原卷前必要。JSON object 的 key 是核准的 `paper-mock-*` 或 `paper-official-*` source id，value 是逐題 `{type,ans,display?,points,scoringPrinciples?}`；只放 Supabase Secret，不得提交 repo、Storage、`app_state` 或前端。

請在 Supabase Dashboard 的 Edge Functions → Secrets 儲存 Secret，避免 Key 留在 shell history 或 `.env`。更新 Secret 不必重新部署函式。

## 程式結構與測試

- `index.ts`：設定、驗證登入、額度扣抵/退還、呼叫 OpenAI。
- `lib.ts`：純邏輯（訊息正規化、schema、詳批解鎖判定…），不碰環境變數與網路。
- `lib.test.ts`：`deno test` 行為測試（CI 會跑；零遠端依賴）。
- 一般 AI 呼叫失敗（逾時/HTTP 錯誤/沒回文字）會呼叫 `refund_ai_request` 退還本次額度；token 用量記回扣額當天（跨午夜不漏記）。整卷 `paper_grade` 在 DB 標記 `dispatched` 後例外：未知結果不退款後重送，而是維持 pending，直到讀回同代完成結果或使用者明確核發新 generation，避免重複模型費用。

## 已知保留／刪除限制

- DB migration 已讓 `auth.users` 的 `ON DELETE CASCADE` 可刪除 `paper_submit_attempts` 與 `paper_grade_jobs`，同時一般 authenticated role 仍沒有 DELETE grant/policy，正常操作維持 append-only。
- **尚未完成完整帳號刪除工作流**：`matha-audit-private` 的 grade receipts、grade completion artifacts、visual attestations 與 runtime PDFs 不會因 Postgres FK cascade 自動刪除。正式提供「刪除帳號」前，必須另做 service-role-only 流程：以去識別 user prefix 列出全部物件、逐檔刪除、再次列舉確認為空，最後才刪 auth user；任一步失敗都不得宣稱帳號私人資料已清除。

## 部署

完整程序(含 schema 套用順序與驗證步驟)見 `supabase/DEPLOY.md`。

```powershell
npx supabase login
npx supabase functions deploy openai-proxy --project-ref rrihysbxhsbxjteqmtdu --no-verify-jwt
```

部署前執行：

```powershell
npx deno-bin check --config supabase/functions/deno.json supabase/functions/openai-proxy/index.ts
npm test
```

正式版不提供未登入的 Key 測試入口。連線測試必須由已登入的數A前端發出，避免把付費 API 變成公開代理。
