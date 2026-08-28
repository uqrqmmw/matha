# YesScanner 去筆跡全量批次交接（2026-08-28）

## 已完成

- 來源選擇：1,272 頁疑似有手寫的教材頁。
- 整頁 YesScanner 去手寫：1,264 頁通過來源雜湊、成品雜湊與幾何驗證。
- 整頁幾何異常的 8 頁改用原始題面逐題救援：21 題成功，7 頁完整救回。
- 重裁後產生 1,952 個 review-only 題面候選：1,931 題來自整頁重裁，21 題來自逐題救援。
- 唯一未通過的題為 `trig-radian-p134-q9`，因供應商將 `(2079, 550)` 改成 `(3072, 784)`，長寬比漂移 `0.036605` 超過可接受門檻 `0.005`，已隔離，沒有混入候選。
- 完整批次保持單線、1 QPS，重開時從來源與四份產物雜湊綁定的已驗證快取續跑，沒有重複請求已成功頁。

## 驗證結果

- Python 圖片／匯入／去筆跡測試：179/179 通過。
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
- 逐題人工像素 QA 工作包：`C:\Users\yenke\Desktop\數學檔案\yescanner-handwriting-human-review-v5-20260828`（在資料夾執行 `python serve-review.py`，再開啟 `http://127.0.0.1:8765/review.html`）
