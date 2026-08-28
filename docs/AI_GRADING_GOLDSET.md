# 原卷首輪批改 gold set

用途：把「AI 看起來改得像」改成可量測、可阻擋上線的 20 題回歸測試。私人作答、筆跡位置與 PDF 不進公開 repo；repo 只保留 evaluator、合成負例與操作方式。

## 第一回私人基準

- 私人 gold：`C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-gold-v1.json`
- 歷史 AI 75 分讀法：`C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-ai75-prediction-v1.json`
- 人工逐題真值總分：70／100。
- 已確認的關鍵失敗：舊 AI 把第 4 題「圈住印刷題號 4」誤讀成選項 (4)，因此錯加 5 分。19／20 的答案擷取率雖恰好是 95%，仍因總分、負例安全與紅筆定位關卡失敗而禁止宣稱可用。
- 2026-08-29 現行結果：固定 `gpt-5.5-2026-04-23` 重測為答案 20／20、狀態與配分 20／20、複選 30／30、負例 2／2、總分 70／100。模型座標不直接當真；以原作答時已保存的向量筆跡吸附後，18 個有答案案例的紅筆位置為 18／18。

私人基準逐題綁定原作答 PDF、官方答案 PDF、最終 70 分覆核 PDF及舊 75 分 PDF 的 SHA-256；任一來源漂移就停止評測。每個已作答題都有人工圈定的答案區，未作答題則有明示不可當答案的負例區。

## 執行

只驗證私人 gold schema 與來源：

```powershell
$env:MATHA_PRIVATE_PAPER_GOLD = 'C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-gold-v1.json'
node --test tests/paper-grade-gold.test.js
```

比較一次模型輸出：

```powershell
node scripts/evaluate-paper-grade-gold.js `
  --gold 'C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-gold-v1.json' `
  --prediction '<private-prediction.json>'
```

若要重現正式 app 的向量筆跡吸附，先把私人 `ink_sessions` 匯出到本機，再正規化：

```powershell
node scripts/normalize-paper-grade-eval-response.js `
  --response '<private-edge-response.json>' `
  --out '<private-prediction.json>' `
  --ink-sessions '<private-ink-sessions.json>' `
  --run-id '<paper-run-id>'
```

未作答與不確定題固定使用右側摘要，不在印刷題號或題幹上猜紅筆位置。向量吸附只改紅筆位置，不改答案、對錯或分數。

必須同時通過：答案擷取至少 95%、逐題狀態／分數與總分完全正確、複選五個選項狀態完全正確、圈題號負例完全正確、至少 90% 已作答題的紅筆落在人工答案區。任何一項失敗，`safeToShip` 都是 `false`。

## 隔日詳批與官方詳解像素

第一回 7 題真實失分題（3、4、11、12、13、14、16）另有第二輪私人基準：

- gold：`C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-detail-gold-v1.json`
- 每題都綁定學生原作答像素、官方詳解像素與來源 PDF SHA-256；第 12 題跨兩張官方詳解裁圖。
- 第 3、4、16 題的卷面不足以唯一定位第一錯步，真值要求 abstain；不能為了 coverage 亂猜。
- 第 11、12、13、14 題有可核對的第一錯步證據；同時評量 AI 是否指出已做對的部分。
- 目前 `releaseAuthority:false`，代表資料與 evaluator 已完成，但尚未經具名真人逐題簽核，不能宣稱詳批已可正式發布。

驗證私人 gold 的來源與像素：

```powershell
$env:MATHA_PRIVATE_PAPER_DETAIL_GOLD = 'C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-detail-gold-v1.json'
node --test tests/paper-detail-gold.test.js
```

比較一次實際 `paper_detail` 輸出：

```powershell
node scripts/evaluate-paper-detail-gold.js `
  --gold 'C:\Users\yenke\Desktop\數學檔案\matha-private-evals\paper-mock-1-detail-gold-v1.json' `
  --prediction '<private-detail-prediction.json>' `
  --allow-fail
```

正式門檻分開計算：有診斷輸出的 precision ≥ 90%、可診斷案例 coverage ≥ 60%、abstain 題無證據診斷為 0、正確前綴辨識 ≥ 80%，最後再由具名真人把 `releaseAuthority` 簽為 true。

官方詳解圖存放在私有 `matha-solutions` bucket，不設一般登入者讀取 policy。前端只有在雲端已保存「到期隔日訂正＋至少一次真實重想」後，才能向 Edge Function 取得 15 分鐘簽名網址；圖不進 `app_state`、IndexedDB、Service Worker 或首輪批改 response，也不經 OCR 重打。`paper_solution` 不呼叫 OpenAI，因此重開詳解不會產生模型費用。
