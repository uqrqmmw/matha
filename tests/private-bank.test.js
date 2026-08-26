'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanText, canonicalTopic, normalizeQuestion, questionSignature, sanitizeBank, validateQuestion, verifiedFigureAsset, questionMissingVisualAsset, enrichQuestionMetadata, untrustedReviewSource, buildPrivateBank } = require('../scripts/build-private-bank');

function q(id, text, extra) {
  return { id, topic: 'num', type: 'fill', diff: 1, q: text, ans: ['1'], sol: '解法', src: '測試', ...(extra || {}) };
}

test('私有題庫清理會移除 emoji，但保留數學符號與圈號步驟', () => {
  assert.equal(cleanText('⚡ ① x²＋√2'), '① x²＋√2');
});

test('私有題包檔名包含內容雜湊，更新內容不會被同名 Storage 快取攔住', (t) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-content-address-'));
  t.after(() => fs.rmSync(temp, { recursive:true, force:true }));
  const source = path.join(temp, 'source.json');
  const output = path.join(temp, 'out');
  fs.writeFileSync(source, JSON.stringify([q('content-address-1', '測試內容位碼 91827364')]), 'utf8');
  const manifest = buildPrivateBank(source, output, root);
  assert.equal(manifest.packs.length, 1);
  assert.equal(manifest.releaseReady, false, '一般或舊來源只能產生製作檔，不能直接成為正式發版 manifest');
  assert.equal(manifest.sourceSha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
  assert.match(manifest.packs[0].file, new RegExp(`${manifest.packs[0].sha256.slice(0, 10)}\\.json$`));
});

test('只有新版來源清冊與三項人工校驗都齊全時才產生可發布 manifest', (t) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-release-contract-'));
  t.after(() => fs.rmSync(temp, { recursive:true, force:true }));
  const source = path.join(temp, 'source.json');
  const output = path.join(temp, 'out');
  fs.writeFileSync(source, JSON.stringify({
    schema: 3,
    kind: 'private-question-source',
    corpusGeneration: 'mistral-ocr4-verified-v1',
    sourceInventorySha256: 'c0cedf6b71917211fce887f002978b1180ee661e86f16885e1625c34e5f9fc96',
    sourceDocuments: 25,
    sourcePages: 6720,
    ocrProvider: 'mistral',
    ocrModel: 'mistral-ocr-latest',
    verificationPolicy: 'pdf-crop-and-answer-review-v1',
    originalPdfVerified: true,
    answerKeyVerified: true,
    mathematicalCorrectnessVerified: true,
    reviewedBy: 'yen-manual-review',
    releaseApprovedBy: 'yen-release-review',
    reviewAudit: { sourceQuestionCount:1, approvedQuestionCount:1, completedAt:'2026-08-26T12:00:00+08:00' },
    questions: [q('release-contract-1', '已對照原卷與答案的測試題', {
      bookId:'matha-114-real-number-line', page:12, src:'matha-114-real-number-line p12',
    })],
  }), 'utf8');

  const manifest = buildPrivateBank(source, output, root);
  assert.equal(manifest.releaseReady, true);
  assert.equal(manifest.schema, 3);
  assert.equal(manifest.corpusGeneration, 'mistral-ocr4-verified-v1');
  assert.equal(Object.values(manifest.releaseChecks).every(Boolean), true);
});

test('掃描教材 apply-review envelope 的 questions 會被正式建置器接住', (t) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-review-envelope-'));
  t.after(() => fs.rmSync(temp, { recursive:true, force:true }));
  const source = path.join(temp, 'reviewed-qpack.json');
  const output = path.join(temp, 'out');
  fs.writeFileSync(source, JSON.stringify({
    schema: 1,
    kind: 'private-question-source',
    bookId: 'matha-114-line-inequality',
    pdfSha256: 'b'.repeat(64),
    reviewedBy: 'unit-test',
    questions: [
      {
        id: 'line-inequality-p067-q3',
        topic: 'line',
        type: 'single',
        diff: 1,
        q: '點 P(3,4) 到直線 L: 12x - 5y + 10 = 0 的距離為多少？',
        opts: ['1', '26/17', '20/13', '2', '26/7'],
        ans: [3],
        src: 'matha-114-line-inequality p67',
      },
    ],
  }), 'utf8');
  const manifest = buildPrivateBank(source, output, root);
  assert.equal(manifest.report.sourceTotal, 1);
  assert.equal(manifest.report.accepted, 1);
  assert.equal(manifest.packs.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, manifest.packs[0].file), 'utf8')).items[0].id, 'line-inequality-p067-q3');
});

