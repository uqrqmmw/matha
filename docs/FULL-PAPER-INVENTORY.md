# 完整數 A 模考庫存

更新：2026-08-29  
機器可讀清冊：`docs/full-paper-inventory.json`

## 結論

- 已核對 8 回完整來源：出版社模考 3 回，以及 111–115 學測數學 A 正式卷 5 回。
- 第一次模考已有 2026-07-18 作答救援與批改證據，不能再當新校準。
- 第二次模考原卷只有 19 題，只作練習。
- 第三次模考為 20 題、100 分鐘，題本與完整解答頁齊全；本機未找到作答紀錄，選為下一回校準候選。
- 111–115 學測數 A 均為 20 題、100 分鐘；選擇／選填答案與第 19、20 題官方評分原則齊全，但第 1–18 題沒有官方逐步詳解，且是否已看過均待確認。
- 2026-08-29 已離線掃描 Desktop、OneDrive Documents、Documents 與 Downloads 共 3,086 份 PDF。52 筆候選去重為 27 個 SHA-256；15 個無文字層候選已逐一視覺檢查，均非數學，未找到第 5 回完整數 A 卷。
- 完成本機盤點後，已透過大考中心官方歷屆試題頁以命令列取得 111–114 題本、答案與非選評分原則；逐年驗證 `%PDF-`、頁數、題號 1–20、100 分鐘標記、圖形與答案表。第三回加上 111–115，現在正好有 6 回合格結構候選。
- 2026-08-29 已把 111–115 轉成 40 張清晰完整單頁並上傳既有私有 `matha-papers` bucket；40/40 逐檔下載重算 SHA-256 與來源完全相符。另以 Supabase CLI 重新列出五個遠端目錄，建立 hash-bound `official-storage-readback-verification.json`，完工稽核會逐頁核對本機來源、App 引用、遠端名稱與回讀 bytes。五回都已接入 App 0829q，題號綁定 PDF 頁碼；正式答案與非選題公開評分原則已合併到交卷後 Edge secret，`openai-proxy` version 32。仍未完成的是本人逐回新鮮度確認與 Galaxy Tab 真機驗收。
- 第一、二回因歷史相容仍含舊答案 key，兩回均已視為公開且不再作新鮮校準。第三回答案已移出公開 `app.js`，只在雲端保存同回交卷狀態後由 Edge Function 回傳；2026-08-29 已實測未交卷 403、已交卷 200、20 題共 100 分，且此閘門不呼叫 OpenAI。

## 來源檔案

| 代號 | 檔案 | PDF 頁數 | SHA-256 |
|---|---|---:|---|
| `publisher-question` | `數模 1-3回.pdf` | 11 | `db29c53f5910bf591482b291449a66d6027fa203999e1c6e34b89126250843c3` |
| `publisher-answer` | `數模 1-3 答案.pdf` | 4 | `212721b3516b3ad081c2caa0d4fedc241fd3d25238a8060a27dba9255b936130` |
| `official-115-question` | `115_mathA_question.pdf` | 8 | `e867988978a81ecf07e58d9e6bf9164afae7be20590cf023fb618efae275c2e3` |
| `official-115-answer` | `115_mathA_answer_after.pdf` | 1 | `0308d00e554aa2b1a1f68215df8c93943d4aa2ecd326127c3828b971867f67c0` |
| `official-115-scoring` | `115_mathA_scoring_after.pdf` | 3 | `872f82af8cbf0d4dd4ddd0d0a80d1c400b136b8cad48665b94d6ff5a5ec1430f` |
| `official-114-question` | `114_mathA_question.pdf` | 8 | `265a18f8de05f24d13a503229943414ca50ad9441f056318d21850386427a290` |
| `official-114-answer` | `114_mathA_answer.pdf` | 1 | `65666aea83fd2c71cb177fcc50852e0c69d0eb8cea8434dceed6e9ff0620803d` |
| `official-114-scoring` | `114_mathA_scoring.pdf` | 3 | `1e17ff84022db05bdb1424ac45f73cb485d01661a8aad0e5f5debf54728168a4` |
| `official-113-question` | `113_mathA_question.pdf` | 8 | `c0dbc1bd50a8bedcf48ead6bf8e1fb0deef03d92113015e37dc20bb097be8e50` |
| `official-113-answer` | `113_mathA_answer.pdf` | 1 | `eecb107883266a831db61b4e2129bc6ca51862e502623bcea6180e3eabe73169` |
| `official-113-scoring` | `113_mathA_scoring.pdf` | 2 | `199887c5a084674cfb8f300facdefc70990a15b0a05b44428e7d75a52d461569` |
| `official-112-question` | `112_mathA_question.pdf` | 8 | `fd0d3aebd2ff9cd3b775db0642326ce0d5be0f5bf2bb3176294082fabe6b13cc` |
| `official-112-answer` | `112_mathA_answer.pdf` | 1 | `d096806d2441209d715f16eec62e4834760032a830ffa30818d473dff5b3202d` |
| `official-112-scoring` | `112_mathA_scoring.pdf` | 3 | `b56034e4428cd8a1f733b8d90d891c6429c6eefc06fe8dfe820f81c3057360ad` |
| `official-111-question` | `111_mathA_question.pdf` | 8 | `01ceb21ac453e1b8f1e2cdbc015f0d648f3b63c72d5d0c64555d6fd085c5aa9f` |
| `official-111-answer` | `111_mathA_answer.pdf` | 1 | `176497242f9910d56ba0441bddae22ea9be597e48b6a3239ebb19860b11b6c1c` |
| `official-111-scoring` | `111_mathA_scoring.pdf` | 3 | `dd5905060a7eaeb04e994dc27ad08ef5b763dc704db33098839550d65b653015` |

