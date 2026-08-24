'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanText, normalizeQuestion, questionSignature, sanitizeBank, validateQuestion, verifiedFigureAsset, questionMissingVisualAsset, enrichQuestionMetadata, buildPrivateBank } = require('../scripts/build-private-bank');

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
  assert.equal(manifest.sourceSha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
  assert.match(manifest.packs[0].file, new RegExp(`${manifest.packs[0].sha256.slice(0, 10)}\\.json$`));
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