test('掃描教材草稿或 smoke 題包即使 schema 像正式題也不能進正式建置', (t) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-untrusted-review-'));
  t.after(() => fs.rmSync(temp, { recursive:true, force:true }));
  const source = path.join(temp, 'draft-qpack.json');
  const output = path.join(temp, 'out');
  const payload = {
    schema: 1,
    kind: 'private-question-source',
    bookId: 'matha-114-line-inequality',
    reviewedBy: 'pipeline-smoke-test-not-a-human-sign-off',
    questions: [
      {
        id: 'line-inequality-p009-ex9',
        topic: 'line', type: 'fill', diff: 1,
        q: '求通過點 (-3,1)，斜率為 2 的直線方程式。',
        ans: ['2x-y+7=0'],
        src: 'matha-114-line-inequality p9',
      },
    ],
  };
  assert.equal(untrustedReviewSource(payload), 'reviewer-not-human-signoff');
  fs.writeFileSync(source, JSON.stringify(payload), 'utf8');
  const manifest = buildPrivateBank(source, output, root);
  assert.equal(manifest.report.sourceTotal, 1);
  assert.equal(manifest.report.accepted, 0);
  assert.equal(manifest.report.skipped.untrustedReview, 1);
  assert.equal(manifest.report.trustBlockReason, 'reviewer-not-human-signoff');
  assert.deepEqual(manifest.packs, []);
});

test('帶 draftedBy 草稿痕跡的掃描教材題包必須先經 apply-review 簽核清洗', () => {
  assert.equal(untrustedReviewSource({
    schema: 1,
    kind: 'private-question-source',
    reviewedBy: 'unit-test',
    questions: [q('draft-marker-1', '草稿題', { draftedBy:'claude-draft' })],
  }), 'draft-markers-present');
});

test('私有題庫保留缺圖題為可追蹤佇列，並拒絕超範圍、危險與完全重複內容', () => {
  const source = [
    q('ok-1', '求 \\(x=1\\)'),
    q('same-2', '求 \\(x=1\\)'),
    q('fig-3', '依圖作答', { needsFigure: true }),
    q('fig-implicit', '如下圖所示，求陰影面積'),
    q('fig-waived', '如下圖所示，但文字條件已完整', { visualComplete:true }),
    q('range-4', '求 \\cot x'),
    q('bad-5', '<script>alert(1)</script>'),
  ];
  const result = sanitizeBank(source, []);
  assert.deepEqual(result.items.map((row) => row.id), ['ok-1']);
  assert.deepEqual(result.pendingVisuals.map((row) => row.id), ['fig-3', 'fig-implicit', 'fig-waived']);
  assert.equal(result.report.visual.pending, 3);
  assert.equal(result.report.skipped.duplicateLegacy, 1);
  assert.equal(result.report.skipped.missingFigure, 1);
  assert.equal(result.report.skipped.visualReferenceMissing, 2);
  assert.equal(result.report.skipped.outOfRange, 1);
  assert.equal(result.report.skipped.suspiciousHtml, 1);
});

