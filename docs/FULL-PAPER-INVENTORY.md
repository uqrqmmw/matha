# 完整數 A 模考庫存

更新：2026-08-29  
機器可讀清冊：`docs/full-paper-inventory.json`

## 結論

- 已核對 18 回來源：出版社模考 3 回、111–115 學測數學 A 正式卷 5 回、110 年試辦 1 回、111 學年度起適用參考卷 1 回，以及南一／北北基地區模考 8 回。
- 第一次模考已有 2026-07-18 作答救援與批改證據，不能再當新校準。
- 第二次模考原卷只有 19 題，只作練習。
- 第三次模考為 20 題、100 分鐘，題本與完整解答頁齊全；本機未找到作答紀錄，選為下一回校準候選。
- 111–115 學測數 A 均為 20 題、100 分鐘；選擇／選填答案與第 19、20 題官方評分原則齊全，但第 1–18 題沒有官方逐步詳解，且是否已看過均待確認。
- 110 年試辦考試為 20 題、100 分鐘，題本、答案、非選評分原則與第 1–20 題完整官方詳解均齊全；已接入作為後備校準候選。111 學年度參考卷只有 19 題，僅供練習，不進級分校準。
- 2026-08-29 已離線掃描 Desktop、OneDrive Documents、Documents 與 Downloads 共 3,086 份 PDF。52 筆候選去重為 27 個 SHA-256；15 個無文字層候選已逐一視覺檢查，均非數學，未找到第 5 回完整數 A 卷。
- 完成本機盤點後，已透過大考中心官方頁面以命令列取得 111–114、110 試辦與 111 參考卷的題本及官方答案資料；逐份驗證 `%PDF-`、頁數、題數、100 分鐘標記、圖形與答案表。第三回、111–115 與 110 試辦共 7 回合格結構候選，足以覆蓋第一階段 6 回並保留 1 回候補。
- 2026-08-29 已把六回大考中心卷與八回地區模考轉成 73 張清晰完整單頁並上傳私有 `matha-papers`；73/73 逐檔下載重算 SHA-256，0 筆不符。14 回都已接入 App 0829u 並綁定 20 題到來源頁；私密答案 secret 現含既有第三回與這 14 回，共 15 回、300 題，每回 100 分，Edge v36 嚴格解析通過。110 試辦 8 頁與八回地區模考 32 頁官方完整詳解均已上傳 `matha-solutions`、逐頁回讀驗 hash，只有隔日真實重想後才簽發短效網址。仍未完成的是本人逐回新鮮度確認與 Galaxy Tab 真機驗收。
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
| `official-110-trial-question` | `110_trial_mathA_question.pdf` | 8 | `1ca9666862d7746dd0378e8dcbdd66236cd09af7a7f5db224ab93f6cc8cca129` |
| `official-110-trial-answer` | `110_trial_mathA_answer.pdf` | 1 | `0901af3555a20a2f7d795c6e1d0a2e1f9e9db556729cfd9db02da227aaac4e86` |
| `official-110-trial-scoring` | `110_trial_mathA_scoring.pdf` | 3 | `7c19c8ec0d7001e12dfaa9b452bbb06c8b2c700971a05b6d5a14d31aafc3a19e` |
| `official-110-trial-solution` | `110_trial_mathA_solution.pdf` | 8 | `a57633987dcbd0977d2c7d1dc56d50422b4ed033de1f0c6ec49718a2c146554e` |
| `reference-111-question` | `111_reference_mathA_question.pdf` | 10 | `1e508331b0183d06786ac7954505f35e7fff5e676c48c7add08d225e4cf9e305` |
| `reference-111-answer` | `111_reference_mathA_answer.pdf` | 2 | `2b6354b999a27bbf2858b19ad99075a8c9466942aaf45b5d51379e5ef2ab5faa` |
| `reference-111-solution` | `111_reference_mathA_solution.pdf` | 9 | `7b546931a93d901de5d50c31b18466698d18260499c400c6900dd1cb3ae66fc4` |
| `tcfsh-ra4109-question` | `RA4109.pdf` | 5 | `dceb1a11d6b2b2f5206a50b9e57567309ffc1187bf9ef0d18f174548af04e4c8` |
| `tcfsh-ra4109-solution` | `RA4109ans1.pdf` | 4 | `d157bba551c267cf26a8a900b80fff5e861daf94e761771b7ae8a9c34e6649eb` |
| `tcfsh-ra4110-question` | `RA4110.pdf` | 4 | `0ddd8085031412b61498c93fc5cd2d0b33891b331b2025b2abd1bea47bc3e111` |
| `tcfsh-ra4110-solution` | `RA4110ans1.pdf` | 5 | `736888bcb56fdaaefbe84d30a61457336ade90f5e07363eccb854b4037af50dc` |
| `tcfsh-ra3101-question` | `RA3101.pdf` | 4 | `e0f7830feb80d16a9b9cf10a95066fafd0e9505553ea97c10b1bb4ed52d15cfa` |
| `tcfsh-ra3101-solution` | `RA3101ans1.pdf` | 6 | `9cabb2fb24949e306d098e61af0d5371ace4494bbb6bb14ddabdf57d69102221` |
| `tcfsh-ra3102-question` | `RA3102.pdf` | 4 | `1362f691bb04fcd1063ddfeaa156838fb5007db964b01e3a4b06c9770c080f6a` |
| `tcfsh-ra3102-solution` | `RA3102ans1.pdf` | 3 | `e26450ba362f00e66cf989e25993369d08817c07a2c45887d2c8bbf5b577762d` |
| `tcfsh-ra1104-question` | `RA1104.pdf` | 4 | `d71f01fcdd85d20c1fe101b7e7c338cb07bae9d21ef8de732ba61edd8078b3c5` |
| `tcfsh-ra1104-solution` | `RA1104ans1.pdf` | 4 | `60fe0f6799f0a421ad3d05530a1e2313a52dca2510a26523fcae263215006b75` |
| `tcfsh-ra2100-question` | `RA2100.pdf` | 4 | `a6b63f764214fbebf28caa14e625be136eb7f2950deac9a4ae363e042530432d` |
| `tcfsh-ra2100-solution` | `RA2100ans1.pdf` | 3 | `778859ae6fdfe801490fa311a47c04d2ffe110b6e7162a23f09700cddbc90de7` |
| `tcfsh-ra2101-question` | `RA2101.pdf` | 4 | `c297a8dfa566af527e243ae540b40cd98e56db7c8792a9cd0e41f7034cd25a9d` |
| `tcfsh-ra2101-solution` | `RA2101ans1.pdf` | 5 | `b7159babac6cbb93e2b0d55e46884bf2b4366831b6c8d6063b4b0be53e43879d` |
| `tcfsh-ra1103-question` | `RA1103.pdf` | 4 | `dbed23f355fa626324f5c0df305563f2561778103b0daed9bae276ce6a5e0347` |
| `tcfsh-ra1103-solution` | `RA1103ans1.pdf` | 2 | `86a15ebc2d61551e027c0dd5dee4ef29e9eedec546421042593213fdc0d051bf` |

