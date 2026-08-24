'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-grading-detail-golden.json'), 'utf8'));

test('原版詳批第一錯步只信任 read 中可核對的 golden 證據', () => {
  assert.equal(golden.schema, 1);
  const { context, run } = loadApp();
  context.__goldenCases = golden.cases;
  const results = plain(run(`__goldenCases.map((fixture) => {
    const detail = paperNormalizeAiDetail(PAPER_SOURCES[0], 2, fixture.raw, 'gpt-5.5');
    return {
      id: fixture.id,
      confidence: detail.confidence,
      trusted: !!detail.firstErrorEvidence && !!detail.firstError && !!detail.errorKind,
      markCount: detail.marks.length,
      firstErrorEvidence: detail.firstErrorEvidence,
    };
  })`));

  assert.deepEqual(results.map(({ id, confidence, trusted, markCount }) => ({ id, confidence, trusted, markCount })),
    golden.cases.map((fixture) => ({ id:fixture.id, ...fixture.expected })));
  assert.equal(results[0].firstErrorEvidence, golden.cases[0].raw.firstErrorEvidence);
  assert.equal(results[1].firstErrorEvidence, null);
  assert.equal(results[2].firstErrorEvidence, golden.cases[2].raw.firstErrorEvidence);
  assert.equal(results[3].firstErrorEvidence, null);
});