test('圖形引用只有在附帶圖資或人工確認文字完整時才可出題', () => {
  const verified = {
    path:'books/matha/figures/d.webp', sha256:'a'.repeat(64), sourcePdfSha256:'b'.repeat(64),
    pageIndex:12, bbox:[.1,.2,.3,.4], role:'question-figure', assetStatus:'verified', mime:'image/webp', width:800, height:600,
    containsAnswer:false, containsSolution:false, containsHandwriting:false, questionIds:['e'], bookId:'matha-114-cubic-ineq',
    producer:'crop-agent', verifier:{ reviewer:'audit-agent', reviewVersion:1, questionRoleVerified:true, safetyVerified:true, assetHashVerified:true, verifiedAt:'2026-08-25T00:00:00Z' },
  };
  assert.equal(questionMissingVisualAsset(q('a', '如右圖，求 x')), true);
  assert.equal(questionMissingVisualAsset(q('b', '如右圖，求 x', { fig:'<svg></svg>' })), true);
  assert.equal(questionMissingVisualAsset(q('c', '如右圖，求 x', { visualComplete:true })), true);
  assert.equal(questionMissingVisualAsset(q('d', '如右圖，求 x', { figureAsset:'figures/d.png' })), true);
  for (const [index, text] of [
    '觀察右側的函數圖形', '參考右側座標圖形', '下方座標平面繪有曲線', '曲線如下', '座標平面如附',
  ].entries()) assert.equal(questionMissingVisualAsset(q(`phrase-${index}`, text)), true, text);
  const linked = q('e', '如右圖，求 x', { bookId:'matha-114-cubic-ineq', page:12, figureAsset:{ ...verified, sourcePdfSha256:'e87ad8f0e0b0d26c5bd934770686e10a168fd326a9486e90cac72ee57419b5c1' } });
  assert.equal(questionMissingVisualAsset(linked), false);
  assert.equal(verifiedFigureAsset(linked), linked.figureAsset);
  assert.equal(verifiedFigureAsset({ ...linked, figureAsset:{ ...linked.figureAsset, containsAnswer:true } }), null);
});

test('同一短問句但題幹或答案不同不得被當成重複題刪除', () => {
  const source = [
    q('context-a', '求 a 之值', { stem:'已知 a+1=2', ans:['1'] }),
    q('context-b', '求 a 之值', { stem:'已知 2a=6', ans:['3'] }),
    q('context-c', '求 a 之值', { stem:'已知 a+1=2', ans:['1'] }),
  ];
  const result = sanitizeBank(source, []);
  assert.deepEqual(result.items.map((row) => row.id), ['context-a', 'context-b']);
  assert.equal(result.report.skipped.duplicateLegacy, 1);
  assert.notEqual(result.items[0].canonicalProblemId, result.items[1].canonicalProblemId);
  assert.notEqual(questionSignature(source[0], false, true), questionSignature(source[1], false, true));
});

test('只改數字的題目會共用模板群組，避免同輪重複骨架', () => {
  const result = sanitizeBank([q('a-1', '計算 12+3'), q('a-2', '計算 18+7')], []);
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].grp, /^legacy-/);
  assert.equal(result.items[0].grp, result.items[1].grp);
});

test('題目 schema 驗證與正式 app 的必要欄位一致', () => {
  assert.equal(validateQuestion(q('valid-1', '題目')), null);
  assert.equal(validateQuestion({ ...q('bad id', '題目') }), 'id-invalid');
  assert.equal(validateQuestion({ ...q('valid-2', '題目'), topic: 'unknown' }), 'topic-invalid');
  assert.equal(normalizeQuestion(' 求 3x = 6 ', true), '求 #x = #');
});

test('舊製作工具的空間單元別名會在匯入邊界轉成 app 的正式 14 單元鍵', () => {
  assert.equal(canonicalTopic('vec3'), 'svec');
  assert.equal(canonicalTopic('space'), 'splane');
  const result = sanitizeBank([
    q('space-vector-alias', '求空間向量長度', { topic:'vec3' }),
    q('space-plane-alias', '求平面方程式', { topic:'space' }),
  ], []);
  assert.deepEqual(result.items.map((row) => row.topic), ['svec', 'splane']);
  assert.equal(result.report.skipped.schema, 0);
});

