# 掃描教材匯入管線（review-only）

`textbook-catalog.js` 裡 14 本 `ingestion:'pending-qa'` 的教材是**每頁單張約 300 dpi 掃描、沒有文字層**，共 3,786 頁。這個目錄的五支程式把一本書變成可人工複核的 section map、題目候選、圖形候選與裁切，並在人工複核後轉成正式題包格式。

## 硬規則

- **OCR 只作索引。** 題目顯示真值一律是原 PDF 的裁切像素；OCR 文字只用來切段、配對與搜尋，記錄裡的欄位名稱就叫 `ocrIndex`。
- **產物不得進 Git。** 所有程式都會拒絕寫入 repo 內任何路徑（`ensure_outside_repo`）。掃描圖、裁切圖、頁面 JSON 全部留在 repo 外的工作目錄。
- **一律 `pending-review`。** 沒有任何一條路徑會產生 `verified: true` 或 `studentUsable: true`。晉級要走既有的 `prepare-figure-review.js` → 人工 → `promote-reviewed-figures.js`。
- **沒有印刷證據就是 null。** `sourceDifficulty` 只在書上印了難度橫幅時才填，並附上 `sourceDifficultyEvidence` 原字串。猜一個「中等」之後就再也分不出哪個是證據。
- **有圖的題不准丟。** 圖形超出答案邊界時**裁到邊界**而不是丟棄；題幹提到「如圖」卻真的沒有圖形候選才帶 `figure-referenced-but-missing` 進 `needs-repair`。「圖示…的解」「作出…的圖形」這類**圖就是答案**的題另標 `answer-is-a-drawing`，不算缺陷。
- **前手寫筆跡只標記、不擦除。** 這批掃描裡有前一手的鉛筆演算，就寫在題目與 `解答` 之間（題幹範圍內），而且常常包含最終答案。判準是**實心墨佔比**：印刷會壓出實心墨、鉛筆不會（印刷圖 0.45–1.2 倍於同頁內文，鉛筆 0–0.21 倍）。命中的區域不當圖形候選，題目標 `annotation-suspected-in-question` 並降到 `needs-repair`；裁切照樣產生，因為「前一手寫了什麼」是人要判的。
- **一次一本、循序執行。** 這台機器在大量並行處理下當過機，所有程式都沒有多工。

## 五個階段

環境（一次性，建在 repo 外）：

```bash
py -3 -m venv "<work>/.venv" && "<work>/.venv/Scripts/python.exe" -m pip install -r requirements-figure-tools.txt rapidocr-onnxruntime
```

### 1. `index-pages.py` — 逐頁索引

渲染 150 dpi 複核圖、跑 OCR、掃描版面尺規，一頁一個 JSON。可續跑：頁面圖 SHA-256 沒變且 schema 相同就整頁跳過；schema 變了但圖與 OCR 引擎相同時，只重算版面與背景亮度，不重跑 OCR。約 2.3 秒／頁（重用 OCR 時約 0.5 秒）。

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

### 4. `ingest-status.py` — 跨書狀態彙總

```bash
python scripts/ingest/ingest-status.py --work "<work>"
```

輸出 `<work>/INGEST_STATUS.md`：各書頁數／候選題／含圖題／難度階梯／QA 旗標，以及「非 `pending-review` 的記錄必須為 0」這條不變條件。只有統計，沒有題目內容。

### 5. `apply-review.py` — 複核結果轉正式題包

```bash
python scripts/ingest/apply-review.py --work "<work>" --book <bookId> --template
python scripts/ingest/apply-review.py --work "<work>" --book <bookId>     --decisions "<work>/<bookId>/review-decisions.json" --out "<repo 外>/qpack.json"
```

這是離開 review-only 的**唯一出口**，刻意窄：

- 只有明確 `"decision": "approve"` 才會輸出，沒填或填錯一律拒絕。
- **題幹文字必須由複核者自己填**；貼上 `ocrIndex` 會被擋下。OCR 在這份掃描裡會把「選擇」讀成「遥挥」、把式子的正負號吃掉，抄進 `q` 就是出一題看起來很合理但數學是錯的題。
- 還帶著 QA 旗標的題，必須把那些旗標逐一列進 `acceptedFlags` 才放行。
- 難度優先採印刷分層；書上沒印就必須同時提供 `diff` 與 `diffEvidence`。
- 有圖的題一律帶 `needsFigure: true` 且**不產生** `figureAsset`。前端會把這種題隔離，直到裁圖走完既有的獨立複核與晉級流程——這就是「有圖題不會缺圖上線」的保證。

