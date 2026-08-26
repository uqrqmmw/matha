# 掃描教材匯入管線（review-only）

來源資料夾目前確認有 **25 份數學 PDF、6,720 頁**：24 本主教材共 6,210 頁，另含 510 頁《週攻略數學 A》。`textbook-catalog.js` 已逐份固定檔名、頁數與 PDF SHA-256；舊的 14 本／3,786 頁本機索引只是早期製作基線，不是完整藏書數。這個目錄的工具把一本書變成可人工複核的 section map、題目候選、圖形候選與原卷裁切，並在人工複核後轉成正式題包格式。

## 硬規則

- **OCR 只作索引。** 題目顯示真值一律是原 PDF 的裁切像素；OCR 文字只用來切段、配對與搜尋，記錄裡的欄位名稱就叫 `ocrIndex`。
- **成熟 OCR 也不能自證正確。** Google Enterprise Document OCR＋Math OCR 是第二套獨立索引；它與 RapidOCR 一致只能提高信心，不等於題目或答案獲准。兩者不一致、或只有一方找到的題，一律進 `needs-repair`。
- **產物不得進 Git。** 所有程式都會拒絕寫入 repo 內任何路徑（`ensure_outside_repo`）。掃描圖、裁切圖、頁面 JSON 全部留在 repo 外的工作目錄。
- **一律 `pending-review`。** `apply-review.py` 只校驗題目 metadata 與正解，產物仍帶 `needsStemAsset`；必須再走 `promote-reviewed-stems.py` 的原 PDF 像素比對與獨立視覺複核才可能上線。OCR 完成、兩套 OCR 一致、或只有 `figureAsset` 都不能解除這道閘門。
- **沒有印刷證據就是 null。** `sourceDifficulty` 只在書上印了難度橫幅時才填，並附上 `sourceDifficultyEvidence` 原字串。猜一個「中等」之後就再也分不出哪個是證據。
- **有圖的題不准丟。** 圖形超出答案邊界時**裁到邊界**而不是丟棄；題幹提到「如圖」卻真的沒有圖形候選才帶 `figure-referenced-but-missing` 進 `needs-repair`。「圖示…的解」「作出…的圖形」這類**圖就是答案**的題另標 `answer-is-a-drawing`，不算缺陷。
- **前手寫筆跡只標記、不擦除。** 這批掃描裡有前一手的鉛筆演算，就寫在題目與 `解答` 之間（題幹範圍內），而且常常包含最終答案。判準是**實心墨佔比**：印刷會壓出實心墨、鉛筆不會（印刷圖 0.45–1.2 倍於同頁內文，鉛筆 0–0.21 倍）。命中的區域不當圖形候選，題目標 `annotation-suspected-in-question` 並降到 `needs-repair`；裁切照樣產生，因為「前一手寫了什麼」是人要判的。
- **一次一本、循序執行。** 這台機器在大量並行處理下當過機，所有程式都沒有多工。

## 主要階段

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

### 1b. 成熟 OCR 服務 — 只建立索引

25 份來源已於 2026-08-26 用 `mistral-ocr-latest` 完成 6,720／6,720 頁索引。完整輸出留在 repo 外的 `ocr-full-20260826`，費用估計 USD 26.88。Mistral 的角色與下述 Google 第二讀相同：協助搜尋、切段和找候選，不是學生題面。

Google Enterprise Document OCR 的 Math OCR 曾作為獨立第二讀；若要針對局部頁重跑，流程如下：

目前採用 Google Enterprise Document OCR 的 Math OCR，不再要求本機 OCR 獨力扛數學式與繁體中文。先在 Google Cloud 建立 Enterprise Document OCR processor，再對 `pages/*.png` 執行：

```bash
node scripts/run-google-math-ocr.mjs \
  --input-dir "<work>/<bookId>/pages" \
  --output "<work>/<bookId>/google-document-ai" \
  --processor "projects/<number>/locations/us/processors/<id>" \
  --concurrency 8

python scripts/ingest/attach-google-document-ai.py \
  --book-dir "<work>/<bookId>" \
  --google-dir "<work>/<bookId>/google-document-ai"
```

