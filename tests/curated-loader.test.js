'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { loadApp } = require('./helpers/load-app');

test('登入後私有題包會驗 SHA-256、寫入內容快取並加入題庫', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const pack = `${JSON.stringify({ kind: 'qpack', name: '私有測試包', items: [{ id: 'curated-test-1', topic: 'num', type: 'fill', diff: 1, q: '測試題', ans: ['1'], sol: '解法', src: '私有測試包' }] })}\n`;
  const digest = crypto.createHash('sha256').update(pack).digest('hex');
  const manifest = JSON.stringify({ schema: 1, visibility: 'authenticated', generatedAt: '2026-07-16T00:00:00Z', packs: [{ id: 'curated-test', name: '私有測試包', file: 'test.json', count: 1, sha256: digest }] });
  context.__files = { 'manifest.json': new Blob([manifest]), 'test.json': new Blob([pack]) };
  context.__storage = { from() { return { download: async (name) => ({ data: context.__files[name], error: null }) }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');
  const ok = await run('pullCuratedContent()');
  assert.equal(ok, true);
  assert.equal(run('BANK.some((q) => q.id === "curated-test-1")'), true);
  assert.equal(run('CONTENT.packs["curated-test"].curated'), true);
  assert.equal(run('curatedState.count'), 1);
});

test('私有題包雜湊不符時拒絕加入，不污染既有題庫', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const pack = `${JSON.stringify({ kind: 'qpack', name: '壞包', items: [] })}\n`;
  const manifest = JSON.stringify({ schema: 1, visibility: 'authenticated', generatedAt: '2026-07-16T00:00:00Z', packs: [{ id: 'curated-bad', name: '壞包', file: 'bad.json', count: 0, sha256: '0'.repeat(64) }] });
  context.__files = { 'manifest.json': new Blob([manifest]), 'bad.json': new Blob([pack]) };
  context.__storage = { from() { return { download: async (name) => ({ data: context.__files[name], error: null }) }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');
  const ok = await run('pullCuratedContent()');
  assert.equal(ok, false);
  assert.equal(run('Object.hasOwn(CONTENT.packs, "curated-bad")'), false);
  assert.match(run('curatedState.error'), /完整性驗證失敗/);
});
