'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregatePaperDetailGoldResults, canonicalDigest, evaluatePaperDetailGold,
  evaluatePersonalDetailEvidence, predictionContentDigest, validateGold,
} = require('../scripts/evaluate-paper-detail-gold');

const hash = (character) => character.repeat(64);

function syntheticGold(numbers = [3, 4, 11, 12, 13, 14, 16], id = 'synthetic-detail') {
  const cases = numbers.map((no) => ({
    no,
    officialAnswer: '(1)',
    expectedMode: [4, 16].includes(no) ? 'abstain' : 'diagnose',
    firstErrorEvidenceAliases: [4, 16].includes(no) ? [] : [`錯式${no}`],
    goodWorkEvidenceAliases: no === 11 ? ['正確前綴'] : [],
    studentEvidence: { file: `student-${no}.png`, sha256: hash('A') },
    solutionEvidence: [{ file: `solution-${no}.png`, sha256: hash('B') }],
  }));
  return { schema: 1, id, assetRoot: '.', releaseAuthority: false, cases };
}

function metadata(no, { runId = 'run-1', sourceId = 'source-1', salt = 'C' } = {}) {
  return {
    runId, sourceId, questionNo: no,
    promptSha256: hash(salt), fullImageSha256: hash('D'),
    focusImageSha256: hash('E'), runStateSha256: hash('F'),
  };
}

function correctPrediction(gold, { runId = 'run-1', sourceId = 'source-1', salt = 'C' } = {}) {
  return {
    schema: 1, goldId: gold.id, runId, sourceId, promptSha256: hash(salt), runStateSha256: hash('F'),
    cases: gold.cases.map((row) => row.expectedMode === 'abstain' ? {
      no: row.no, mode: 'abstain', confidence: 'low', firstErrorEvidence: null, firstError: null,
      errorKind: null, whyWrong: null, repair: null, solution: null, goodWork: [],
      predictionMetadata: metadata(row.no, { runId, sourceId, salt }),
    } : {
      no: row.no, mode: 'diagnose', confidence: 'high', firstErrorEvidence: `錯式${row.no}`,
      firstError: '此步不成立', errorKind: '計算', whyWrong: '重算後不相等',
      repair: '修正這一行', solution: '完整解法', goodWork: row.no === 11 ? ['正確前綴'] : [],
      predictionMetadata: metadata(row.no, { runId, sourceId, salt }),
    }),
  };
}

function personalEvidence(count = 30) {
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    const runId = index < 15 ? 'run-a' : 'run-b';
    const sourceId = index < 15 ? 'source-a' : 'source-b';
    const questionNo = index % 15 + 1;
    const predictionMetadata = {
      schema: 1, runId, sourceId, questionNo, promptVersion: 'paper-detail-first-error-v4',
      promptSha256: hash('A'), fullImageSha256: hash('B'), focusImageSha256: hash('C'),
      runStateSha256: hash('D'), imageDigestEncoding: 'base64-payload-text-sha256',
      requestId: `request-${index}`, model: 'gpt-5.5',
    };
    predictionMetadata.canonicalDigest = canonicalDigest(predictionMetadata);
    predictionMetadata.predictionId = `detail-pred-${predictionMetadata.canonicalDigest.slice(0, 24)}`;
    const prediction = {
      no: questionNo, model: 'gpt-5.5', readable: true, confidence: 'high', read: `前綴；錯式${index}`,
      firstErrorEvidence: `錯式${index}`,
      firstError: '此步錯誤', errorKind: '計算', whyWrong: '重算不相等',
      repair: '修正', explanation: '', solution: ['完整解法'], goodWork: ['前綴正確'],
      answer: '(1)', nextTime: '', marks: [],
    };
    const predictionContentSha256 = predictionContentDigest(prediction);
    const humanReview = {
      id: `review-${index}`, at: 1_000 + index, reviewer: '本人', reviewSource: 'in-app-self-review',
      verdict: 'diagnosis-correct', expectedMode: 'diagnose', observedMode: 'diagnose',
      diagnosisCorrect: true, runId, sourceId, questionNo,
      predictionId: predictionMetadata.predictionId,
      predictionMetadataSha256: predictionMetadata.canonicalDigest,
      predictionContentSha256,
      correctedFirstErrorEvidence: '', note: '',
    };
    const row = {
      id: `${runId}:${questionNo}`, runId, sourceId, questionNo,
      predictionId: predictionMetadata.predictionId, predictionMetadata,
      predictionContentSha256, prediction, humanReview,
    };
    row.canonicalDigest = canonicalDigest(row);
    cases.push(row);
  }
  const sevenReady = count >= 7;
  const payload = {
    kind: 'matha-paper-detail-personal-gold-v1', schemaVersion: 1,
    generatedAt: '2026-08-30T12:00:00.000Z', appVersion: 'test',
    releaseAuthority: false, humanReviewed: true,
    thresholds: { minimumEvaluationCases: 7, precision: 0.9, coverage: 0.6, longTermGoldCases: 30 },
    result: {
      reviewed: count, predictedDiagnose: count, expectedDiagnose: count,
      correctDiagnoses: count, coveredDiagnoses: count, precision: 1, coverage: 1,
      sevenReady, thirtyReady: count >= 30 && sevenReady,
    },
    cases,
  };
  payload.canonicalDigest = canonicalDigest(payload);
  return payload;
}