每個回應都記錄輸入頁圖 SHA-256；掛接前再核對原索引的頁圖 SHA 與尺寸，不相符就拒絕。長批次會自動更新 gcloud access token，重跑只重用 SHA 完全相同的結果。服務能力與費率以官方文件為準：[Enterprise Document OCR](https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr)、[Document AI pricing](https://cloud.google.com/products/document-ai/pricing)。

### 2. `build-book-map.py` — section map 與題目候選

```bash
python scripts/ingest/build-book-map.py --work "<work>" --book <bookId>
python scripts/ingest/build-book-map.py --work "<work>" --book <bookId> \
  --ocr-provider google --output-variant google
```

輸出 `section-map.json`、`questions.pending-review.json`、`figure-candidates.json`、`qa-report.md`。

接著取兩套候選的**聯集**，不因任何一方漏讀就刪掉圖題：

```bash
python scripts/ingest/merge-ocr-candidates.py \
  --local "<work>/<bookId>/questions.pending-review.json" \
  --google "<work>/<bookId>/questions.pending-review.google.json" \
  --out "<work>/<bookId>/questions.pending-review.hybrid.json" \
  --report "<work>/<bookId>/ocr-merge-report.json"
```

### 3. `render-review-crops.py` — 裁切與複核頁

```bash
python scripts/ingest/render-review-crops.py --work "<work>" --book <bookId> --pdf "<scan>.pdf"
python scripts/ingest/render-review-crops.py --work "<work>" --book <bookId> --pdf "<scan>.pdf" --variant hybrid
```

從**原 PDF** 以 300 dpi 裁出 `crops/<questionId>/stem.png`、`figure-N.png`、`answer.png`，並產生 `review.html`（`needs-repair` 排在前面，答案區預設收合）。任何會越過答案邊界的裁切會被**拒絕**並標成 `crop-refused-crosses-answer-boundary`，不是硬切。

每次重建會安全清空該版本舊裁圖，防止已刪除或改名的候選殘留。結構校驗另跑：

```bash
python scripts/ingest/audit-review-crops.py \
  --work "<work>" --book <bookId> --variant hybrid
```

它驗證候選／manifest／資料夾集合完全一致、PNG 可解碼、題幹與答案不是同一張、沒有重複題幹或殘留檔；輸出明確標成 `structuralOnly:true`、`mathematicalCorrectnessVerified:false`，不把檔案齊全冒充數學校對。

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
- 每一題都另外帶 `displayTruth: original-pdf-crop` 與 `needsStemAsset: true`。人工轉錄只用於搜尋、作答型態與批改；沒有完整原題裁圖仍是待處理題。

輸出的記錄已用 `build-private-bank.js` 的 `validateQuestion` 實跑驗證通過，`tests/private-bank.test.js` 有一條測試釘住這個契約。本程式**不碰**正式題庫 manifest。

### 6. `promote-reviewed-stems.py` — 原題裁圖獨立複核與晉級

```bash
python scripts/ingest/promote-reviewed-stems.py \
  --source "<repo 外>/qpack.json" \
  --book-dir "<work>/<bookId>" \
  --pdf "<原始 PDF>" \
  --crop-manifest "<work>/<bookId>/crops-manifest.json" \
  --review "<repo 外>/independent-stem-review.json" \
  --output "<repo 外>/promoted" \
  --catalog textbook-catalog.js
```

它會逐題重新由原 PDF 渲染相同 bbox，要求像素與 `stem.png` 完全一致，再核對 PDF／qpack／catalog 雜湊、題號與頁碼、完整題幹和全部選項、無答案、無詳解、無前手筆跡、無鄰題，且獨立複核者不得與 qpack 製作者相同。任一項不符就整批失敗；成功也只在 repo 外產生含 `stemAsset` 的 qpack 與待上傳素材，**不會自動上傳或發布**。

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

## 舊本機索引基線（14 本）

全部 14 本皆已完成逐頁索引與來源雜湊記錄。11 本 Math A 章節教材已完成 map 與裁切：**3,391 題候選、含圖題 1,102、章末題 94.8% 配到印刷答案、0 裁切越界**。逐本數字見各書 `qa-report.md`，跨書彙總見工作目錄 `INGEST_STATUS.md`。

「OCR 沒找到詳解」不再視為安全資訊。只有逐頁目視確認且列入
`source-review-overrides.json` 的題目，才會標成 `no-printed-official-answer`；這類題目仍一律進
`needs-repair`，不得讓學生在沒有可靠答案的情況下作答。章末題缺配也維持待修。

另外三本結構不同:

- **滿級分寶典(上)(下)**(806 頁):前 ~290 頁是「課程重點回顧」(編號項目是定義與定理,不是題目),p293 起是「精選模考試題」(題目區/詳解區分開)。這是另一個版面家族;**逐頁索引已完成並快取**(未來加模考版面支援時零 OCR 成本),題目抽取尚未進行,現有輸出裡的 0 題是誠實結果不是失敗。
- **數B滿分讀寫**(160 頁,supplement):用章節書偵測器跑出 154 題候選留待審,優先度低。

完整 25 份來源的雜湊皆已記入 `textbook-catalog.js`；`ingestion` 維持 `ocr-complete-review-pending`，目前安全發布數為 0。

無法自動處理而**明列給人工**的清單(所有書合計):漏題缺號 65 題(各書 qa-report 有區塊/題型/頁碼)、頁頂無主內容 21 處、前手鉛筆 481 題、章末缺配 110 題。三次自動掛接嘗試與一次全頁回收嘗試都因目視驗證失敗而撤除——**回收與掛接只在印刷證據自己能證明的地方發生**。

## 已驗證與尚未驗證

已用實跑驗證：Mistral 25 份／6,720 頁索引完整；嚴格 QA 為 6,439 頁通過、281 頁待複核，其中 3 頁確認是原卷空白／封面，10 頁確認漏掉來源內容並已另行重跑。十四本舊製作基線的 3,786 頁也有本機頁索引；11 本章節教材的 section map、難度分層與原卷裁圖仍可作候選材料。

**已證明不能信任 OCR 題面：**針對漏頁重跑後，仍目視發現三列方程組漏掉整列，以及原題 `-5≤x<1` 被讀成 `-5≤x≤1`。後者在兩套 OCR 都一致讀錯，證明「雙引擎同意」也不能取代原卷。這就是正式 app 只顯示經獨立複核的原 PDF 題幹裁圖，而不顯示 OCR／轉錄文字的原因。

**尚未驗證**：`needs-repair` 佇列裡的每一題仍待人工判讀；`handwritingSafety` 一律 `unknown`（沒有可信的手寫偵測，掃描本身也可能有筆跡）；目前沒有任何掃描題通過完整 stem promotion，因此安全發布數仍是 0。

## 2026-08-26 成熟服務首本實跑

《直線與二元一次不等式》206/206 頁已完成 Google Enterprise Document OCR＋Math OCR，無 API 失敗；Google 偵測 252 題，本機偵測 246 題，聯集為 **260 題**（雙方共同 238、僅本機 8、僅 Google 14）。聯集保留 **72 道含圖題、80 張獨立圖裁切**，不是看到圖就省略。

先以 65 張全書接觸表逐題檢查，再對可疑項回到完整答案裁圖與原 PDF 頁面，已完成
**260／260 題原題—答案候選的目視核對**。結果如下：

- **251 題**有完整原題與書上官方答案。
- **9 題**原書本身沒有印官方答案，已逐題列入 `source-review-overrides.json` 並強制隔離。
- `line-inequality-p096-q1` 原先只切到題組導言；原因是「一、撞球／二、反射定律」被誤判成題型邊界。修正後已包含四個子題與全部圖形。
- 重建後共有 **73 道含圖題、84 張圖裁切**；新增的 4 張正是上述題組被截掉的圖。
- 結構稽核：260 題幹、260 答案檔、84 圖檔，0 缺檔、0 無效 PNG、0 重複、0 殘留、0 越界拒絕、0 警告。

完整結果記在 `reviews/matha-114-line-inequality-full-visual-qa.md`。這項核對證明的是「原卷裁圖與官方答案配對」；OCR 文字仍只是索引，260 題仍維持 `pending-review`，沒有把 OCR 轉錄冒充成數學正確題目。
