# 2026-08-26 OCR 與舊題庫撤換交接

## 已安全完成

- 數學來源共 25 份 PDF、6,720 頁，已全部用 `mistral-ocr-latest` 完成 OCR。
- OCR 工作目錄：`C:\Users\yenke\desktop\數學檔案\ocr-full-20260826`
- 完整輸出：25 份 raw JSON、6,720 份逐頁 JSON、6,720 份逐頁 Markdown，沒有漏頁或未完成文件。
- 預估 API 成本為 USD 26.88；本次請求均已成功完成。
- 嚴格 QA 已掃描 6,720 頁：6,439 頁通過、281 頁列入複核；其中 3 頁確認為來源空白／封面，11 頁確認為整頁 OCR 漏辨識並已建立可追溯修復。
- 修復分布為 Mistral 單頁重跑 10 頁、固定 `gpt-5.5` 結構化視覺重讀 1 頁；原始全書 OCR 不覆寫，修復只供索引。抽查仍發現三列方程組漏掉整列，以及 `-5≤x<1` 被辨識成 `-5≤x≤1`。後者在舊 RapidOCR 也同樣讀錯，證明兩引擎一致不等於數學正確。
- QA 檔案：
  - `C:\Users\yenke\desktop\數學檔案\ocr-full-20260826\qa\summary.json`
  - `C:\Users\yenke\desktop\數學檔案\ocr-full-20260826\qa\page-report.jsonl`

## 已確認的正式題庫來源

1. `bank.js`：少量內建基礎題。
2. `practice-bank.js`：程式生成的核心數字變式題；不是掃描 OCR 題。
3. Supabase 私有 bucket `matha-content`：舊 `manifest-0825e.json` 聲稱 4,138 題，但前端已拒收該舊世代並清除 curated 快取；保留遠端檔只供回溯，不再進練習。
4. 使用者自行匯入的 qpack／`content_packs`：與官方私有題庫不同，不能誤刪個人內容。

## 使用者最新決定

- 原 Git／Supabase 中由舊 OCR 產生的題庫要撤換，不得繼續混入練習。
- 舊資料先保留回溯備份，不直接銷毀。
- 新 OCR 不能因完成辨識就直接當成正確題庫；必須對照原卷、保留圖形、校驗答案後才可發布。

## 下一步（由此續接）

1. 舊 manifest 世代拒收、curated 快取清除、UI 說明與測試已在 `bf66752` 完成並推上 `main`；363 題非 OCR 核心題仍可離線使用。
2. 新版掃描題一律帶 `displayTruth: original-pdf-crop`／`needsStemAsset`，未附經驗證原卷裁圖時由建置器隔離。
3. `promote-reviewed-stems.py` 已建立最後發布閘門：重新渲染原 PDF 做像素比對、核對所有雜湊與題頁綁定、要求完整題幹／選項且無答案／詳解／筆跡／鄰題，以及不同複核者。
4. 已以 `line-inequality-p067-q3` 實跑完整 promotion：裁圖與原 PDF 重渲染像素完全一致，建置結果 1 題接受／0 題待圖，正式 validator 回報 `stemVerified=true`；此為管線 pilot，不是公開發版。下一階段擴到少量跨題型樣本並做 app 平板實測，確認裁圖尺寸、作答鈕、答案分離都正確後才逐本擴張。
5. Mistral OCR 僅作搜尋與候選切段；答案必須另外對照原書答案裁圖並做數學校驗後，才生成新版私有 manifest。
6. 21 本同格式章節書已重建版本 2 map 與原 PDF 300 dpi 裁圖：7,055 題幹、6,929 答案、3,157 圖形；21 本結構稽核全數通過。25 個答案歧義與 91 個找不到答案連結維持隔離，安全發布數仍是 0。

## 當前 Git 狀態

- 分支：`main`
- 開始本輪前工作樹乾淨並與 `origin/main` 同步。
- 已推提交：`bf66752 fix: retire unverified OCR question bank`
- 後續「原卷裁圖才是題面」修改尚待完整測試、提交與部署；不要在測試全綠前宣稱已有新版掃描題可用。