出版社題本的緊急備份 `source-mocks-1-3.pdf` 與目前 `數模 1-3回.pdf` SHA-256 完全相同，不重複計為新來源。

115 學測三份原檔已從舊診斷資料夾按上述 SHA-256 找回，並集中複製到私人素材根目錄的 `完整模考來源/115/`；`full-paper-inventory.json` 已加入可重現的 `pathHint`。2026-08-29 的完工稽核重新逐檔驗證五份來源全部相符。

111–114 三類原檔直接取自[大考中心歷年試題及答題卷](https://www.ceec.edu.tw/xmfile?xsmsid=0J052424829869345634)的年度頁；官方 URL、私人 `pathHint`、頁數與 SHA-256 都保存在機器清冊。題本與答案 PDF 不進公開 repo。

本機全量盤點由 `scripts/audit-local-full-paper-sources.py` 執行，只使用 Poppler 讀頁數與既有文字層，不做 OCR、不連網、不修改原檔。私人報告為 `完整模考來源/本機完整卷盤點-20260829.json`；無文字層候選接觸表與複核 manifest 保存在 `完整模考來源/盤點證據-20260829/`。完工稽核會重算兩份 manifest 的 SHA-256、候選計數與視覺複核狀態；136 份讀取失敗檔均位於非數學路徑，數學／考試路徑讀取失敗為 0。此盤點證明已知本機範圍沒有額外來源，但不能替已知卷確認「本人沒看過」。

## 逐回判定

| 回別 | 題本頁面 | 題數／時間 | 答案與詳解 | 新鮮度證據 | 校準判定 |
|---|---|---|---|---|---|
| 第一次模考 | 題本 PDF 2–4；印刷 6 頁 | 20／100 分鐘 | 答案 PDF 1–2，完整 | 有 2026-07-18 作答救援與批改紀錄 | 已看過，只保留歷史與練習 |
| 第二次模考 | 題本 PDF 6–8；印刷 6 頁 | 19／100 分鐘 | 答案 PDF 2–3，完整 | 未找到作答證據，但結構不合格 | 練習卷，不進趨勢 |
| 第三次模考 | 題本 PDF 10–11；印刷 4 頁 | 20／100 分鐘 | 答案 PDF 3–4，完整；交卷後端閘門已上線 | 未找到本機作答或救援紀錄 | **下一回候選**；開始前確認未看過並通過真機開考檢查 |
| 115 學測數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 選填答案完整；官方詳解僅第 19、20 題；交卷後取 key | 尚未確認是否看過 | 已接入；待本人確認與真機檢查 |
| 114 學測數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 選擇／選填答案；官方評分原則第 19、20 題；交卷後取 key | 舊計畫提過未來使用，但下載前無本機題本或作答證據 | 已接入；待本人確認與真機檢查 |
| 113 學測數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 選擇／選填答案；官方評分原則第 19、20 題；交卷後取 key | 本機未找到作答證據；不等於確定未看過 | 已接入；待本人確認與真機檢查 |
| 112 學測數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 選擇／選填答案；官方評分原則第 19、20 題；交卷後取 key | 本機未找到作答證據；不等於確定未看過 | 已接入；待本人確認與真機檢查 |
| 111 學測數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 選擇／選填答案；官方評分原則第 19、20 題；交卷後取 key | 本機未找到作答證據；不等於確定未看過 | 已接入；待本人確認與真機檢查 |

## 下一個 P0

1. 在 Galaxy Tab S10 Ultra 對第三回執行既有七項開考檢查；本人確認未看過後，完成 100 分鐘作答、暫停／恢復、交卷與 PDF，再按「同步並匯出驗收檔」。合格證據由 Edge v32 重讀雲端狀態後自動封存到私人 Supabase，另下載本機備份。
2. 隔日完成不看詳解的重想，再驗證官方詳解與 AI 詳批閉環。
3. 111–115 已接入；每回第一次建立 run 時 App 會詢問是否未看過。取消仍可練習，但該回不進級分校準；六回若有任一回已看過，才另補外部新來源。

完成真機驗收後，桌面稽核不需要人工搬平板下載檔；在 repo 執行以下兩行即可從私有 Supabase 抓回 hash-bound 封存並重建稽核：

```powershell
python scripts/fetch-private-runtime-audits.py
python scripts/audit-blueprint-readiness.py
```

抓取器固定使用 Windows 已實測能單檔下載的 Supabase CLI 2.115.0；只接受 `runtime-audits/<user-hash>/matha-paper-runtime-audit-<run>-<sha16>.json`，下載後重算完整 SHA-256。沒有檔案時回報 0 筆，不會把索引冒充驗收證據。

## 安全邊界

- 清冊只保存檔名、頁碼與 hash；題本、答案及詳解 PDF 不進公開 Git repo。
- 缺完整詳解不妨礙題本作為練習，但不能宣稱已完成隔日詳批閉環。
- 「未找到紀錄」不是「確定未看過」；每回第一次建立校準 run 前仍須確認。
