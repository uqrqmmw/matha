'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT } = require('./helpers/load-app');

test('schema 提供 app_state revision CAS 與筆跡 client_id 冪等索引', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  assert.match(schema, /revision\s+bigint\s+not null default 0/i);
  assert.match(schema, /alter table public\.app_state add column if not exists revision/i);
  assert.match(schema, /client_id\s+text/i);
  assert.match(schema, /unique index if not exists ink_sessions_user_client[\s\S]*\(user_id, client_id\)/i);
});

test('原版模考 bucket 保持私有且只有核准帳號能讀取', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const paperBlock = schema.slice(schema.indexOf("'matha-papers'"));
  assert.match(paperBlock, /'matha-papers'[\s\S]*false[\s\S]*image\/png/);
  assert.match(paperBlock, /create policy "approved read matha papers"[\s\S]*for select[\s\S]*to authenticated[\s\S]*bucket_id = 'matha-papers'[\s\S]*is_matha_user\(auth\.uid\(\)\)/i);
  assert.doesNotMatch(paperBlock, /create policy[^;]+(?:insert|update|delete)[^;]+matha-papers/is);
});

test('本機 IndexedDB 同時保存狀態與未上傳原始筆跡', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /indexedDB\.open\('mathA13Content', 4\)/);
  assert.match(source, /createObjectStore\('state'\)/);
  assert.match(source, /`current:\$\{KEY\}`/);
  assert.match(source, /createObjectStore\('inkrecords'/);
  assert.match(source, /inkRecordPut\(\{[\s\S]*uploaded: false/);
  assert.match(source, /upsert\(row, \{ onConflict: 'user_id,client_id' \}\)/);
});

test('同一瀏覽器切換帳號時，作答狀態使用不同命名空間且可各自取回', async () => {
  const { context, run } = require('./helpers/load-app').loadApp();
  context.localStorage.setItem('mathA13', JSON.stringify({
    attempts: [{ qid: 'legacy-a', ts: 1 }], wrong: {}, paperRuns: [], ver: 3,
  }));
  run(`
    KEY = LEGACY_KEY;
    S = load(LEGACY_KEY);
    stateWrite = async () => {};
    stateInit = async () => {};
    refreshInkLocalStatus = async () => ({ total:0, pending:0 });
    applyExtBank = () => {};
  `);
  context.__a = { id: 'account-a' };
  context.__b = { id: 'account-b' };
  run('syncState.user = __a');
  await run('activateUserState(__a)');
  assert.deepEqual(require('./helpers/load-app').plain(run('S.attempts.map((x) => x.qid)')), ['legacy-a']);

  run("S.attempts.push({ qid:'only-a', ts:2 })");
  run('syncState.user = __b');
  await run('activateUserState(__b)');
  assert.deepEqual(require('./helpers/load-app').plain(run('S.attempts')), []);
  run("S.attempts.push({ qid:'only-b', ts:3 })");

  run('syncState.user = __a');
  await run('activateUserState(__a)');
  assert.deepEqual(require('./helpers/load-app').plain(run('S.attempts.map((x) => x.qid)')), ['legacy-a', 'only-a']);
  assert.notEqual(run("userStateKey('account-a')"), run("userStateKey('account-b')"));
});

test('未上傳筆跡只會被所屬帳號看見，舊筆跡只由第一次認領帳號接收', () => {
  const { context, run } = require('./helpers/load-app').loadApp();
  context.localStorage.setItem('mathA13_legacy_owner_v1', 'account-a');
  context.__rows = [
    { client_id: 'a', user_id: 'account-a' },
    { client_id: 'b', user_id: 'account-b' },
    { client_id: 'legacy', user_id: null },
  ];
  context.__a = { id: 'account-a' };
  context.__b = { id: 'account-b' };
  run('syncState.user = __a');
  assert.deepEqual(require('./helpers/load-app').plain(run('__rows.filter(inkRecordVisibleToCurrentUser).map((x) => x.client_id)')), ['a', 'legacy']);
  run('syncState.user = __b');
  assert.deepEqual(require('./helpers/load-app').plain(run('__rows.filter(inkRecordVisibleToCurrentUser).map((x) => x.client_id)')), ['b']);
  run('syncState.user = null');
  assert.deepEqual(require('./helpers/load-app').plain(run('__rows.filter(inkRecordVisibleToCurrentUser)')), []);
});

test('一次性配對 Edge Function 只為已登入使用者產生 magic link hash', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'device-pair', 'index.ts'), 'utf8');
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /auth\.admin\.generateLink\(\{/);
  assert.match(source, /type: "magiclink"/);
  assert.match(source, /hashed_token/);
  assert.doesNotMatch(source, /refresh_token|access_token|password:/);
});

test('整卷 AI schema 強制回傳可獨立核分的 finalAnswer', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'index.ts'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'lib.ts'), 'utf8');
  const schemaStart = source.indexOf('paper_grade: {', source.indexOf('const responseSchemas'));
  const block = source.slice(schemaStart, source.indexOf('paper_detail: {', schemaStart));
  assert.match(block, /finalAnswer:\s*\{\s*type:\s*"string"/);
  assert.match(block, /"finalAnswer"/);
});

test('AI 代理固定 GPT-5.5，並以後端原子額度阻止連點與超額', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'index.ts'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'lib.ts'), 'utf8');
  assert.match(source, /const model = "gpt-5\.5"/);
  assert.doesNotMatch(source, /fallback|gpt-5\.[0-46-9]|gpt-4/i);
  assert.match(source, /paper_grade:\s*12/);
  assert.match(source, /claimAiBudget\(userId, responseType\)/);
  assert.match(source, /status,\s*429|reply\(origin,\s*429/);
  assert.match(schema, /create table if not exists public\.ai_daily_usage/i);
  assert.match(schema, /create or replace function public\.claim_ai_request/i);
  assert.match(schema, /request_weight \+ safe_weight > 120/i);
  assert.match(schema, /last_request_at > now\(\) - interval '4 seconds'/i);
});

test('第二次詳批由後端驗證隔日與至少一次重想，不只信任前端按鈕', () => {
  const proxy = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'index.ts'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'lib.ts'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(proxy, /verifyPaperDetailGate\(userId, body\.context\)/);
  assert.match(proxy, /paperDetailGateAllows\(data, runId, questionNo, taipeiDate\(\)\)/, '隔日判定必須以台北時區為準（改成 UTC 會讓解鎖時刻偏移最多 8 小時）');
  assert.match(proxy, /String\(run\.due \|\| ""\) > today/);
  assert.match(proxy, /Number\(state\.attempts\) > 0 \|\| logs\.length > 0/);
  assert.match(app, /context:\s*\{[\s\S]*paperRunId:[\s\S]*questionNo: no/);
  assert.match(app, /await syncPush\(\);[\s\S]*paperAiDetailCall/);
});
