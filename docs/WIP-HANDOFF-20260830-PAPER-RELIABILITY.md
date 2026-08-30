# WIP 交接：原卷交卷、批改與隔日詳批可靠性

時間：2026-08-30（Asia/Taipei）
正式 `main` 基準：`863beaf957d9d27dcc04e7002d6f2808b7c2501b`
狀態：施工 checkpoint；不可部署、不可宣稱工程完成。

## 最終成功條件

1. Galaxy Tab S10 Ultra 完整 100 分鐘真機紀錄。
2. 六回本人確認未看過的 20 題／100 分鐘正式卷。
3. 最近三回不同來源正式卷皆至少 72/100。
4. 七題真實隔日訂正第一錯步 precision 至少 90%、coverage 至少 60%。
5. 三十題真實錯題 gold。

## 不可違反

- 不使用內建 browser。
- 工程測試不呼叫 OpenAI API；正式 App 模型固定 GPT-5.5。
- 不重跑 YesScanner、OCR 或任何付費去筆跡。
- 不重建、不重傳、不重付既有 217 題 bundle。
- 五項真實使用證據未全數完成前，不得把 goal 標為 complete。

## 本 checkpoint 已完成

- Migrations 001–010、交卷 winner、凍結 accepted ink、逐頁 manifest、整卷 grade job、completion artifact、最新世代、server source registry、correction retry receipt 與 correction-grade job 均已在工作樹完成，但尚未正式部署。
- 整卷 `paper_grade` 與 `paper_correction_grade` 的模型輸入改由伺服器從 accepted DB row、私有來源 PNG、正式答案與 immutable ink receipt 重建。
- 新增 `paper-detail-model-input.ts` 與 7 項測試：伺服器固定建立 A 原題、B 初答對位、C 初答完整、D 訂正對位、E 訂正完整五張影像；瀏覽器 messages／影像不在介面內。
- `app.js` 的逐題詳批請求已只送 run/source/question/accepted attempt/retry receipt 與受限 note/log，不再送 browser JPEG 或 prompt。
- `index.ts` 已開始接入 `preparePaperDetailAuthority`：拒絕 client messages/instructions，從 accepted page ink、retry receipt、正式答案與私有 PNG 重建輸入。此段尚未完成 job/result receipt 接線。
- 低信心／未答／不確定及僅看詳解的狀態不再自動發明錯因污染長期弱點。

## 下一個唯一關鍵路徑

1. 新增 `paper_detail` DB idempotency 狀態機（建議 migration 011）：generation 0、明確重新分析才核發下一代、claim／mark-dispatched／complete／status；dispatched 永不自動重送。
2. 詳批完成結果建立 immutable DB receipt，綁 job、generation、run/source/question、accepted attempt、retry receipt、model-input binding、result/metadata digest。
3. `index.ts` 完成 job claim、pending、dispatch、complete、exact replay；禁止 browser authority。
4. `app.js` 重算並驗證 result receipt、job、model metadata 與 prediction metadata 後才保存及列入 7／30 gold。
5. 修掉舊 `tests/durability.test.js` 契約與 Edge Deno fmt，將 detail module 加入 `test:edge`。
6. 跑 `npm test`、`npm run test:figures`、`npm run test:postgres`、`npm run test:edge`；全綠後才部署 migrations、Edge、App。
7. 對最終 HEAD 重做 Storage、JWT/RLS loader、CI、Pages byte-exact 證據，更新桌面藍圖後乾淨推 `main`。

## 最近已知測試基準

- Web：315 pass、1 stale-contract fail、2 intentional skip。
- Python：359/359 pass。
- PostgreSQL 17 protocol：19 pass、1 intentional legacy skip。
- Edge：停在 `index.ts` Deno fmt，尚未進 typecheck/test。
- `paper-detail-model-input` 單獨 Deno check 與 7/7 test 通過。

本檔只保存重開機續作位置，不是工程驗收證據。
