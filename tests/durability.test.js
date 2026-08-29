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
  assert.match(schema, /index if not exists ink_sessions_user_qid_updated[\s\S]*\(user_id, qid, updated_at desc\)/i);
});

test('原版模考 bucket 保持私有且只有核准帳號能讀取', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const paperBlock = schema.slice(schema.indexOf("'matha-papers'"));
  assert.match(paperBlock, /'matha-papers'[\s\S]*false[\s\S]*image\/png/);
  assert.match(paperBlock, /create policy "approved read matha papers"[\s\S]*for select[\s\S]*to authenticated[\s\S]*bucket_id = 'matha-papers'[\s\S]*is_matha_user\(auth\.uid\(\)\)/i);
  assert.doesNotMatch(paperBlock, /create policy[^;]+(?:insert|update|delete)[^;]+matha-papers/is);
});

test('教材題圖 bucket 保持私有唯讀，學生端不能上傳或改寫裁圖', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const figureBlock = schema.slice(schema.indexOf("'matha-figures'"), schema.indexOf("'matha-papers'"));
  assert.match(figureBlock, /'matha-figures'[\s\S]*false[\s\S]*image\/webp/);
  assert.match(figureBlock, /create policy "approved read matha figures"[\s\S]*for select[\s\S]*to authenticated[\s\S]*bucket_id = 'matha-figures'[\s\S]*is_matha_user\(auth\.uid\(\)\)/i);
  assert.doesNotMatch(figureBlock, /create policy[^;]+(?:insert|update|delete)[^;]+matha-figures/is);
});

