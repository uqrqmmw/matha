# 數A特訓工程驗收摘要（2026-08-29；2026-08-31 收尾更新）

本檔只記錄可由程式與雜湊驗證的工程證據，不把尚未發生的本人作答、Galaxy Tab 真機長考或個人詳批 gold 冒充完成。

## 原卷交卷與詳批可靠性協定

- Supabase migration 001–011 已部署至專案 `rrihysbxhsbxjteqmtdu`，部署後由 CLI 回讀確認 local／remote 逐筆一致。
- 交卷、accepted ink、逐頁 manifest、整卷批改、隔日訂正與逐題詳批各自有伺服器權威狀態；瀏覽器合成影像、messages 與 instructions 不再是批改真值。
- `paper_detail_jobs` 以 run／source／question／accepted attempt／retry receipt／generation 唯一綁定；只有本人明確重跑才建立 N+1，已 dispatched 的工作不會因重載自動重送。
- 詳批完成 receipt 綁定凍結模型輸入、結果與 metadata digest；App 重算全部 digest 後才保存，篡改或不同世代結果一律拒絕。
- `openai-proxy` 遠端版本 37 已部署；下載回讀的 9 個執行檔與本機逐檔 SHA-256 完全一致。無登入 POST 回 401、CORS 預檢回 204；驗證期間未呼叫 OpenAI API。
- App 快取版本為 `0830c`，正式卷協定版本另固定為 `0830b`；一般前端快取更新不會使既有或進行中的正式卷失效。

## 私有教材先遣庫

- 已直接檢視 Batch 01–06、10，共 245 題的原題、去筆跡題面、移除像素與官方答案。
- 217 題通過，28 題因必要圖線／灰階受損、殘留筆跡、混題裁切或官方答案無法明確綁定而隔離。
- 14 單元各 13–18 題；例題 114、章末簡單 56、中等 34、困難 13。
- 平衡版 release ID：`starter-ae19e7c7061200e7`。
- 簽核題源 SHA-256：`6e014d34223e865c10eb783058282eec362595b8d4966dccf340dc2be53f8b45`。
- 此版採擁有者明確委託的代理直接像素／答案審核；授權、執行者、完整批次與每份審核雜湊都寫入簽核鏈，並明列 `humanPixelReviewClaimed:false`。這是被允許的透明 owner-delegated 流程，不要求把代理冒充具名真人。
- manifest、內容包與 217 張題圖皆使用版本化路徑；固定 alias 只允許在全部上傳並回讀雜湊後最後切換。
- 部署器會在固定 alias 切換前，先以原子寫檔保存上一版 alias bytes、新舊雜湊與完整上傳清冊；即使網路回應遺失或程序在切換途中終止，prepared record 仍可直接驅動安全回滾。
- 2026-08-30 Supabase 專案安全重啟後 Storage 恢復；同一 upload plan 已實際完成 D1 → 綁定 D1 的回滾 → 時間較晚且記錄不同的 D2。回滾成功恢復 153 題舊 alias，D2 再切到 217 題正式 alias，未重跑或重付任何 OCR／去筆跡服務。
- D2 後 Storage verifier 已全量回讀固定 alias 與 410 個版本化物件，核對 217 題、191 題包、14 單元、角色分布、全部題圖引用及簽核題源，並透過簽核鏈重驗 217 張答案裁圖；結果 `status: verified`、雜湊錯配 0。
- 啟用中的真實登入使用者已用 JWT／RLS 讀回 191 題包與 217/217 題圖；17 張 signed URL 樣本覆蓋 14 單元與例題／簡單／中等／困難 4 種角色。此 App loader 證據與 Storage 證據均綁 D2、`APP_VER 0830b`、`app.js` SHA 與正式 alias SHA。

## 平板資料安全壓測

`tests/paper-stress.test.js` 與 `tests/paper-stability.test.js` 驗證：

- 6 頁、1,200 筆增量筆跡跨裝置合併不遺失、不重複，刪除墓碑不復活。
- 960 次心跳模擬 80 分鐘後當機，重開凍結正確剩餘時間與頁碼。
- 400% 放大、DPR 4 時每頁 backing store 仍低於 12MP。
- 保存失敗會保留 dirty 狀態並持續退避重試，成功前不顯示安全。
- 頁面切換、保存樣本、事件監聽與 runtime audit 陣列都有固定上限。
- 救援 JSON、作答 PDF 與批改 PDF 的輸出路徑有回歸測試。

## 批改與學習閉環

- 首輪核分使用官方答案；AI 只讀卷與定位，不能改總分真值。
- 人工覆核保存時依狀態正規化題分：正確必為滿分，未答／看不清楚必為 0；總分與能力證據共用同一防線，不會保留 AI 舊分。
- 首輪只顯示對錯、配分與正解；隔日留下重想後才解鎖官方詳解與 GPT-5.5 詳批。
- 詳批 schema 保存做對部分、第一錯步、流程斷點、證據與信心；沒有可核對證據時必須 abstain。
- 複選逐項標示漏選／錯選，紅筆吸附學生作答區，不覆蓋印刷題面。
- 弱點至少需兩道不同題的證據；推薦限制同來源與同模板重複，單次錯誤不宣告穩定弱項。

## 自動測試

- 2026-08-31 本地收尾版：Web／PWA 319 項（317 通過、2 項真實使用證據按設計跳過、0 失敗）；Python 教材／發布／完整卷／公開 Git 安全 370 項全部通過；真實 PostgreSQL 17 協定 23 項通過、1 項 legacy 情境按設計跳過；Supabase Edge 47/47 通過，Deno fmt／check 亦通過。
- 最終文件提交後仍須重跑 `npm test`、`npm run test:figures`、`npm run test:edge` 與 `python scripts/audit-blueprint-readiness.py --require-complete`；不得把上述施工 checkpoint 冒充不同 HEAD 的最終結果。
- GitHub 交付另由 `verify-github-delivery.py` 先掃描完整 tracked tree，拒絕私有題圖／答案／bundle、credential 檔與常見 secret 格式，再核對乾淨 `main == origin/main`、同一 HEAD 的 CI／Pages 成功，以及線上 `index.html`、`app.js`、`sw.js`、`textbook-catalog.js` 與本機逐 bytes 相同。
- 正式驗收證據與私有素材留在 repo 外；checkout 內被忽略的暫存檔也不得追蹤或提交。service-role key、使用者 token、私人教材、答案與部署記錄一律不得進公開 Git。

`matha-system-blueprint-readiness-v2` 將證據分成兩層。6 道工程關卡已全部有可驗證證據：完整卷接線、Starter 安全審核、D1→回滾→D2、Storage 全量回讀、登入使用者 App loader，以及公開 Git 安全／CI／Pages／逐 bytes 交付。稽核結果為 `complete:true`、`engineeringComplete:true`、`capabilityValidated:false`、6 pass／5 blocked／0 fail；5 個 blocked 全是交付後真實使用證據，不是未完工程。任何 repo 修改都會使舊 GitHub 證據失效，須由 verifier 對最終新 HEAD 重做。

仍不能由工程測試代替的只有：至少 6 回本人未看過的正式卷、最近 3 回不同來源且 freshness-confirmed 的 20 題／100 分鐘正式卷各 ≥72 分、Galaxy Tab S10 Ultra 真實 100 分鐘與翻頁 P95、7 題第一錯步 precision／coverage、30 題個人詳批 gold。它們只影響 `capabilityValidated`，不倒灌成施工前假證據。
