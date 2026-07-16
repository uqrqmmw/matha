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

test('本機 IndexedDB 同時保存狀態與未上傳原始筆跡', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /indexedDB\.open\('mathA13Content', 4\)/);
  assert.match(source, /createObjectStore\('state'\)/);
  assert.match(source, /createObjectStore\('inkrecords'/);
  assert.match(source, /inkRecordPut\(\{[\s\S]*uploaded: false/);
  assert.match(source, /upsert\(row, \{ onConflict: 'user_id,client_id' \}\)/);
});

test('一次性配對 Edge Function 只為已登入使用者產生 magic link hash', () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'device-pair', 'index.ts'), 'utf8');
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /auth\.admin\.generateLink\(\{/);
  assert.match(source, /type: "magiclink"/);
  assert.match(source, /hashed_token/);
  assert.doesNotMatch(source, /refresh_token|access_token|password:/);
});
