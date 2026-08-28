# Supabase 部署 runbook

repo 的 main 改了 `supabase/` 底下的東西之後,GitHub Pages 只會自動部署前端;
**Supabase 端(資料庫 schema、Edge Functions)要照本文手動套用**。
專案 ref:`rrihysbxhsbxjteqmtdu`。

## 順序鐵則

**先套用 schema.sql,再部署 Edge Functions。**
函式的新版程式可能呼叫新的資料庫函式;SQL 沒先套用就部署,這些呼叫會靜默失敗。
反過來先跑 SQL 永遠安全:舊版函式不受影響。

## 0. 準備 Access Token

<https://supabase.com/dashboard/account/tokens> 產生 Personal Access Token(`sbp_` 開頭):

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxxxxxxxx"   # 只在本次終端機生效
```

之後所有 `npx supabase` 指令免互動式 login。**用完關終端機或撤銷 token。**

## 1. 套用 schema.sql(冪等,可重複執行)

整份 `supabase/schema.sql` 設計成可重跑(`if not exists` / `create or replace` /
`drop ... if exists`),對既有資料零破壞。

### 做法 A(可全自動):Management API

```powershell
$sql  = Get-Content -Raw supabase/schema.sql
$body = @{ query = $sql } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method Post `
  -Uri "https://api.supabase.com/v1/projects/rrihysbxhsbxjteqmtdu/database/query" `
  -Headers @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN" } `
  -ContentType "application/json" -Body $body
```

回傳 JSON 即成功;SQL 錯誤會回 4xx 帶訊息。

### 做法 B(人工):Dashboard → SQL Editor → 貼上整份 → Run

### 驗證

查 `public` schema 的關鍵函式簽名,確認與 schema.sql 一致、且**沒有殘留舊 overload**:

```powershell
$check = @{ query = "select proname, pg_get_function_identity_arguments(oid) as args from pg_proc where pronamespace = 'public'::regnamespace and proname in ('refund_ai_request','record_ai_usage','claim_ai_request','is_matha_user') order by proname;" } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method Post `
  -Uri "https://api.supabase.com/v1/projects/rrihysbxhsbxjteqmtdu/database/query" `
  -Headers @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN" } `
  -ContentType "application/json" -Body $check
```

每個函式應恰好一筆。同名出現兩筆＝舊簽名沒清掉,對照 schema.sql 裡的
`drop function if exists` 區塊補跑對應那行。

## 2. 部署 Edge Functions

若本次新增或更換未作答原卷，先把私有答案 env 檔寫入 Supabase Secret。env 檔必須在 repo 外，且不得把內容貼進 issue、commit 或終端歷史：

```powershell
npx supabase secrets set --env-file "C:\path\outside-repo\matha-paper-answer-keys.private.env" --project-ref rrihysbxhsbxjteqmtdu
```

用 `npx supabase secrets list --project-ref rrihysbxhsbxjteqmtdu` 只核對 `PAPER_ANSWER_KEYS_JSON` 名稱存在；CLI 不會顯示 Secret 值。

在 repo 根目錄(`--no-verify-jwt` 必帶:函式自己驗 token,見 openai-proxy/README.md):

```powershell
npx supabase functions deploy openai-proxy --project-ref rrihysbxhsbxjteqmtdu --no-verify-jwt
npx supabase functions deploy device-pair  --project-ref rrihysbxhsbxjteqmtdu --no-verify-jwt
```

`openai-proxy` 是多檔案(`index.ts` + `lib.ts`),CLI 會整個目錄打包。

### 驗證

1. 版本有換上去(`updated_at` 是剛剛、`version` +1):

   ```powershell
   Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/rrihysbxhsbxjteqmtdu/functions" `
     -Headers @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN" } |
     Select-Object slug, version, updated_at
   ```

2. 未登入請求被正確拒絕(預期 HTTP 401「請先登入數A帳號」):

   ```powershell
   Invoke-WebRequest -Method Post -SkipHttpErrorCheck `
     -Uri "https://rrihysbxhsbxjteqmtdu.supabase.co/functions/v1/openai-proxy" `
     -ContentType "application/json" -Body '{}' | Select-Object StatusCode, Content
   ```

3. 端到端:開正式站登入,任一題手寫送 AI 批改一次,正常回饋即完成。

## 部署前的本機檢查

```powershell
npm test
npx deno-bin fmt --check supabase/functions/openai-proxy/index.ts supabase/functions/openai-proxy/lib.ts supabase/functions/openai-proxy/lib.test.ts supabase/functions/device-pair/index.ts
npx deno-bin check --node-modules-dir=auto supabase/functions/openai-proxy/index.ts supabase/functions/openai-proxy/lib.test.ts supabase/functions/device-pair/index.ts
npx deno-bin test supabase/functions/openai-proxy/lib.test.ts
```

（CI 對 main 也會跑同一套;紅燈就不要部署。）

## 不要做的事

- Secrets(`OPENAI_API_KEY`、`OPENAI_ALLOWED_EMAILS/USER_IDS`…)平常不用動;
  要改只在 Dashboard → Edge Functions → Secrets,絕不進 repo 或 shell history。
- 不要動 Storage bucket 內容、`app_users` 資料列、認證設定,除非該次變更明確要求。
- 不要拿 service_role key 放進任何前端或 repo 檔案。
