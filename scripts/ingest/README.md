# 掃描教材匯入管線（review-only）

`textbook-catalog.js` 裡 14 本 `ingestion:'pending-qa'` 的教材是**每頁單張約 300 dpi 掃描、沒有文字層**，共 3,786 頁。這個目錄的三支程式把一本書變成可人工複核的 section map、題目候選與圖形候選。

## 硬規則

- **OCR 只作索引。** 題目顯示真值一律是原 PDF 的裁切像素；OCR 文字只用來切段、配對與搜尋，記錄裡的欄位名稱就叫 `ocrIndex`。
- **產物不得進 Git。** 三支程式都會拒絕寫入 repo 內任何路徑（`ensure_outside_repo`）。掃描圖、裁切圖、頁面 JSON 全部留在 repo 外的工作目錄。
- **一律 `pending-review`。** 沒有任何一條路徑會產生 `verified: true` 或 `studentUsable: true`。晉級要走既有的 `prepare-figure-review.js` → 人工 → `promote-reviewed-figures.js`。
- **沒有印刷證據就是 null。** `sourceDifficulty` 只在書上印了難度橫幅時才填，並附上 `sourceDifficultyEvidence` 原字串。猜一個「中等」之後就再也分不出哪個是證據。
- **有圖的題不准丟。** 題幹提到「如圖」卻沒抓到圖形候選時，記錄會帶 `figure-referenced-but-missing` 旗標進 `needs-repair`，不會被省略。
- **一次一本、循序執行。** 這台機器在大量並行處理下當過機，三支程式都沒有多工。

## 三個階段

環境（一次性，建在 repo 外）：

```bash
py -3 -m venv "<work>/.venv" && "<work>/.venv/Scripts/python.exe" -m pip install -r requirements-figure-tools.txt rapidocr-onnxruntime
```

### 1. `index-pages.py` — 逐頁索引

渲染 150 dpi 複核圖、跑 OCR、掃描版面尺規，一頁一個 JSON。可續跑：頁面圖 SHA-256 沒變且 schema 相同就跳過。約 2.3 秒／頁。

```bash
python scripts/ingest/index-pages.py --pdf "<scan>.pdf" --book <bookId> --work "<work>"
```

輸出 `<work>/<bookId>/pages/pNNNN.json`：`ocr[]`（bbox + 文字 + 信心）、`bannerOcr[]`（灰底橫幅加強對比後重讀）、`layout.frameBoxes` / `labelBoxes` / `nonTextRegions` / `inkRows`。

### 2. `build-book-map.py` — section map 與題目候選

```bash
python scripts/ingest/build-book-map.py --work "<work>" --book <bookId>
```

輸出 `section-map.json`、`questions.pending-review.json`、`figure-candidates.json`、`qa-report.md`。

### 3. `render-review-crops.py` — 裁切與複核頁

```bash
python scripts/ingest/render-review-crops.py --work "<work>" --book <bookId> --pdf "<scan>.pdf"
```

從**原 PDF** 以 300 dpi 裁出 `crops/<questionId>/stem.png`、`figure-N.png`、`answer.png`，並產生 `review.html`（`needs-repair` 排在前面，答案區預設收合）。任何會越過答案邊界的裁切會被**拒絕**並標成 `crop-refused-crosses-answer-boundary`，不是硬切。

## 這套書實際印了什麼

以《直線與二元一次不等式》逐頁核對後確認（其餘同版教材預期相同，但**每本仍須由 `qa-report.md` 重新確認**）：

| 版面元素 | 用途 | 偵測方式 |
|---|---|---|
| `- 58 -` 頁底置中 | 印刷頁碼 | OCR；全書取眾數 offset，不符者標 `printed-page-inferred-after-conflict` |
| `Ex75.` + 外框 | 例題 | OCR 標記 + 尺規外框 |
| `解答` / `解析` 左側小框 | 該題答案起點 | OCR 標籤字**或**四邊閉合的尺規小框，取較早者 |
| `基礎實力養成` / `進階試題演練` / `解題思維挑戰` 灰底橫幅 | 章末難度層 → `easy` / `medium` / `hard` | 頂端色帶加強對比重讀（灰底會讓一般 OCR 漏掉約一半） |
| `一、單一選擇題` … `五、題組` | 題型 | 左側 `[一二三四五六]、` + 關鍵字模糊比對，跨頁沿用到區塊結束 |
| `1.答案：（D）` | 章末答案 | 依**區塊序號**與難度層配回題目，不用會亂碼的章名比對 |

## 已驗證與尚未驗證

已用實跑驗證：206/206 頁索引完成、section map 與實體書分章分層一致、題幹裁切逐張目視核對過樣本、`tests/test_ingest.py` 35 項通過。

**尚未驗證**：`needs-repair` 佇列裡的每一題仍待人工判讀；`handwritingSafety` 一律 `unknown`（沒有可信的手寫偵測，掃描本身也可能有筆跡）；本管線沒有產生任何可直接匯入正式題庫的 qpack，`build-private-bank.js` 的輸入仍需人工複核後再另行產生。
