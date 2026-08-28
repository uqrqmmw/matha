'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePaperGradeGold, validateGold } = require('../scripts/evaluate-paper-grade-gold');

function syntheticGold() {
  return {
    schema: 1,
    id: 'synthetic-circle-trap',
    cases: Array.from({ length: 20 }, (_, index) => ({
      no: index + 1,
      page: Math.floor(index / 4) + 1,
      type: 'single',
      official: { selectedOptions: [1], points: 5 },
      observed: index === 3
        ? { hasFinalAnswer: false, selectedOptions: [], finalAnswer: '', status: 'unanswered', points: 0 }
        : { hasFinalAnswer: true, selectedOptions: [1], finalAnswer: '1', status: 'correct', points: 5 },
      evidence: index === 3
        ? { exclusionBoxes: [[0.1, 0.1, 0.2, 0.2]], mustNotTreatAsAnswer: true }
        : { answerBoxes: [[0.1, 0.1, 0.2, 0.2]] },
    })),
  };
}

test('整卷 gold evaluator 把「圈印刷題號」誤認為選項列為安全失敗', () => {
  const gold = syntheticGold();
  const prediction = {
    id: 'old-reader',
    cases: gold.cases.map((row) => row.no === 4
      ? { no: 4, hasFinalAnswer: true, selectedOptions: [4], finalAnswer: '4', status: 'correct', points: 5, marks: [] }
      : { no: row.no, ...row.observed, marks: [{ box: [0.11, 0.11, 0.19, 0.19] }] }),
  };
  const result = evaluatePaperGradeGold(gold, prediction, { verifySources: false });
  assert.equal(result.metrics.answerExact.rate, 0.95);
  assert.equal(result.metrics.negativeTrap.rate, 0);
  assert.equal(result.metrics.totals.expected, 95);
  assert.equal(result.metrics.totals.predicted, 100);
  assert.equal(result.gates.extractionAtLeast95, true);
  assert.equal(result.gates.deterministicScoreExact, false);
  assert.equal(result.gates.negativeTrapExact, false);
  assert.equal(result.rows.find((row) => row.no === 1).localizationOk, true);
  assert.equal(result.safeToShip, false);
});

test('私人第一回 gold set 存在時必須通過 20 題、來源雜湊與位置 schema', { skip: !process.env.MATHA_PRIVATE_PAPER_GOLD }, () => {
  const gold = JSON.parse(fs.readFileSync(process.env.MATHA_PRIVATE_PAPER_GOLD, 'utf8'));
  assert.equal(validateGold(gold, { verifySources: true }), true);
  assert.equal(gold.cases.reduce((sum, row) => sum + Number(row.observed.points || 0), 0), 70);
});
