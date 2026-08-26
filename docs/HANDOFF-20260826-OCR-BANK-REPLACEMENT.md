# 2026-08-26 OCR 與舊題庫撤換交接

## 已安全完成

- 數學來源共 25 份 PDF、6,720 頁，已全部用 `mistral-ocr-latest` 完成 OCR。
- OCR 工作目錄：`C:\Users\yenke\desktop\數學檔案\ocr-full-20260826`
- 完整輸出：25 份 raw JSON、6,720 份逐頁 JSON、6,720 份逐頁 Markdown，沒有漏頁或未完成文件。
- 預估 API 成本為 USD 26.88；本次請求均已成功完成。
- 自動 QA 已掃描 6,720 頁：6,492 頁初步通過、228 頁列入複核；警示為高召回清單，不能直接視為 228 個 OCR 錯誤。
- QA 檔案：
  - `C:\Users\yenke\desktop\數學檔案\ocr-full-20260826\qa\summary.json`
  - `C:\Users\yenke\desktop\數學檔案\ocr-full-20260826\qa\page-report.jsonl`

## 已確認的正式題庫來源

1. `bank.js`：少量內建基礎題。
2. `practice-bank.js`：程式生成的核心數字變式題；不是掃描 OCR 題。
3. Supabase 私有 bucket `matha-content`：目前前端讀取 `manifest-0825e.json`，聲稱載入 4,138 題；這批是使用者不再信任的舊辨識題庫。
4. 使用者自行匯入的 qpack／`content_packs`：與官方私有題庫不同，不能誤刪個人內容。

## 使用者最新決定

- 原 Git／Supabase 中由舊 OCR 產生的題庫要撤換，不得繼續混入練習。
- 舊資料先保留回溯備份，不直接銷毀。
- 新 OCR 不能因完成辨識就直接當成正確題庫；必須對照原卷、保留圖形、校驗答案後才可發布。

## 下一步（由此續接）

1. 在 manifest 加入不可偽造的 `corpusGeneration`／來源雜湊要求，前端拒收舊 `manifest-0825e.json` 世代。
2. 清除 IndexedDB 內已快取的舊 curated packs，確保停用後不殘留抽題。
3. 更新 UI／README，不再宣稱 4,138 題可信可用；顯示「舊掃描題庫已隔離，新題庫校驗中」。
4. 保留 `bank.js` 與 `practice-bank.js` 作為非 OCR 的離線基礎題，除非來源稽核發現其中也抄自舊 OCR。
5. 增加測試：舊 manifest 即使 SHA-256 正確也必須因世代／信任證據不符而拒收；個人 qpack 不受誤刪。
6. 改善 228 頁 QA 分類，將封面、目錄、答案頁與表格假警報排除；公式括號／LaTeX 損壞仍維持嚴格複核。
7. 以原 PDF 裁圖作顯示真相、Mistral OCR 作可搜尋文字；題幹、選項、答案與圖形逐題綁定後才生成新版私有 manifest。

## 當前 Git 狀態

- 分支：`main`
- 開始本輪前工作樹乾淨並與 `origin/main` 同步。
- 最近提交：`5d74bb2 fix: quarantine unverified textbook answers`
- 本交接檔是重開機前新增的安全進度點。