test('詳批 evaluator 分開計算 precision、coverage、語義與無證據亂猜', () => {
  const gold = syntheticGold();
  const prediction = correctPrediction(gold);
  prediction.cases.find((row) => row.no === 4).mode = 'diagnose';
  Object.assign(prediction.cases.find((row) => row.no === 4), {
    confidence: 'high', firstErrorEvidence: '模型亂猜', firstError: '不存在的錯誤',
    errorKind: '概念', whyWrong: '猜測', repair: '猜測', solution: '猜測',
  });
  const result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.metrics.coverage.rate, 1);
  assert.equal(result.metrics.precision.rate, 5 / 6);
  assert.equal(result.metrics.unsupportedDiagnoses, 1);
  assert.equal(result.metrics.metadata.rate, 1);
  assert.equal(result.gates.precisionAtLeast90, false);
  assert.equal(result.gates.unsupportedDiagnosisZero, false);
  assert.equal(result.safeToShip, false);
});

test('prediction metadata 必須完整綁定 run/source/no 與四個雜湊', () => {
  const gold = syntheticGold([1]);
  gold.cases[0].expectedPredictionMetadata = {
    runId: 'run-1', sourceId: 'source-1', promptSha256: hash('C'),
    fullImageSha256: hash('D'), focusImageSha256: hash('E'), runStateSha256: hash('F'),
  };
  const prediction = correctPrediction(gold);
  let result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.gates.metadataAllBound, true);
  prediction.cases[0].predictionMetadata.focusImageSha256 = hash('9');
  result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.gates.metadataAllBound, false);
  assert.deepEqual(result.rows[0].metadataFailures, ['expected:focusImageSha256']);
  delete prediction.cases[0].predictionMetadata.runStateSha256;
  delete prediction.runStateSha256;
  result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.match(result.rows[0].metadataFailures.join(','), /runStateSha256/);
});

test('gold 提供語義真值時嚴格比對 errorKind、whyWrong、repair、solution，舊 gold 仍可評估', () => {
  const gold = syntheticGold([1]);
  Object.assign(gold.cases[0], {
    expectedErrorKind: '計算',
    expectedWhyWrongAliases: ['重算後不相等'],
    expectedRepairAliases: ['修正這一行'],
    expectedSolutionAliases: ['完整解法'],
  });
  const prediction = correctPrediction(gold);
  let result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.gates.semanticContractAllMatch, true);
  prediction.cases[0].errorKind = '概念';
  prediction.cases[0].whyWrong = '沒有重算';
  result = evaluatePaperDetailGold(gold, prediction, { verifySources: false });
  assert.equal(result.gates.semanticContractAllMatch, false);
  assert.equal(result.rows[0].semantic.errorKind.ok, false);
  assert.equal(result.rows[0].semantic.whyWrong.ok, false);

  const legacyGold = syntheticGold([1], 'legacy');
  const legacy = evaluatePaperDetailGold(legacyGold, correctPrediction(legacyGold), { verifySources: false });
  assert.equal(legacy.rows[0].semanticOk, true);
});

test('gold 支援任意 1 到 30 題且拒絕重複題號或超量', () => {
  assert.equal(validateGold(syntheticGold([9]), { verifySources: false }), true);
  assert.equal(validateGold(syntheticGold(Array.from({ length: 30 }, (_, index) => index + 1)), { verifySources: false }), true);
  assert.throws(() => validateGold(syntheticGold([1, 1]), { verifySources: false }), /不重複/);
  assert.throws(() => validateGold(syntheticGold(Array.from({ length: 31 }, (_, index) => index + 1)), { verifySources: false }), /1 到 30/);
});

