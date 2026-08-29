# 14 單元先遣題庫候選（2026-08-29）

## 結果

- 從 1,919 題有原書官方答案裁圖的候選中，以 `bookId + PDF 頁碼` 映射正式 14 單元；OCR 章名不作真值。
- starter 候選共 364 題，每單元 26 題；其中 308 題含必要圖形。
- 角色組成：例題 169、章末簡單 58、中等 109、困難 28。目標比例為 30%／20%／35%／15%；素材缺少某角色時明列 shortfall，不把例題冒充章末難題。
- 切成 11 批：前 10 批各 35 題，最後 1 批 14 題；每批都交錯涵蓋 14 單元，並已生成「原題／去筆跡／移除區」像素 QA 與「清理題面／官方答案」數學 QA 工作包。
- 已回看原始 PDF 的印刷章節頁，將「平面線性變換與空間概念」及「克拉瑪公式與圓線幾何」五個跨主題區段由 provisional 升為高信心映射；OCR 仍不作真值。
- `matrix-equation-p102-ex19` 在實際 source-cleaned 對照中發現 `n=0` 附近像素漂移，已由版本化隔離清單排除；替補題 `matrix-equation-p206-q2` 的原題、清理題與官方答案已逐像素抽查通過。

這些只是 review-only 候選；所有 selection 與工作包維持 `releaseAuthority:false`、`studentReady:false`。未完成具名真人逐題 QA、雙審核交集與 exact-manifest 發布簽核前，不得進正式出題路徑。

## 權威產物

- 單元映射：`scripts/ingest/math-a-topic-map.json`
- 選題器：`scripts/ingest/build-cleaned-starter-queue.py`
- 可追溯隔離：`scripts/ingest/starter-review-exclusions.json`
- 私有候選與 coverage：`C:\Users\yenke\Desktop\數學檔案\matha-starter-queue-v4-20260829`
- 像素 QA：`C:\Users\yenke\Desktop\數學檔案\matha-starter-v4-batch-01-pixel-20260829` 至 `batch-11-pixel-20260829`
- 答案／數學 QA：`C:\Users\yenke\Desktop\數學檔案\matha-starter-v4-batch-01-answer-20260829` 至 `batch-11-answer-20260829`
- 單題整合複核台 V2（hash-bound、可備份恢復）：`C:\Users\yenke\Desktop\數學檔案\matha-starter-v4-batch-01-combined-v2-resumable-hashbound-20260829` 至 `batch-11-combined-v2-resumable-hashbound-20260829`
- 工作包全量驗證器：`scripts/ingest/validate-starter-review-packets.py`
- 發布準備與固定十題抽查：`scripts/ingest/prepare-starter-private-release.py`
- 版本化 bundle、原子 alias 切換與回滾：`scripts/ingest/assemble-private-release.py`、`scripts/ingest/deploy-private-release.py`

舊的 v1–v3 queue 與 v2 的 140 題工作包已被上列 v4 取代，只保留稽核，不得用於新的簽核或發布。舊 `combined-20260829` V1、`combined-v2-20260829` 與沒有檔案式進度備份的 `combined-v2-hashbound-20260829` 都已作廢；只能使用上列 `combined-v2-resumable-hashbound-20260829`。

## 安全與驗證

選題器在輸出前重新驗證 candidate、原題、清理題、答案與 answer-packet question 的 SHA-256，並拒絕：

1. candidate／answer binding 的題號、書籍、頁碼或像素雜湊不一致；
2. 未綁官方答案、角色不在 starter scope、單元多義或只有 provisional 映射；
3. 明列於像素／內容隔離 manifest 的題；
4. 私有輸出寫入 Git repository；
5. 任一必要資產缺失或 hash drift。

選題測試覆蓋 14 單元與精確區間、按比例角色目標、可行時的 50% 單書上限、身份錯綁 fail-closed、隔離後自動替補。全量驗證器另逐一重算 364 題的 batch manifest、原題、清理題、紅色移除圖、官方答案與兩份人工審核 template 雜湊；11 批全部一致，且都維持 `releaseAuthority:false`。沒有使用內建 browser、OpenAI API，也沒有重跑 YesScanner。

11 批均另有單題整合複核台 V2；它先呼叫同一個全量驗證器，再把兩道關卡放在同一題畫面，仍各自輸出相容格式。答案關卡現在強制真人從官方答案像素輸入 App 可判分的結構；不再留下「像素已核對但正式題庫沒有可信正解」的斷點。V2 schema、結構化答案要求與兩份來源 template hash 都納入 packet SHA-256 與 localStorage 身分；另可隨時下載並恢復完整 checkpoint，匯入時 fail closed 核對 packet hash、完整題號集合並清洗狀態欄位。2026-08-29 已驗證 11 包、題數為 35×10＋14＝364；Batch 01 的 review HTML、原題、清理題、移除區與官方答案皆經 localhost 實測 HTTP 200，checkpoint 的錯 hash 拒絕與合法恢復也已由無瀏覽器 Node 測試實際執行。畫面一次只掛載一題，避免大量高解析圖片同時佔用記憶體。所有舊 combined 包都不能用於新簽核。

題材庫本身無法滿足所有理想比例：10 個單元缺少部分章末角色，12 個單元不足 3 個高信心來源區段。這些限制已逐單元寫入 `starter-review-selection.json`；選題器只在實際有第二來源時強制單一書籍不超過 50%，不會為滿足表格而虛構來源或難度。

## 下一道關卡

先完成 v4 Batch 01 V2 的 35 題具名真人像素 QA、答案／數學 QA 與最小可判分答案輸入。兩份 JSON 都完整通過後，用 `intersect-cleaned-human-reviews.py` 建立 fail-closed 交集；再由 `prepare-starter-private-release.py` 重驗原 PDF、產生固定 10 題視覺抽查與 exact-hash 簽核。簽核後才建立版本化私有 bundle；部署器逐檔回讀驗雜湊，最後原子切換 alias，並保留可驗證回滾記錄。Batch 01 安全上線後再依序處理 Batch 02–11，不必等 364 題全審完才取得第一批正式題。目前仍未有人類完成 Batch 01，正式發布數維持 0。

`advance-starter-release.py` 已把「找出正確下載檔 → 雙審核交集 → 十題簽核包 → 驗簽 → bundle」串成可續作狀態機；每階段採 partial 後原子換名，拒絕錯批、歧義檔與既有雜湊漂移。狀態機刻意停在部署前，不會因檔案剛下載就自動改正式 Supabase alias。
