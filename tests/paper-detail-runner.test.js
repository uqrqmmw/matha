'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invoke, loadOrCreate, predictionBase, promptFor } = require('../scripts/run-paper-detail-gold');

test('詳批 gold runner 沿用正式的保守診斷規則與正式答案', () => {
  const prompt = promptFor({ no: 12, officialAnswer: '(1)(4)(5)' }, [{ direction: '先畫圖' }]);
  assert.match(prompt, /看不清楚或無法唯一判定時，confidence=low/);
  assert.match(prompt, /firstErrorEvidence=null/);
  assert.match(prompt, /正式最終答案：\(1\)\(4\)\(5\)/);
  assert.match(prompt, /考生隔日重想紀錄：\[\{"direction":"先畫圖"\}\]/);
});

test('詳批 runner 只呼叫 MathA Edge Function 且不接受 OpenAI key', async () => {
  let request;
  const payload = await invoke('short-lived-user-jwt', { responseType: 'paper_detail' }, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ json: { readable: true } }) };
  });
  assert.equal(payload.json.readable, true);
  assert.match(request.url, /supabase\.co\/functions\/v1\/openai-proxy$/);
  assert.equal(request.options.headers.authorization, 'Bearer short-lived-user-jwt');
  assert.equal(Object.hasOwn(request.options.headers, 'openai-api-key'), false);
});

test('已完成 prediction 只有所有綁定相同才續跑，避免重複付費', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-detail-runner-'));
  try {
    const goldPath = path.join(temp, 'gold.json');
    const output = path.join(temp, 'prediction.json');
    fs.writeFileSync(goldPath, '{"schema":1}\n');
    const gold = { id: 'gold-1' };
    const base = predictionBase(gold, goldPath, 'run-1', 'prompt-a');
    base.cases.push({ no: 3 });
    fs.writeFileSync(output, JSON.stringify(base));
    assert.equal(loadOrCreate(gold, goldPath, 'run-1', 'prompt-a', output).cases.length, 1);
    assert.throws(() => loadOrCreate(gold, goldPath, 'run-1', 'prompt-b', output), /拒絕重複付費覆寫/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
