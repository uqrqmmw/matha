'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePaperDetailGold, validateGold } = require('../scripts/evaluate-paper-detail-gold');

function syntheticGold() {
  const cases = [3, 4, 11, 12, 13, 14, 16].map((no) => ({
    no,
    officialAnswer: '(1)',
    expectedMode: [4, 16].includes(no) ? 'abstain' : 'diagnose',
    firstErrorEvidenceAliases: [4, 16].includes(no) ? [] : [`錯式${no}`],
    goodWorkEvidenceAliases: no === 11 ? ['正確前綴'] : [],
    studentEvidence: { file: 'student.png', sha256: 'X' },
    solutionEvidence: [{ file: 'solution.png', sha256: 'Y' }],
  }));
  return { schema: 1, id: 'synthetic-detail', assetRoot: '.', releaseAuthority: true, cases };
}

test('詳批 evaluator 分開計算 precision、coverage 與無證據亂猜', () => {
  const gold = syntheticGold();
  const prediction = { cases: gold.cases.map((row) => row.no === 4
    ? { no: row.no, confidence: 'high', firstErrorEvidence: '模型亂猜', firstError: '不存在的錯誤', goodWork: [] }
    : row.expectedMode === 'abstain'
      ? { no: row.no, confidence: 'low', firstErrorEvidence: null, firstError: null, goodWork: [] }
      : { no: row.no, confidence: 'high', firstErrorEvidence: `錯式${row.no}`, firstError: '此步不成立', goodWork: row.no === 11 ? ['正確前綴'] : [] }) };
  const result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.metrics.coverage.rate, 1);
  assert.equal(result.metrics.precision.rate, 5 / 6);
  assert.equal(result.metrics.unsupportedDiagnoses, 1);
  assert.equal(result.gates.precisionAtLeast90, false);
  assert.equal(result.gates.unsupportedDiagnosisZero, false);
  assert.equal(result.safeToShip, false);
});

test('私人第一回詳批 gold 存在時必須綁定 7 題像素與來源雜湊', { skip: !process.env.MATHA_PRIVATE_PAPER_DETAIL_GOLD }, () => {
  const fs = require('node:fs');
  const gold = JSON.parse(fs.readFileSync(process.env.MATHA_PRIVATE_PAPER_DETAIL_GOLD, 'utf8'));
  assert.equal(validateGold(gold, { verifySources: true }), true);
  assert.equal(gold.releaseAuthority, false, '尚未真人逐題簽核前必須 fail closed');
});