test('既有十本題號可安全補上書本、頁碼、例題角色與私有來源欄位', () => {
  const row = enrichQuestionMetadata(q('v-exp-log1-p003-ex1-a', '求 2 的冪', { src:'114班·指數與常用對數', diff:2, visibility:'public' }));
  assert.equal(row.bookId, 'matha-114-exp-log');
  assert.equal(row.bookTitle, '指數函數與常用對數');
  assert.equal(row.page, 3);
  assert.equal(row.role, 'example');
  assert.equal(row.sourceDifficulty, 2);
  assert.equal(row.estimatedMinutes, 4);
  assert.equal(row.visibility, 'private');
  assert.match(row.canonicalProblemId, /^problem-[a-f0-9]{20}$/);
});

test('教材角色只採印刷區段證據，不把 s/m/f/c 題型代碼猜成難度', () => {
  const advanced = enrichQuestionMetadata(q('v-line-p053-adv-s1', '進階題'));
  const foundation = enrichQuestionMetadata(q('v-line-p044-basic-calc1', '基礎題'));
  const unverified = enrichQuestionMetadata(q('v-line-p037-m1', '多選題'));
  assert.deepEqual(
    [advanced.role, advanced.sectionLevel, foundation.role, foundation.sectionLevel, unverified.role, unverified.sectionLevel],
    ['chapter-end-hard', 'advanced', 'chapter-end-easy', 'foundation', 'unclassified', 'unverified'],
  );
});

test('完整文字化表格只由建置期逐題白名單產生可信 evidence，不接受外部 boolean 自報', () => {
  const verified = enrichQuestionMetadata(q('v-exp-log1-p055-ex18', '根據附表作答', { src:'114班·指數與常用對數' }));
  const selfClaimed = enrichQuestionMetadata(q('not-reviewed-p055', '根據附表作答', { src:'114班·指數與常用對數', visualComplete:true }));
  assert.equal(verified.visualEvidence.status, 'verified-text-complete');
  assert.equal(verified.visualEvidence.questionId, verified.id);
  assert.equal(verified.visualEvidence.pageIndex, 55);
  assert.equal(questionMissingVisualAsset(verified), false);
  assert.equal(questionMissingVisualAsset(selfClaimed), true);
});

/* 掃描教材匯入管線（scripts/ingest/apply-review.py）產出的記錄必須被這裡接受，
   否則人工複核的時間會在最後一步才發現白花。這條測試釘住兩邊的契約。 */
test('掃描教材複核後產出的題目通過私有題庫驗證，且圖題仍被隔離到裁圖複核完成', () => {
  const reviewed = {
    id:'line-inequality-p067-q1',
    topic:'line', type:'single', diff:1,
    diffEvidence:'基礎實力養成（OCR：基實力成）',
    q:'在坐標平面上，根據方程式 x+5y-7=0，2x+y+4=0，x-y-1=0 畫出三條直線 L₁，L₂，L₃，如圖所示，試選出方程式與直線間的正確配置？',
    opts:[
      'L₁: x+5y-7=0，L₂: 2x+y+4=0，L₃: x-y-1=0',
      'L₁: x-y-1=0，L₂: x+5y-7=0，L₃: 2x+y+4=0',
      'L₁: 2x+y+4=0，L₂: x+5y-7=0，L₃: x-y-1=0',
      'L₁: x-y-1=0，L₂: 2x+y+4=0，L₃: x+5y-7=0',
      'L₁: 2x+y+4=0，L₂: x-y-1=0，L₃: x+5y-7=0',
    ],
    ans:[3],
    bookId:'matha-114-line-inequality', page:69, printedPage:67,
    role:'chapter-end-easy', src:'matha-114-line-inequality p67',
    needsFigure:true,
  };
  assert.equal(validateQuestion(enrichQuestionMetadata(reviewed)), null);
  assert.equal(questionMissingVisualAsset(reviewed), true);

  /* 沒有 figureAsset 就不准自稱已備圖：needsFigure 是隔離旗標，不是通行證。 */
  const pretending = { ...reviewed, needsFigure:false };
  assert.equal(questionMissingVisualAsset(pretending), true, '題幹提到「如圖」時仍須隔離');
});
