# WIP 交接：原卷交卷、批改與隔日詳批可靠性

時間：2026-08-31（Asia/Taipei）
工作分支：`codex/paper-reliability-checkpoint-20260830`
可恢復 checkpoint：`2b23a49f1705bfdf8e8f42c61b231e7f346915e0`
正式 `main` 基準：`863beaf957d9d27dcc04e7002d6f2808b7c2501b`
狀態：資料庫協定與 Edge Function v37 已部署；正式前端尚未合併／部署，不能宣稱工程或使用目標完成。

## 最終成功條件

1. Galaxy Tab S10 Ultra 完整 100 分鐘真機紀錄。
2. 六回本人確認未看過的 20 題／100 分鐘正式卷。
3. 最近三回不同來源正式卷皆至少 72/100。
4. 七題真實隔日訂正第一錯步 precision 至少 90%、coverage 至少 60%。
5. 三十題真實錯題 gold。

目前仍為 0/5；不可要求使用者現在作答來代替工程驗證。

## 不可違反

- 不使用內建 browser。
- 工程測試不呼叫 OpenAI API；正式 App 模型固定 GPT-5.5。
- 不重跑 YesScanner、OCR 或任何付費去筆跡。
- 不重建、不重傳、不重付既有 217 題 bundle。
- 五項真實使用證據未全數完成前，不得把 goal 標為 complete。

## 已完成並已保存

- Migration 001–011 已透過固定版 Supabase CLI 部署至專案 `rrihysbxhsbxjteqmtdu`；部署後逐筆核對 local/remote migration，001–011 全部一致。重開後不得重跑或重複付費。
- Migration 011 新增獨立 `paper_detail_jobs` 狀態機：generation 0、明確重新分析才核發 N+1、CAS/鎖定、claim、dispatched、complete、status，以及 immutable 完成 receipt。
- 詳批輸入由伺服器從 accepted DB row、正式答案、私有來源 PNG、accepted ink/retry receipt 重建；瀏覽器 messages、instructions、JPEG 不具權威且會被拒絕。
- Edge 已完成 claim → dispatch → complete、pending、exact replay、不可自動重送 dispatched job，以及 receipt/model metadata 綁定；遠端版本 37 已正式部署，下載回讀的 9 個執行檔與本機 SHA-256 全數一致。
- App 已完成 generation/status/receipt 流程及多層 digest 驗證；只有通過 DB receipt、result digest、model metadata 與 prediction metadata 的結果才可保存。
- `APP_VER`／Service Worker 資產版本為 `0830c`；正式考卷協定另固定 `PAPER_PROTOCOL_APP_VERSION = '0830b'`，一般快取更新不會讓既有／進行中的正式卷失效。
- 工作分支 checkpoint 已推送遠端，重開機後可從上述 branch/commit 繼續。

## 已通過的工程測試

- Web：319 tests，317 pass、0 fail、2 intentional skips。
- Edge：47/47 pass；Deno fmt、check、tests 全部通過。
- PostgreSQL integration：23 pass、1 intentional legacy skip。
- Python／資料／部署：370/370 pass。
- `git diff --check` 通過，未發現新增的明顯 secret pattern。

## 目前唯一關鍵路徑

1. 將同一已驗證 HEAD 合併／推送 `main`，再做 GitHub CI、Pages byte-exact、Service Worker `0830c` 與正式前端回讀驗證。
2. 更新 `SYSTEM_COMPLETION_BLUEPRINT.md`、工程驗收文件及 `C:\Users\yenke\Desktop\數學系統藍圖.md`。
3. 工程關卡全數完成後才進入五項真實使用驗證；未達 5/5 不得結案。

本檔是重開機續作的權威位置，不是最終產品驗收證據。