輸出的記錄已用 `build-private-bank.js` 的 `validateQuestion` 實跑驗證通過，`tests/private-bank.test.js` 有一條測試釘住這個契約。本程式**不碰**正式題庫 manifest。

## 這套書實際印了什麼

以《直線與二元一次不等式》逐頁核對後確認（其餘同版教材預期相同，但**每本仍須由 `qa-report.md` 重新確認**）：

| 版面元素 | 用途 | 偵測方式 |
|---|---|---|
| `- 58 -` 頁底置中 | 印刷頁碼 | OCR；全書取眾數 offset，不符者標 `printed-page-inferred-after-conflict` |
| `Ex75.` + 外框 | 例題 | OCR 標記 + 尺規外框 |
| `解答` / `解析` 左側小框 | 該題答案起點 | OCR 標籤字**或**四邊閉合的尺規小框，取較早者；小框用專屬形態學核（用外框的核會把 30px 高的標籤邊抹掉） |
| `基礎實力養成` / `進階試題演練` / `解題思維挑戰` 灰底橫幅 | 章末難度層 → `easy` / `medium` / `hard` | 頂端色帶一律加強對比重讀，並記錄每行的**背景亮度**（灰底 219–230、白紙 255）；「左上角的灰底文字」＝橫幅 |
| `一、單一選擇題` … `五、題組` | 題型 | 左側 `[一二三四五六]、` + 關鍵字模糊比對，跨頁沿用到區塊結束 |
| `1.答案：（D）` | 章末答案 | 依**區塊序號**與難度層配回題目，不用會亂碼的章名比對 |

難度比對只認**這份掃描裡真的活下來的字**：`演` → medium、`挑`／`戰` → hard、`基`＋`成` → easy。書二的 `進階試題演練` OCR 成 `試题演`（`進` 掉了），早期版本要求 `進` 而比對失敗，難度就默默沿用上一個區塊——這是本管線最該防的錯。現在**有橫幅就一定開新區塊**，讀不出來就 `sourceDifficulty: null` ＋ `tier-banner-unreadable`，不繼承。

## 全部十四本的實跑結果

十一本章節教材(2,820 頁)全數完成 map 與裁切:**3,391 題候選、含圖題 1,102、章末題 94.8% 配到印刷答案、0 裁切越界**。逐本數字見各書 `qa-report.md`,跨書彙總見工作目錄 `INGEST_STATUS.md`。

例題沒印詳解的只有 5 題,標 `no-printed-solution-teacher-covered` 資訊性標記——飼主確認這是設計:例題由老師上課講。章末題(書上有印答案)缺配仍是待修項。

另外三本結構不同:

- **滿級分寶典(上)(下)**(806 頁):前 ~290 頁是「課程重點回顧」(編號項目是定義與定理,不是題目),p293 起是「精選模考試題」(題目區/詳解區分開)。這是另一個版面家族;**逐頁索引已完成並快取**(未來加模考版面支援時零 OCR 成本),題目抽取尚未進行,現有輸出裡的 0 題是誠實結果不是失敗。
- **數B滿分讀寫**(160 頁,supplement):用章節書偵測器跑出 154 題候選留待審,優先度低。

三本雜湊已記入 `textbook-catalog.js`,ingestion 維持 `pending-qa`。

無法自動處理而**明列給人工**的清單(所有書合計):漏題缺號 65 題(各書 qa-report 有區塊/題型/頁碼)、頁頂無主內容 21 處、前手鉛筆 481 題、章末缺配 110 題。三次自動掛接嘗試與一次全頁回收嘗試都因目視驗證失敗而撤除——**回收與掛接只在印刷證據自己能證明的地方發生**。

## 已驗證與尚未驗證

已用實跑驗證：十四本 3,786 頁全數索引；section map 的分章與 easy／medium／hard 分層逐段對照實體書無誤；題幹與圖形裁切目視抽查（題幹不含答案、座標軸與刻度完整、選項不進圖、單位圓標點齊全）；《數列遞迴與級數求和》是第一本完全沒有為它調參就跑出正確分章分層的書；鉛筆判準在乾淨的《直線與二元一次不等式》上數字完全不變（237 題／69 含圖），在有筆跡的頁上保留印刷圖、只標記鉛筆。`tests/test_ingest.py` 84 項與既有 `npm test` 215 項全數通過。

**尚未驗證**：`needs-repair` 佇列裡的每一題仍待人工判讀；`handwritingSafety` 一律 `unknown`（沒有可信的手寫偵測，掃描本身也可能有筆跡）；本管線沒有產生任何可直接匯入正式題庫的 qpack，`build-private-bank.js` 的輸入仍需人工複核後再另行產生。
