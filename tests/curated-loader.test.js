'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { loadApp } = require('./helpers/load-app');

const TRUSTED_MANIFEST_FIELDS = {
  schema: 3,
  visibility: 'authenticated',
  corpusGeneration: 'mistral-ocr4-verified-v1',
  sourceInventorySha256: 'c0cedf6b71917211fce887f002978b1180ee661e86f16885e1625c34e5f9fc96',
  sourceDocuments: 25,
  sourcePages: 6720,
  ocrProvider: 'mistral',
  ocrModel: 'mistral-ocr-latest',
  verificationPolicy: 'pdf-crop-and-answer-review-v1',
  mathematicalCorrectnessVerified: true,
  releaseReady: true,
  releaseChecks: { corpusGeneration:true, sourceInventory:true, sourceDocuments:true, sourcePages:true,
    ocrProvider:true, ocrModel:true, verificationPolicy:true, originalPdfVerified:true,
    answerKeyVerified:true, mathematicalCorrectnessVerified:true, questionProvenance:true,
    reviewAudit:true, trustedHumanReview:true },
  releaseApprovedBy: 'yen-release-review',
};
function trustedManifest(fields) {
  return JSON.stringify({ ...TRUSTED_MANIFEST_FIELDS, generatedAt: '2026-08-26T00:00:00Z', packs: [], ...(fields || {}) });
}

test('大量私有題包採有上限的並行驗證，避免首次登入逐包串行卡住', async () => {
  const { context, run } = loadApp();
  context.__active = 0;
  context.__maxActive = 0;
  context.__worker = async (value) => {
    context.__active++;
    context.__maxActive = Math.max(context.__maxActive, context.__active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    context.__active--;
    return value * 2;
  };
  const output = await run('curatedConcurrentMap(Array.from({ length:12 }, (_, index) => index + 1), __worker, 3)');
  assert.deepEqual(Array.from(output), Array.from({ length:12 }, (_, index) => (index + 1) * 2));
  assert.equal(context.__maxActive, 3);
  assert.equal(run('CURATED_DOWNLOAD_CONCURRENCY'), 8);
});

test('首次私有題庫仍在驗證時不拿內建題冒充教材精選', () => {
  const { context, run } = loadApp();
  context.__alert = '';
  run(`
    syncGate = () => true;
    alert = (message) => { globalThis.__alert = String(message); };
    CONTENT.packs = {};
    curatedState = { status:'loading', count:0, loadedPackCount:125, packCount:933 };
    startAdaptiveTextbook(10);
  `);
  assert.match(context.__alert, /125\/933/);
  assert.match(context.__alert, /不會先塞內建補位題/);
  assert.equal(run('prac'), null);
});

test('私有 manifest 以短效簽署網址且禁用 HTTP 快取下載', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const manifest = trustedManifest();
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
    download: async (name) => { if (name === 'manifest-mistral-ocr4-verified-v1.json') directManifestDownloads++; return { data: null, error: new Error('unexpected direct download') }; },
  }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');

  assert.equal(await run('pullCuratedContent()'), true);
  assert.equal(directManifestDownloads, 0);
  assert.match(fetchedUrl, new RegExp(`manifest-mistral-ocr4-verified-v1\\.json\\?token=test-60&matha_cb=${run('APP_VER')}-`));
  assert.equal(fetchOptions.cache, 'no-store');
});

