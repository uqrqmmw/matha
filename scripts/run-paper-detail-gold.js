'use strict';

/* Run the private seven-question paper_detail gold set through the deployed
   MathA Edge Function.  The script never accepts an OpenAI key: it requires a
   short-lived MathA user JWT, preserves partial progress, and refuses to pay
   twice for an already completed question under the same prompt and asset. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateGold } = require('./evaluate-paper-detail-gold');

const ENDPOINT = 'https://rrihysbxhsbxjteqmtdu.supabase.co/functions/v1/openai-proxy';
const PUBLISHABLE_KEY = 'sb_publishable_p6ThWGf5DLp6XRCovZMVDQ_9vJG_Y41';
const TYPE_BY_NO = new Map([[3, 'single'], [4, 'single'], [11, 'multi'], [12, 'multi'],
  [13, 'multi'], [14, 'fill'], [16, 'fill']]);
const RUNNER_VERSION = 1;

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

function promptFor(row, attempts) {
  return `你是嚴謹但會指出學生優點的台灣學測數學訂正老師。目標不是泛泛講詳解，而是根據卷面證據，準確找出考生推理中第一個不成立的位置。

成功標準：
1. 先獨立解出印刷題目並核對正式答案，再判讀學生方法；不可拿正式答案倒推一個學生沒寫過的錯誤。
2. 依卷面順序找出「最長的正確前綴」：goodWork 逐項列出實際做對的式子、判斷或方向，不可只寫「有努力」「觀念不錯」。
3. firstErrorEvidence 必須逐字轉錄第一個錯誤或缺口附近、確實看得到的學生式子；firstError 說明這一步為何開始不成立；whyWrong 用代入、重算、反例或定義驗證。
4. repair 只給修好第一個錯誤所需的下一行，不一次跳到結論。solution 才放完整正確解法。
5. 等價但不同於參考路線的方法仍算對。每個數值、正負號、分母、選項與等號轉換都要自己重算。
6. 看不清楚或無法唯一判定時，confidence=low、firstErrorEvidence=null、firstError=null、errorKind=null、marks=[]；寧可保留不確定，也不可編造。
7. confidence=high 只用於手寫式與錯誤位置都清楚、且已完成獨立驗證時；medium 表示方法可讀但某一小段仍有歧義。
8. marks 只在 confidence=high 時框住第一個錯誤的實際卷面區域，否則留空；label 固定寫「第一個錯誤」。

圖片是第 ${row.no} 題的原掃描題面、考試當天筆跡與第一次紅筆簡批。只處理第 ${row.no} 題。
正式最終答案：${row.officialAnswer}
題型：${TYPE_BY_NO.get(Number(row.no)) || 'unknown'}
考生隔日重想紀錄：${JSON.stringify(attempts || [])}
考生對 AI 辨識的補充／更正：（無）

這是使用者主動要求的本題詳解，現在可以提供錯誤步驟分析與完整解法。`;
}

function predictionBase(gold, goldPath, paperRunId, promptHash) {
  return {
    schema: 1,
    kind: 'paper-detail-gold-prediction',
    releaseAuthority: false,
    goldId: gold.id,
    goldSha256: sha256Buffer(fs.readFileSync(goldPath)),
    paperRunId,
    runnerVersion: RUNNER_VERSION,
    promptSha256: promptHash,
    modelPolicy: 'deployed-matha-fixed-gpt-5.5',
    generatedAt: new Date().toISOString(),
    cases: [],
  };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function loadOrCreate(gold, goldPath, paperRunId, promptHash, output) {
  const fresh = predictionBase(gold, goldPath, paperRunId, promptHash);
  if (!fs.existsSync(output)) return fresh;
  const existing = JSON.parse(fs.readFileSync(output, 'utf8'));
  for (const key of ['goldId', 'goldSha256', 'paperRunId', 'runnerVersion', 'promptSha256']) {
    if (existing[key] !== fresh[key]) throw new Error(`既有 prediction 的 ${key} 不同，拒絕重複付費覆寫`);
  }
  if (!Array.isArray(existing.cases)) throw new Error('既有 prediction cases 不合法');
  return existing;
}

async function invoke(jwt, body, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 95_000);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', signal: controller.signal,
      headers: {
        apikey: PUBLISHABLE_KEY,
        authorization: `Bearer ${jwt}`,
        origin: 'https://uqrqmmw.github.io',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`paper_detail HTTP ${response.status}: ${String(payload.message || 'unknown error')}`);
    if (!payload.json || typeof payload.json !== 'object') throw new Error('paper_detail 沒有結構化結果');
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const goldPath = path.resolve(argValue('--gold'));
  const output = path.resolve(argValue('--out'));
  const paperRunId = argValue('--paper-run-id');
  const jwt = String(process.env.MATHA_EVAL_USER_JWT || '');
  if (!goldPath || !output || !paperRunId || !jwt) {
    throw new Error('Usage: MATHA_EVAL_USER_JWT=<short-lived JWT> node scripts/run-paper-detail-gold.js --gold <gold.json> --paper-run-id <id> --out <private.json>');
  }
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  validateGold(gold, { verifySources: true });
  let attempts = {};
  if (process.env.MATHA_EVAL_ATTEMPTS_JSON) {
    attempts = JSON.parse(process.env.MATHA_EVAL_ATTEMPTS_JSON);
  }
  const promptHash = sha256Buffer(Buffer.from(gold.cases.map((row) =>
    promptFor(row, attempts[row.no] || attempts[String(row.no)] || [])).join('\n---\n')));
  const prediction = loadOrCreate(gold, goldPath, paperRunId, promptHash, output);
  const completed = new Set(prediction.cases.map((row) => Number(row.no)));
  for (const row of gold.cases) {
    if (completed.has(Number(row.no))) {
      console.log(`reused ${row.no}`);
      continue;
    }
    const asset = path.resolve(gold.assetRoot, row.studentEvidence.file);
    const image = fs.readFileSync(asset).toString('base64');
    const prompt = promptFor(row, attempts[row.no] || attempts[String(row.no)] || []);
    console.log(`request ${row.no}`);
    const payload = await invoke(jwt, {
      responseType: 'paper_detail',
      context: { paperRunId, questionNo: Number(row.no) },
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
        { type: 'text', text: `【第 ${row.no} 題高解析焦點圖】` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
      ] }],
    });
    prediction.cases.push({
      no: Number(row.no),
      studentEvidenceSha256: String(row.studentEvidence.sha256).toUpperCase(),
      ...payload.json,
      model: String(payload.model || ''),
      requestId: String(payload.requestId || ''),
      usage: payload.usage || null,
    });
    prediction.generatedAt = new Date().toISOString();
    writeAtomic(output, prediction);
    console.log(`saved ${row.no}`);
    await new Promise((resolve) => setTimeout(resolve, 4_500));
  }
  console.log(`complete ${prediction.cases.length}/${gold.cases.length}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error && error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { invoke, promptFor, predictionBase, loadOrCreate };