test('本機 IndexedDB 同時保存狀態與未上傳原始筆跡', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /indexedDB\.open\('mathA13Content', 6\)/);
  assert.match(source, /createObjectStore\('state'\)/);
  assert.match(source, /createObjectStore\('figurecache', \{ keyPath: 'key' \}\)/);
  assert.match(source, /figureCacheGet\(asset\.sha256, userId\)/);
  assert.match(source, /figureCachePut\(asset\.sha256, blob, userId\)/);
  assert.match(source, /privateFigureGeneration === generation/);
  assert.match(source, /figureCacheClearUser\(was\)/);
  assert.match(source, /`current:\$\{KEY\}`/);
  assert.match(source, /createObjectStore\('inkrecords'/);
  assert.match(source, /createIndex\('qid', 'qid'/);
  assert.match(source, /createIndex\('upload_state', 'upload_state'/);
  assert.match(source, /createIndex\('user_id', 'user_id'/);
  assert.match(source, /inkRecordPut\(\{[\s\S]*uploaded: false/);
  assert.match(source, /upsert\(rows, \{ onConflict: 'user_id,client_id' \}\)/);
  assert.match(source, /Number\(current\.updatedAt \|\| 0\) > Number\(sentUpdatedAt \|\| 0\)/);
});

test('開考前診斷實測本機、私有原卷與未交卷答案閘門，且答案測試不呼叫模型', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(source, /systemReadinessIdbRoundTrip\(\)/);
  assert.match(source, /createSignedUrl\(file, 60\)/);
  assert.match(source, /Range:'bytes=0-63'/);
  assert.match(source, /responseType:'paper_key'[\s\S]*paperRunId:`readiness-/);
  assert.match(source, /response\.status === 403[\s\S]*不呼叫 GPT/);
  assert.doesNotMatch(source.slice(source.indexOf('async function systemReadinessAnswerGate'), source.indexOf('async function runSystemReadiness')), /openAiInvoke|aiJSON|paperAiGradeCall/);
  assert.match(worker, /e\.ports && e\.ports\[0\][\s\S]*MATHA_APP_VERSION/);
});

test('新開原版模考必須先通過當版安全檢查，但既有考卷仍可直接救援續寫', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = source.slice(source.indexOf('async function startPaperSource'), source.indexOf('function paperSourceRender'));
  assert.match(start, /let run = paperActiveRun\(sourceId\);[\s\S]*if \(!run && !systemReadinessSummary\(S\.systemReadiness\)\.ready\)/);
  assert.match(start, /await runSystemReadiness\(\);[\s\S]*nav\('stats'\)[\s\S]*return;/);
  assert.match(start, /paperSourceRelease\(\);[\s\S]*if \(!run\) \{/);
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
  assert.match(source, /"\/auth\/v1\/user"/);
  assert.match(source, /\/rest\/v1\/app_users\?select=enabled/);
  assert.match(source, /"\/auth\/v1\/admin\/generate_link"/);
  assert.match(source, /type: "magiclink"/);
  assert.match(source, /redirect_to: APP_REDIRECT_URL/);
  assert.match(source, /hashed_token/);
  assert.match(source, /Bearer \$\{SUPABASE_SERVICE_ROLE_KEY\}/);
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

test('下一份未作答模考的正式答案不進公開前端，只能由交卷後端閘門解鎖', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'full-paper-inventory.json'), 'utf8'));
  const proxy = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'index.ts'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'lib.ts'), 'utf8');
  const thirdStart = app.indexOf("id: 'paper-mock-3'");
  const thirdEnd = app.indexOf('const PAPER_ERROR_KINDS', thirdStart);
  const third = app.slice(thirdStart, thirdEnd);
  assert.match(third, /answerAccess:\s*'post-submit-server'/);
  assert.doesNotMatch(third, /\bkey:\s*\[/);
  assert.match(app, /await syncPush\(\);[\s\S]*paperAnswerKeyAfterSubmit\(source, run\)/);
  assert.match(proxy, /Deno\.env\.get\("PAPER_ANSWER_KEYS_JSON"\)/);
  assert.match(proxy, /paperKeyGateAllows\(data, runId, sourceId\)/);
  assert.match(proxy, /String\(run\.status \|\| ""\) === "grading"/);
  const thirdInventory = inventory.papers.find((paper) => paper.id === 'paper-mock-3');
  assert.deepEqual(thirdInventory.activationBlockers, ['freshness-confirmation', 'galaxy-tab-preflight']);
  assert.doesNotMatch(inventory.nextP0, /PAPER_SOURCES\.key|public client/i);
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

test('逐題詳解由後端驗證已到隔日且題目屬於該次訂正，不只信任前端按鈕', () => {
  const proxy = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'index.ts'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'openai-proxy', 'lib.ts'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(proxy, /verifyPaperDetailGate\(userId, body\.context\)/);
  assert.match(proxy, /paperDetailGateAllows\(data, runId, questionNo, taipeiDate\(\)\)/, '隔日判定必須以台北時區為準（改成 UTC 會讓解鎖時刻偏移最多 8 小時）');
  assert.match(proxy, /String\(run\.due \|\| ""\) > today/);
  assert.match(proxy, /const state = review\[String\(questionNo\)\]/);
  assert.match(proxy, /attempts >= 1 && hasRetryLog/);
  assert.match(proxy, /String\(\(log as Record<string, unknown>\)\.kind \|\| ""\) === "retry"/);
  assert.match(app, /context:\s*\{[\s\S]*paperRunId:[\s\S]*questionNo: no/);
  const detailed = app.match(/async function paperReviewDetailed[\s\S]*?\n\}/)?.[0] || '';
  const compat = app.match(/async function paperReviewDetailCallCompat[\s\S]*?\n\}/)?.[0] || '';
  assert.match(detailed, /await syncPush\(\);[\s\S]*paperReviewDetailCallCompat/,
    '詳解前必須先同步，再由相容層送出已保存的真實 retry log');
  assert.match(compat, /paperAiDetailCall\([\s\S]*paperReviewDetailLogs\(state\)/,
    '相容層仍須呼叫後端詳解 API，且只能傳入過濾後的真實紀錄');
  assert.doesNotMatch(compat, /detail-gate\s*['"]\s*\}|push\(/,
    '不得在相容層製造空白紀錄繞過後端隔日訂正閘門');
});
