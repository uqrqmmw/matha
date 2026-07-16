# OpenAI proxy

這個 Edge Function 是數A前端與 OpenAI Responses API 之間的安全代理。`OPENAI_API_KEY` 只存在 Supabase Secret，不會進入 `app.js`、localStorage、`app_state`、備份或公開 GitHub 程式碼。

## 專案配置

- 可管理的 Supabase 專案 `rrihysbxhsbxjteqmtdu` 同時負責登入、學習資料、私有題庫 Storage、`openai-proxy` 與 OpenAI Secret，不再依賴舊專案。
- Edge Function 的「Verify JWT with legacy secret」必須關閉；函式會自行把 Bearer token 交給同一專案 `/auth/v1/user` 驗證，未登入者一律回傳 401。

## Secrets

- `OPENAI_API_KEY`：必要。OpenAI Project API key。
- `OPENAI_MODEL`：選填，預設 `gpt-5.6`；OpenAI 目前實際回傳模型別名可能是 `gpt-5.6-sol`。
- `OPENAI_ALLOWED_EMAILS` 或 `OPENAI_ALLOWED_USER_IDS`：必要，至少設定一項。只有列入白名單的數A帳號能使用；多個值用逗號分隔。未設定時函式會拒絕服務，避免意外成為付費公開代理。
- `OPENAI_ALLOWED_ORIGINS`：選填。程式已內建正式 GitHub Pages 與 `127.0.0.1:8899`、`localhost:8899`；只有新增其他網站來源時才需要設定。

請在 Supabase Dashboard 的 Edge Functions → Secrets 儲存 Secret，避免 Key 留在 shell history 或 `.env`。更新 Secret 不必重新部署函式。

## 部署

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
