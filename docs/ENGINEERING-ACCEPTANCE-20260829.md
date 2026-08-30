# 數A特訓工程驗收摘要（2026-08-29；2026-08-30 收尾更新）

本檔只記錄可由程式與雜湊驗證的工程證據，不把尚未發生的本人作答、Galaxy Tab 真機長考或個人詳批 gold 冒充完成。

## 私有教材先遣庫

- 已直接檢視 Batch 01–06、10，共 245 題的原題、去筆跡題面、移除像素與官方答案。
- 217 題通過，28 題因必要圖線／灰階受損、殘留筆跡、混題裁切或官方答案無法明確綁定而隔離。
- 14 單元各 13–18 題；例題 114、章末簡單 56、中等 34、困難 13。
- 平衡版 release ID：`starter-ae19e7c7061200e7`。
- 簽核題源 SHA-256：`6e014d34223e865c10eb783058282eec362595b8d4966dccf340dc2be53f8b45`。
- 此版採擁有者明確委託的代理直接像素／答案審核；授權、執行者、完整批次與每份審核雜湊都寫入簽核鏈，並明列 `humanPixelReviewClaimed:false`。這是被允許的透明 owner-delegated 流程，不要求把代理冒充具名真人。
- manifest、內容包與 217 張題圖皆使用版本化路徑；固定 alias 只允許在全部上傳並回讀雜湊後最後切換。
- 部署器會在固定 alias 切換前，先以原子寫檔保存上一版 alias bytes、新舊雜湊與完整上傳清冊；即使網路回應遺失或程序在切換途中終止，prepared record 仍可直接驅動安全回滾。
- 工程發布順序固定為第一次部署 D1 → 綁定 D1 的回滾 → 時間較晚且記錄不同的最終部署 D2；三者須綁同一 upload plan 與 alias 雜湊。
- D2 後先由 Storage verifier 全量回讀固定 alias 與 410 個版本化物件，核對 217 題、191 題包、14 單元、角色分布、全部題圖引用及簽核題源；再由啟用中的真實登入使用者以 JWT／RLS 讀回 191 題包與 217/217 題圖，signed URL 另做跨 14 單元／4 角色抽查。兩份證據都須綁 D2、`APP_VER` 與 `app.js` SHA，不能互相替代。
- 目前 Supabase 管理面雖顯示 `ACTIVE_HEALTHY`，Storage alias 直讀與 DB login role 仍皆回 `DatabaseTimeout (544)`。固定 alias 沒有切換；最後一次成功驗證的內容是 153 題，但目前可用性未知，不能宣稱 153 題仍在線。217 題 release 只存在 repo 外本地 bundle，尚未部署。

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
- 首輪只顯示對錯、配分與正解；隔日留下重想後才解鎖官方詳解與 GPT-5.5 詳批。
- 詳批 schema 保存做對部分、第一錯步、流程斷點、證據與信心；沒有可核對證據時必須 abstain。
- 複選逐項標示漏選／錯選，紅筆吸附學生作答區，不覆蓋印刷題面。
- 弱點至少需兩道不同題的證據；推薦限制同來源與同模板重複，單次錯誤不宣告穩定弱項。

## 自動測試

- 2026-08-30 本地收尾版：Web／PWA 270 項（268 通過、2 項私人 gold 因尚無真實證據按設計跳過、0 失敗）；Python 教材／發布／完整卷／公開 Git 安全 291 項全部通過；Supabase Edge／GPT-5.5 閘門 14 項全部通過。
- 最終提交若再修改程式，仍須重跑 `npm test`、`npm run test:figures`、`npm run test:edge` 與 `python scripts/audit-blueprint-readiness.py`；不得把上述施工 checkpoint 冒充不同 HEAD 的最終結果。
- GitHub 交付另由 `verify-github-delivery.py` 先掃描完整 tracked tree，拒絕私有題圖／答案／bundle、credential 檔與常見 secret 格式，再核對乾淨 `main == origin/main`、同一 HEAD 的 CI／Pages 成功，以及線上 `index.html`、`app.js`、`sw.js`、`textbook-catalog.js` 與本機逐 bytes 相同。
- 所有證據留在 repo 外；不得把 service-role key、使用者 token、私人教材、答案或部署記錄提交到公開 Git。

`matha-system-blueprint-readiness-v2` 將證據分成兩層。6 道工程關卡中，完整卷接線與 Starter 安全審核已有可驗證證據；D1→回滾→D2、Storage 全量回讀、登入使用者 App loader、乾淨 HEAD 的 CI＋Pages 尚未完成。GitHub 關卡也會重新比對公開 tracked tree 安全稽核。5 道交付後能力關卡目前均待真實使用，不會被工程測試代替。

仍不能由工程測試代替的只有：至少 6 回本人未看過的正式卷、最近 3 回不同來源且 freshness-confirmed 的 20 題／100 分鐘正式卷各 ≥72 分、Galaxy Tab S10 Ultra 真實 100 分鐘與翻頁 P95、7 題第一錯步 precision／coverage、30 題個人詳批 gold。它們只影響 `capabilityValidated`，不倒灌成施工前假證據。
