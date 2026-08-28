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
