'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanText, normalizeQuestion, sanitizeBank, validateQuestion } = require('../scripts/build-private-bank');

function q(id, text, extra) {
  return { id, topic: 'num', type: 'fill', diff: 1, q: text, ans: ['1'], sol: '解法', src: '測試', ...(extra || {}) };
}

test('私有題庫清理會移除 emoji，但保留數學符號與圈號步驟', () => {
  assert.equal(cleanText('⚡ ① x²＋√2'), '① x²＋√2');
});

test('私有題庫拒絕缺圖、超範圍與危險內容，並去除完全重複', () => {
  const source = [
    q('ok-1', '求 \\(x=1\\)'),
    q('same-2', '求 \\(x=1\\)'),
    q('fig-3', '依圖作答', { needsFigure: true }),
    q('range-4', '求 \\cot x'),
    q('bad-5', '<script>alert(1)</script>'),
  ];
  const result = sanitizeBank(source, []);
  assert.deepEqual(result.items.map((row) => row.id), ['ok-1']);
  assert.equal(result.report.skipped.duplicateLegacy, 1);
  assert.equal(result.report.skipped.missingFigure, 1);
  assert.equal(result.report.skipped.outOfRange, 1);
  assert.equal(result.report.skipped.suspiciousHtml, 1);
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
