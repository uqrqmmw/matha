# OpenAI proxy

這個 Edge Function 是數A前端與 OpenAI Responses API 之間的安全代理。`OPENAI_API_KEY` 只存在 Supabase Secret，不會進入 `app.js`、localStorage、`app_state`、備份或公開 GitHub 程式碼。

目前支援六種嚴格 JSON Schema 回傳：一般手寫答案批改（`grade`）、解題過程分析（`process`）、十一單元手寫大綱比對（`outline`）、定義語意理解（`concept`）、原版掃描卷整卷批改（`paper_grade`）與逐題詳批（`paper_detail`，由後端驗證隔日＋至少一次獨立重想才解鎖）。另有兩種不呼叫 OpenAI 的私有素材路由：`paper_key` 只在伺服器端 `app_state` 已保存同一回交卷狀態後回傳正式答案；`paper_solution` 只在同一回、同一題已到隔日且保存至少一次真實重想後，從私有 `matha-solutions` bucket 簽發 15 分鐘官方詳解圖網址。逐題詳批固定回傳診斷信心、可驗證的正確前綴、第一錯步原式、錯因、最小修正與完整解法；低信心結果不寫入弱點模型。所有密集卷面都以 Responses API 圖片輸入的 `detail: original` 傳入，不先縮成低解析度；大綱原文只來自使用者的私人內容層。

## 專案配置

- 可管理的 Supabase 專案 `rrihysbxhsbxjteqmtdu` 同時負責登入、學習資料、私有題庫 Storage、`openai-proxy` 與 OpenAI Secret，不再依賴舊專案。
- Edge Function 的「Verify JWT with legacy secret」必須關閉；函式會自行把 Bearer token 交給同一專案 `/auth/v1/user` 驗證，未登入者一律回傳 401。
- `matha-solutions` bucket 必須維持 private 且不得建立 authenticated select policy；一般 Storage client 不能讀取，只有通過訂正閘門的 Edge Function 可用 service role 簽短效網址。物件路徑對照只存在後端，不進前端、離線快取或學習狀態。

## Secrets

- `OPENAI_API_KEY`：必要。OpenAI Project API key。
- 模型固定在程式內的 `gpt-5.5`。所有 AI 功能共用這一個模型，不讀取模型環境變數，也不做自動升級、降級或模型分流。
- `OPENAI_ALLOWED_EMAILS` 或 `OPENAI_ALLOWED_USER_IDS`：必要，至少設定一項。只有列入白名單的數A帳號能使用；多個值用逗號分隔。未設定時函式會拒絕服務，避免意外成為付費公開代理。
- `OPENAI_ALLOWED_ORIGINS`：選填。程式已內建正式 GitHub Pages 與 `127.0.0.1:8899`、`localhost:8899`；只有新增其他網站來源時才需要設定。
- `PAPER_ANSWER_KEYS_JSON`：啟用未作答原卷前必要。JSON object 的 key 是 `paper-mock-*`，value 是逐題 `{type,ans,display?,points}`；只放 Supabase Secret，不得提交 repo、Storage、`app_state` 或前端。

請在 Supabase Dashboard 的 Edge Functions → Secrets 儲存 Secret，避免 Key 留在 shell history 或 `.env`。更新 Secret 不必重新部署函式。

## 程式結構與測試

- `index.ts`：設定、驗證登入、額度扣抵/退還、呼叫 OpenAI。
- `lib.ts`：純邏輯（訊息正規化、schema、詳批解鎖判定…），不碰環境變數與網路。
- `lib.test.ts`：`deno test` 行為測試（CI 會跑；零遠端依賴）。
- OpenAI 呼叫失敗（逾時/HTTP 錯誤/沒回文字）會呼叫 `refund_ai_request` 退還本次額度；token 用量記回扣額當天（跨午夜不漏記）。

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
