# YesScanner 去筆跡全量批次交接（2026-08-28）

## 已完成

- 來源選擇：1,272 頁疑似有手寫的教材頁。
- 整頁 YesScanner 去手寫：1,264 頁通過來源雜湊、成品雜湊與幾何驗證。
- 整頁幾何異常的 8 頁改用原始題面逐題救援：21 題成功，7 頁完整救回。
- 重裁後產生 1,952 個 review-only 題面候選：1,931 題來自整頁重裁，21 題來自逐題救援。
- 唯一未通過的題為 `trig-radian-p134-q9`，因供應商將 `(2079, 550)` 改成 `(3072, 784)`，長寬比漂移 `0.036605` 超過可接受門檻 `0.005`，已隔離，沒有混入候選。
- 完整批次保持單線、1 QPS，重開時從來源與四份產物雜湊綁定的已驗證快取續跑，沒有重複請求已成功頁。

## 驗證結果

- Python 圖片／匯入／去筆跡測試：190/190 通過。
- Web 全套測試：226/226 通過。
- 人工抽查候選類型包含：中文密集題幹、根號與指數公式、矩陣、座標圖、函數曲線、灰階圖表、印刷圖形，以及逐題 fallback。抽查中印刷內容與圖線保留，舊筆跡被移除。

## 安全關卡

這 1,952 題目前是可供人工像素複核的候選，**不是已發布題庫**。Manifest 固定為 `releaseAuthority:false` 與 `humanPixelReviewRequired:true`。在人工逐頁確認下列項目前，不得接入學生作答流程：

1. 印刷文字、數學符號、公式與圖線沒有被刪除或變形。
2. 手寫、圈選、已填答案與計算痕跡已完整清除。
3. 題幹、選項與題目必要圖形完整，沒有夾帶詳解或官方答案。
4. 題號、來源書籍、PDF 頁碼與官方答案已獨立校對。

## 稽核產物

- 整頁原圖／清理圖／移除區紅圖：`C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-cleaned-pages-v2-20260828\review.html`
- 逐題 fallback 複核：`C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-fallback-questions-v2-20260828\cleaned\review.html`
- 重裁題面 manifest：`C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-cleaned-question-candidates-v2-20260828\cleaned-question-candidates.json`
- 逐題人工像素 QA 工作包：`C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-human-review-v6-20260828`（在資料夾執行 `python serve-review.py`，再開啟 `http://127.0.0.1:8765/review.html`）。原題、清理題與紅色移除區皆以 repo 外的雜湊綁定資產在 localhost 同源提供，已實測 HTML 與三種 PNG 均回應 HTTP 200，不依賴會被瀏覽器擋下的 `file://` 跨源圖片。
- 答案與數學 QA 工作包：`C:\Users\yenke\Desktop\數學檔案\yescanner-answer-binding-review-v2-20260828`（執行 `python serve-review.py`，再開啟 `http://127.0.0.1:8767/review.html`）。1,952 題的題號／書籍／PDF 頁碼／原題 crop 全數重新綁定；1,919 題的原書答案 crop 與 catalog PDF 像素完整一致，33 題因原資料沒有官方答案 crop 隔離。組成為 answer-key 825 題、題後 inline 672 題、續頁詳解 422 題；不採信 OCR 題文或 OCR 答案。

## 雙審核交集與發布狀態

已新增 `scripts/ingest/intersect-cleaned-human-reviews.py` 作為 fail-closed 晉級驗證器。它會重新驗證兩份審核 JSON 的完整覆蓋、具名真人身分、帶時區的審核時間、所有安全勾選、candidate／題面／答案／紅圖與來源 PDF 雜湊，以及 33 題答案隔離清單。只有像素 QA 和答案數學 QA 都通過的題會進入交集；任何缺審、AI/bot 審核者、hash drift、缺圖、答案錯綁或隔離項都會整批拒絕或留在 quarantine。

驗證器已對實際工作包做唯讀資產稽核：1,952 份來源題面與清理題、1,952 組 localhost 原題／清理題／紅圖（共 5,856 個檔案），以及 1,919 組題面／答案與其宣告圖形雜湊均通過。這只證明檔案未漂移，不冒充真人對題意與數學正確性的逐題判讀。

目前兩份真人審核尚未完成，因此**尚未產生正式交集，也沒有題目接入學生題庫**。待真人在上面兩個 localhost 工作包逐題完成後，執行：

```powershell
python scripts/ingest/intersect-cleaned-human-reviews.py `
  --candidate-manifest "C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-cleaned-question-candidates-v2-20260828\cleaned-question-candidates.json" `
  --pixel-template "C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-human-review-v6-20260828\cleaned-handwriting-human-review.template.json" `
  --pixel-review "<真人下載的 cleaned-handwriting-human-review.json>" `
  --answer-binding "C:\Users\yenke\Desktop\數學檔案\yescanner-answer-binding-review-v2-20260828\answer-binding-candidates.json" `
  --answer-review "<真人下載的 cleaned-answer-human-review.json>" `
  --out "C:\Users\yenke\Desktop\數學檔案\yescanner-cleaned-dual-review-candidates-20260828.json"
```

即使交集成功，輸出仍固定為 `releaseAuthority:false`、`uploadPerformed:false`，並明示 `humanReleaseSignoffStillRequired:true` 與 `privateAssetDeploymentStillRequired:true`。下一道關卡是對交集 manifest 的精確雜湊做另一份具名真人最終發布簽核，再由私有素材部署流程上傳；不能把未簽核教材放入 GitHub Pages 或公開 repo。
