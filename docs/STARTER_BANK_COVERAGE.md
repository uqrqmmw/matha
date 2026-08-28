# 14 單元先遣題庫候選（2026-08-29）

## 結果

- 從 1,919 題有原書官方答案裁圖的候選中，以 `bookId + PDF 頁碼` 映射正式 14 單元；OCR 章名不作真值。
- 先遣候選共 140 題，每單元 10 題；其中 117 題含必要圖形。
- 角色組成：例題 54、章末簡單 33、中等 35、困難 18。角色只採印刷區段證據，不把 OCR 或題型代碼猜成難度。
- 切成 4 批，每批 35 題且都交錯涵蓋 14 單元；每批均已生成「原題／去筆跡／移除區」像素 QA 與「清理題面／官方答案」數學 QA 工作包。
- `matrix-equation-p102-ex19` 在實際 source-cleaned 對照中發現 `n=0` 附近像素漂移，已由版本化隔離清單排除；替補題 `matrix-equation-p206-q2` 的原題、清理題與官方答案已逐像素抽查通過。

這些只是 review-only 候選；所有 selection 與工作包維持 `releaseAuthority:false`、`studentReady:false`。未完成具名真人逐題 QA、雙審核交集與 exact-manifest 發布簽核前，不得進正式出題路徑。

## 權威產物

- 單元映射：`scripts/ingest/math-a-topic-map.json`
- 選題器：`scripts/ingest/build-cleaned-starter-queue.py`
- 可追溯隔離：`scripts/ingest/starter-review-exclusions.json`
- 私有候選與 coverage：`C:\Users\yenke\Desktop\數學檔案\matha-starter-queue-v2-20260829`
- 像素 QA：`C:\Users\yenke\Desktop\數學檔案\matha-starter-review-batch-01-pixel-v2-20260829` 至 `batch-04-pixel-v2-20260829`
- 答案／數學 QA：`C:\Users\yenke\Desktop\數學檔案\matha-starter-review-batch-01-answer-v2-20260829` 至 `batch-04-answer-v2-20260829`

舊的 `matha-starter-queue-v1-20260829` 與未帶 `v2` 的 Batch 01 工作包已被上列 v2 取代，只保留稽核，不得用於簽核或發布。

## 安全與驗證

選題器在輸出前重新驗證 candidate、原題、清理題、答案與 answer-packet question 的 SHA-256，並拒絕：

1. candidate／answer binding 的題號、書籍、頁碼或像素雜湊不一致；
2. 未綁官方答案、角色不在 starter scope、單元多義或只有 provisional 映射；
3. 明列於像素／內容隔離 manifest 的題；
4. 私有輸出寫入 Git repository；
5. 任一必要資產缺失或 hash drift。

自動測試新增 4 項，覆蓋 14 單元與區間驗證、平衡批次、身份錯綁 fail-closed、隔離後自動替補。工作包另以 localhost 實測 HTML、分頁、原題、清理題、紅色移除圖及官方答案皆回應 HTTP 200；沒有使用內建 browser，也沒有呼叫 OpenAI API 或重跑 YesScanner。

## 下一道關卡

先完成 Batch 01 的 35 題具名真人像素 QA 與答案／數學 QA。兩份 JSON 都完整通過後，用既有 `intersect-cleaned-human-reviews.py` 建立 fail-closed 交集；交集仍不可發布，還要再對 exact manifest hash 做具名發布簽核。Batch 01 安全上線後再依序處理 Batch 02–04，不必等 140 題全審完才取得第一批正式題。