test('登入後私有題包會驗 SHA-256、寫入內容快取並加入題庫', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const pack = `${JSON.stringify({ kind: 'qpack', name: '私有測試包', items: [{ id: 'curated-test-1', topic: 'num', type: 'fill', diff: 1, q: '測試題', ans: ['1'], sol: '解法', src: '私有測試包' }] })}\n`;
  const digest = crypto.createHash('sha256').update(pack).digest('hex');
  const manifest = trustedManifest({ packs: [{ id: 'curated-test', name: '私有測試包', file: 'test.json', count: 1, sha256: digest }] });
  context.__files = { 'manifest-mistral-ocr4-verified-v1.json': new Blob([manifest]), 'test.json': new Blob([pack]) };
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
  const manifest = trustedManifest({ packs: [{ id: 'curated-bad', name: '壞包', file: 'bad.json', count: 0, sha256: '0'.repeat(64) }] });
  context.__files = { 'manifest-mistral-ocr4-verified-v1.json': new Blob([manifest]), 'bad.json': new Blob([pack]) };
  context.__storage = { from() { return { download: async (name) => ({ data: context.__files[name], error: null }) }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');
  const ok = await run('pullCuratedContent()');
  assert.equal(ok, false);
  assert.equal(run('Object.hasOwn(CONTENT.packs, "curated-bad")'), false);
  assert.match(run('curatedState.error'), /完整性驗證失敗/);
});

test('舊 OCR manifest 即使可下載也因題庫世代不符而拒收', async () => {
  const { context, run } = loadApp();
  context.crypto = crypto.webcrypto;
  context.TextDecoder = TextDecoder;
  const legacy = JSON.stringify({ schema: 2, visibility: 'authenticated', generatedAt: '2026-08-25T00:00:00Z', packs: [] });
  context.__files = { 'manifest-mistral-ocr4-verified-v1.json': new Blob([legacy]) };
  context.__storage = { from() { return { download: async (name) => ({ data: context.__files[name], error: null }) }; } };
  run('supa = { storage: __storage }; syncState.user = { id: "test-user" }; syncPill = () => {}; rerenderActiveView = () => {}; updateBadge = () => {}');

  assert.equal(await run('pullCuratedContent()'), false);
  assert.equal(run('curatedState.status'), 'quarantined');
  assert.match(run('curatedState.error'), /manifest 格式|題庫世代/);
});

test('擁有者委託代理審核的 manifest 只接受透明且 hash-bound 的授權鏈', () => {
  const { run } = loadApp();
  const delegatedReviewSha256 = 'a'.repeat(64);
  const manifest = JSON.parse(trustedManifest({
    reviewPolicy:'owner-delegated-agent-direct-pixel-v1',
    releaseChecks:{ ...TRUSTED_MANIFEST_FIELDS.releaseChecks, releaseAuthorization:true },
    releaseApprovedBy:'uqrqmmw',
    releaseApproval:{
      kind:'owner-delegated-agent-starter-private-release-signoff', version:1,
      authorizedBy:'uqrqmmw', performedBy:'Codex direct-pixel audit',
      humanPixelReviewClaimed:false, delegatedReviewSha256,
      sampleQuestionIds:['q-1'],
    },
  }));
  run('globalThis.__delegatedManifest = ' + JSON.stringify(manifest));
  assert.equal(run('curatedManifestError(globalThis.__delegatedManifest)'), '');
  run('globalThis.__delegatedManifest.releaseApproval.humanPixelReviewClaimed = true');
  assert.match(run('curatedManifestError(globalThis.__delegatedManifest)'), /授權|稽核/);

  const secondHash = 'b'.repeat(64);
  const combined = JSON.parse(trustedManifest({
    reviewPolicy:'owner-delegated-agent-direct-pixel-v1',
    releaseChecks:{ ...TRUSTED_MANIFEST_FIELDS.releaseChecks, releaseAuthorization:true },
    releaseApprovedBy:'uqrqmmw',
    releaseApproval:{
      kind:'owner-delegated-agent-starter-private-release-signoff', version:2,
      authorizedBy:'uqrqmmw', performedBy:'Codex direct-pixel audit',
      humanPixelReviewClaimed:false,
      delegatedReviewSha256:[delegatedReviewSha256, secondHash],
      sampleQuestionIds:['q-1','q-2'],
    },
  }));
  run('globalThis.__combinedDelegatedManifest = ' + JSON.stringify(combined));
  assert.equal(run('curatedManifestError(globalThis.__combinedDelegatedManifest)'), '');
  run('globalThis.__combinedDelegatedManifest.releaseApproval.delegatedReviewSha256.reverse()');
  assert.equal(run('curatedManifestError(globalThis.__combinedDelegatedManifest)'), '',
    '客戶端只驗授權 envelope；逐批順序由建置端 reviewAudit 鎖定');
});

test('隔離舊官方快取時保留使用者自建題包', async () => {
  const { run } = loadApp();
  const result = await run(`(async () => {
    localStorage.setItem(SPLIT_LS, '1');
    CONTENT.packs = {
      'curated-old': { kind:'qpack', curated:true, items:[{ id:'old-ocr' }] },
      'user-pack': { kind:'qpack', name:'我的題包', items:[{ id:'mine', topic:'num', type:'fill', diff:1, q:'我的題目', ans:['1'] }] },
    };
    const removed = await quarantineStaleCuratedContent();
    return { removed, keys:Object.keys(CONTENT.packs), userItems:CONTENT.packs['user-pack'].items.length, ext:extBankArr().map((q) => q.id) };
  })()`);
  assert.equal(result.removed.removedPacks, 1);
  assert.equal(result.removed.removedQuestions, 1);
  assert.deepEqual([...result.keys], ['user-pack']);
  assert.equal(result.userItems, 1);
  assert.deepEqual([...result.ext], ['mine']);
});
