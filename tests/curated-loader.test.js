'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { loadApp } = require('./helpers/load-app');

test('私有 manifest 以短效簽署網址且禁用 HTTP 快取下載', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const manifest = JSON.stringify({ schema: 1, visibility: 'authenticated', generatedAt: '2026-08-25T00:00:00Z', packs: [] });
  let fetchedUrl = '';
  let fetchOptions = null;
  context.fetch = async (url, options) => {
    fetchedUrl = String(url);
    fetchOptions = options;
    return { ok: true, blob: async () => new Blob([manifest]) };
  };
  let directManifestDownloads = 0;
  context.__storage = { from() { return {
    createSignedUrl: async (name, seconds) => ({ data: { signedUrl: `https://example.supabase.co/storage/${name}?token=test-${seconds}` }, error: null }),
    download: async (name) => { if (name === 'manifest-0825e.json') directManifestDownloads++; return { data: null, error: new Error('unexpected direct download') }; },
  }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');

  assert.equal(await run('pullCuratedContent()'), true);
  assert.equal(directManifestDownloads, 0);
  assert.match(fetchedUrl, /manifest-0825e\.json\?token=test-60&matha_cb=0825f-/);
  assert.equal(fetchOptions.cache, 'no-store');
});

test('登入後私有題包會驗 SHA-256、寫入內容快取並加入題庫', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const pack = `${JSON.stringify({ kind: 'qpack', name: '私有測試包', items: [{ id: 'curated-test-1', topic: 'num', type: 'fill', diff: 1, q: '測試題', ans: ['1'], sol: '解法', src: '私有測試包' }] })}\n`;
  const digest = crypto.createHash('sha256').update(pack).digest('hex');
  const manifest = JSON.stringify({ schema: 1, visibility: 'authenticated', generatedAt: '2026-07-16T00:00:00Z', packs: [{ id: 'curated-test', name: '私有測試包', file: 'test.json', count: 1, sha256: digest }] });
  context.__files = { 'manifest-0825e.json': new Blob([manifest]), 'test.json': new Blob([pack]) };
  context.__downloads = [];
  context.__storage = { from() { return { download: async (name) => { context.__downloads.push(name); return { data: context.__files[name], error: null }; } }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');
  const ok = await run('pullCuratedContent()');
  assert.equal(ok, true);
  assert.equal(run('BANK.some((q) => q.id === "curated-test-1")'), true);
  assert.equal(run('CONTENT.packs["curated-test"].curated'), true);
  assert.equal(run('Object.prototype.toString.call(CONTENT.packs["curated-test"].verifiedBytes)'), '[object ArrayBuffer]');
  assert.equal(run('curatedState.count'), 1);

  // 本機 items/metadata 可被備份或 DevTools 改寫；第二次載入必須由已驗 SHA 的原 envelope
  // 重新解析，而不是只看 curated:true + sha256 就替偽造題加入 WeakSet。
  run(`CONTENT.packs['curated-test'].items = [{
    id:'forged-visual', topic:'line', type:'fill', diff:2, q:'依下圖作答', ans:['1'],
    bookId:'matha-114-cramer-circle', page:37,
    visualEvidence:{ status:'verified-text-complete', questionId:'forged-visual', bookId:'matha-114-cramer-circle',
      sourcePdfSha256:'92acde764f180e8974f14aef8a916ecb74e904284814f4e2bd0bc74e726fea1c', pageIndex:37,
      reviewVersion:1, reviewer:'independent-visual-audit', verifiedAt:'2026-08-25T00:00:00Z' }
  }]`);
  const second = await run('pullCuratedContent()');
  assert.equal(second, true);
  assert.equal(run('BANK.some((q) => q.id === "forged-visual")'), false);
  assert.equal(run('BANK.some((q) => q.id === "curated-test-1")'), true);
  assert.equal(context.__downloads.filter((name) => name === 'test.json').length, 1);
});

test('私有題包雜湊不符時拒絕加入，不污染既有題庫', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const pack = `${JSON.stringify({ kind: 'qpack', name: '壞包', items: [] })}\n`;
  const manifest = JSON.stringify({ schema: 1, visibility: 'authenticated', generatedAt: '2026-07-16T00:00:00Z', packs: [{ id: 'curated-bad', name: '壞包', file: 'bad.json', count: 0, sha256: '0'.repeat(64) }] });
  context.__files = { 'manifest-0825e.json': new Blob([manifest]), 'bad.json': new Blob([pack]) };
  context.__storage = { from() { return { download: async (name) => ({ data: context.__files[name], error: null }) }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');
  const ok = await run('pullCuratedContent()');
  assert.equal(ok, false);
  assert.equal(run('Object.hasOwn(CONTENT.packs, "curated-bad")'), false);
  assert.match(run('curatedState.error'), /完整性驗證失敗/);
});