出版社題本的緊急備份 `source-mocks-1-3.pdf` 與目前 `數模 1-3回.pdf` SHA-256 完全相同，不重複計為新來源。

115 學測三份原檔已從舊診斷資料夾按上述 SHA-256 找回，並集中複製到私人素材根目錄的 `完整模考來源/115/`；110 試辦與 111 參考卷分別放在 `完整模考來源/110-trial/`、`完整模考來源/111-reference/`，八回地區卷與解答放在 `完整模考來源/tcfsh-candidates-20260829/`。`full-paper-inventory.json` 已加入可重現的 `pathHint`，完工稽核會逐檔重驗全部 40 份來源文件。

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
| 110 年試辦考試數 A | 題本 PDF 1–8；App 私有 8 單頁 | 20／100 分鐘 | 答案、非選評分原則與第 1–20 題官方完整詳解；交卷後取 key、隔日重想後取詳解 | 本機未找到作答證據；不等於確定未看過 | 已接入；後備候選，待本人確認與真機檢查 |
| 南一／北北基八回地區模考 | 題本各 3–4 個私有題目頁，共 25 頁 | 各 20／100 分鐘 | 160 題正式答案與共 32 頁出版者詳解；交卷後取 key、隔日重想後逐題取詳解 | 本機未找到作答證據；不等於確定未看過 | 八回全接入；待本人逐回確認與真機檢查 |
| 111 學年度參考卷數 A | 題本 PDF 1–10 | 19／100 分鐘 | 官方答案與完整詳解 | 未找到作答證據，但結構不合格 | 練習卷，不進趨勢 |

## 下一個 P0

1. 在 Galaxy Tab S10 Ultra 對任一本人確認未看過的 20 題卷執行既有七項開考檢查；完成 100 分鐘作答、暫停／恢復、交卷與 PDF，再按「同步並匯出驗收檔」。合格證據由 Edge v36 重讀雲端狀態後自動封存到私人 Supabase，另下載本機備份。
2. 隔日完成不看詳解的重想，再驗證官方詳解與 AI 詳批閉環。
3. 六回大考中心卷與八回地區模考均已接入；每回第一次建立 run 時 App 會詢問是否未看過。取消仍可練習，但該回不進級分校準；加上第三回共有 15 回結構合格候選，暫不再花時間擴充模考來源。

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