test('30 題 aggregate 不重呼模型即可彙總 precision/coverage，且拒絕重複 run/source/no', () => {
  const first = syntheticGold(Array.from({ length: 15 }, (_, index) => index + 1), 'gold-a');
  const second = syntheticGold(Array.from({ length: 15 }, (_, index) => index + 16), 'gold-b');
  // The arbitrary sets should all be diagnosable for deterministic 30/30 metrics.
  for (const gold of [first, second]) {
    for (const row of gold.cases) {
      row.expectedMode = 'diagnose';
      row.firstErrorEvidenceAliases = [`錯式${row.no}`];
    }
  }
  const one = evaluatePaperDetailGold(first, correctPrediction(first, { runId: 'run-a', sourceId: 'source-a' }), { verifySources: false });
  const two = evaluatePaperDetailGold(second, correctPrediction(second, { runId: 'run-b', sourceId: 'source-b', salt: '9' }), { verifySources: false });
  const aggregate = aggregatePaperDetailGoldResults([one, two]);
  assert.equal(aggregate.caseCount, 30);
  assert.equal(aggregate.gates.casesAtLeastMinimum, true);
  assert.equal(aggregate.metrics.precision.rate, 1);
  assert.equal(aggregate.metrics.coverage.rate, 1);
  assert.equal(aggregate.metrics.metadata.rate, 1);
  assert.equal(aggregate.gates.allGoldHumanApproved, false);
  assert.equal(aggregate.safeToShip, false);

  const tooSmall = aggregatePaperDetailGoldResults([one]);
  assert.equal(tooSmall.gates.casesAtLeastMinimum, false);
  assert.throws(() => aggregatePaperDetailGoldResults([one, one]), /重複/);
});

test('直接驗證 App 個人 gold 匯出的三層 canonical digest 並彙總 30 題，不假算語義品質', () => {
  const evidence = personalEvidence(30);
  const result = evaluatePersonalDetailEvidence(evidence);
  assert.equal(result.caseCount, 30);
  assert.equal(result.metrics.precision.rate, 1);
  assert.equal(result.metrics.coverage.rate, 1);
  assert.equal(result.thirtyCasePersonalGoldReady, true);
  assert.equal(result.eligibleForPersonalCalibration, true);
  assert.equal(result.semanticGold.strict, false);
  assert.deepEqual(result.semanticGold.unevaluatedFields, ['errorKind', 'whyWrong', 'repair', 'solution']);
  assert.equal(result.safeToClaimStrictSemanticQuality, false);
  assert.equal(result.safeToShip, false);

  const seven = evaluatePersonalDetailEvidence(personalEvidence(7));
  assert.equal(seven.sevenCaseQualityReady, true);
  assert.equal(seven.thirtyCasePersonalGoldReady, false);
  assert.equal(seven.eligibleForPersonalCalibration, false);

  const tamperedCase = structuredClone(evidence);
  tamperedCase.cases[0].prediction.firstError = '偷偷改掉';
  assert.throws(() => evaluatePersonalDetailEvidence(tamperedCase), /evidence canonical digest 漂移|case canonical digest 漂移/);

  const tamperedMetadata = personalEvidence(30);
  tamperedMetadata.cases[0].predictionMetadata.fullImageSha256 = hash('9');
  tamperedMetadata.cases[0].canonicalDigest = canonicalDigest({
    ...tamperedMetadata.cases[0], canonicalDigest: undefined,
  });
  tamperedMetadata.canonicalDigest = canonicalDigest({ ...tamperedMetadata, canonicalDigest: undefined });
  assert.throws(() => evaluatePersonalDetailEvidence(tamperedMetadata), /metadata canonical digest 漂移/);

  const rehashedTamperedContent = personalEvidence(30);
  rehashedTamperedContent.cases[0].prediction.firstError = '改成另一個第一錯步';
  rehashedTamperedContent.cases[0].canonicalDigest = canonicalDigest({
    ...rehashedTamperedContent.cases[0], canonicalDigest: undefined,
  });
  rehashedTamperedContent.canonicalDigest = canonicalDigest({ ...rehashedTamperedContent, canonicalDigest: undefined });
  assert.throws(() => evaluatePersonalDetailEvidence(rehashedTamperedContent), /verdict 或綁定不一致/,
    '即使攻擊者重算 case/evidence digest，舊真人 verdict 也不能套到另一份 AI 內容');

  const badSummary = personalEvidence(30);
  badSummary.result.precision = 0.5;
  badSummary.canonicalDigest = canonicalDigest({ ...badSummary, canonicalDigest: undefined });
  assert.throws(() => evaluatePersonalDetailEvidence(badSummary), /result 與逐題 verdict 重算不一致/);
});

test('私人詳批 gold 存在時必須綁定全部像素與來源雜湊', { skip: !process.env.MATHA_PRIVATE_PAPER_DETAIL_GOLD }, () => {
  const fs = require('node:fs');
  const gold = JSON.parse(fs.readFileSync(process.env.MATHA_PRIVATE_PAPER_DETAIL_GOLD, 'utf8'));
  assert.equal(validateGold(gold, { verifySources: true }), true);
  assert.equal(gold.releaseAuthority, false, '尚未真人逐題簽核前必須 fail closed');
});
