'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sortedOptions(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 5))].sort((a, b) => a - b);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedFill(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every((value) => Number.isFinite(Number(value))
    && Number(value) >= 0 && Number(value) <= 1) && Number(box[0]) < Number(box[2]) && Number(box[1]) < Number(box[3]);
}

function centerInside(box, target) {
  if (!validBox(box) || !validBox(target)) return false;
  const x = (Number(box[0]) + Number(box[2])) / 2;
  const y = (Number(box[1]) + Number(box[3])) / 2;
  return x >= Number(target[0]) && x <= Number(target[2]) && y >= Number(target[1]) && y <= Number(target[3]);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function validateGold(gold, { verifySources = true } = {}) {
  if (!gold || gold.schema !== 1 || !gold.id || !Array.isArray(gold.cases)) throw new Error('gold set schema 不合法');
  if (gold.cases.length !== 20) throw new Error(`gold set 必須正好 20 題，目前 ${gold.cases.length}`);
  const seen = new Set();
  for (const row of gold.cases) {
    const no = Number(row && row.no);
    if (!Number.isInteger(no) || no < 1 || no > 20 || seen.has(no)) throw new Error(`gold set 題號不合法：${no}`);
    seen.add(no);
    if (!['single', 'multi', 'fill'].includes(row.type)) throw new Error(`第 ${no} 題 type 不合法`);
    if (!row.official || !Number.isFinite(Number(row.official.points)) || !row.observed) throw new Error(`第 ${no} 題缺官方答案或人工真值`);
    const answered = row.observed.hasFinalAnswer === true;
    const answerBoxes = row.evidence && row.evidence.answerBoxes || [];
    const exclusionBoxes = row.evidence && row.evidence.exclusionBoxes || [];
    if (answered && (!answerBoxes.length || !answerBoxes.every(validBox))) throw new Error(`第 ${no} 題缺人工圈定的答案位置`);
    if (!answered && (!exclusionBoxes.length || !exclusionBoxes.every(validBox))) throw new Error(`第 ${no} 題缺「不可當答案」的負例位置`);
  }
  if (verifySources && gold.sources) {
    for (const [name, source] of Object.entries(gold.sources)) {
      if (!source || !source.path || !source.sha256) throw new Error(`來源 ${name} 缺 path 或 sha256`);
      if (!fs.existsSync(source.path)) throw new Error(`來源 ${name} 不存在：${source.path}`);
      const actual = sha256(source.path);
      if (actual !== String(source.sha256).toUpperCase()) throw new Error(`來源 ${name} 雜湊漂移`);
    }
  }
  return true;
}

function answerExact(gold, prediction) {
  const expectedFinal = gold.observed.hasFinalAnswer === true;
  const predictedFinal = prediction && prediction.hasFinalAnswer === true;
  if (expectedFinal !== predictedFinal) return false;
  if (!expectedFinal) return sortedOptions(prediction && prediction.selectedOptions).length === 0
    && normalizedFill(prediction && prediction.finalAnswer) === '';
  if (gold.type === 'fill') return normalizedFill(gold.observed.finalAnswer) === normalizedFill(prediction && prediction.finalAnswer);
  return sameArray(sortedOptions(gold.observed.selectedOptions), sortedOptions(prediction && prediction.selectedOptions));
}

function evaluatePaperGradeGold(gold, prediction, options = {}) {
  validateGold(gold, options);
  if (!prediction || !Array.isArray(prediction.cases)) throw new Error('prediction schema 不合法');
  const byNo = new Map(prediction.cases.map((row) => [Number(row && row.no), row]));
  const rows = [];
  let answerMatches = 0;
  let statusMatches = 0;
  let pointsMatches = 0;
  let multiStates = 0;
  let multiStateMatches = 0;
  let traps = 0;
  let trapPasses = 0;
  let localizableCases = 0;
  let localizedCases = 0;
  let predictedTotal = 0;
  let expectedTotal = 0;

  for (const expected of gold.cases) {
    const predicted = byNo.get(expected.no) || {};
    const answerOk = answerExact(expected, predicted);
    const statusOk = String(predicted.status || '') === String(expected.observed.status || '');
    const pointsOk = Number(predicted.points) === Number(expected.observed.points);
    if (answerOk) answerMatches += 1;
    if (statusOk) statusMatches += 1;
    if (pointsOk) pointsMatches += 1;
    predictedTotal += Number(predicted.points) || 0;
    expectedTotal += Number(expected.observed.points) || 0;

    if (expected.type === 'multi') {
      const chosen = new Set(sortedOptions(predicted.selectedOptions));
      const truth = new Set(sortedOptions(expected.observed.selectedOptions));
      for (let option = 1; option <= 5; option += 1) {
        multiStates += 1;
        if (chosen.has(option) === truth.has(option)) multiStateMatches += 1;
      }
    }

    if (expected.evidence && expected.evidence.mustNotTreatAsAnswer) {
      traps += 1;
      if (!predicted.hasFinalAnswer && sortedOptions(predicted.selectedOptions).length === 0
        && normalizedFill(predicted.finalAnswer) === '' && predicted.status === 'unanswered') trapPasses += 1;
    }

    const targets = expected.evidence && expected.evidence.answerBoxes || [];
    let localizationOk = null;
    if (expected.observed.hasFinalAnswer && targets.length) {
      localizableCases += 1;
      const marks = (Array.isArray(predicted.marks) ? predicted.marks : []).filter((mark) => validBox(mark && mark.box));
      localizationOk = marks.some((mark) => targets.some((target) => centerInside(mark.box, target)));
      if (localizationOk) localizedCases += 1;
    }

    rows.push({ no: expected.no, answerOk, statusOk, pointsOk, localizationOk });
  }

  const totalCases = gold.cases.length;
  const metrics = {
    answerExact: { matched: answerMatches, total: totalCases, rate: answerMatches / totalCases },
    statusExact: { matched: statusMatches, total: totalCases, rate: statusMatches / totalCases },
    pointsExact: { matched: pointsMatches, total: totalCases, rate: pointsMatches / totalCases },
    multiOptionState: { matched: multiStateMatches, total: multiStates, rate: multiStates ? multiStateMatches / multiStates : 1 },
    negativeTrap: { matched: trapPasses, total: traps, rate: traps ? trapPasses / traps : 1 },
    localization: { matched: localizedCases, total: localizableCases, rate: localizableCases ? localizedCases / localizableCases : 1 },
    totals: { expected: expectedTotal, predicted: predictedTotal, exact: expectedTotal === predictedTotal },
  };
  const gates = {
    extractionAtLeast95: metrics.answerExact.rate >= 0.95,
    deterministicScoreExact: metrics.statusExact.rate === 1 && metrics.pointsExact.rate === 1 && metrics.totals.exact,
    multiOptionExact: metrics.multiOptionState.rate === 1,
    negativeTrapExact: metrics.negativeTrap.rate === 1,
    redPenLocalizedAtLeast90: metrics.localization.rate >= 0.9,
  };
  return { schema: 1, goldId: gold.id, predictionId: prediction.id || '', metrics, gates, safeToShip: Object.values(gates).every(Boolean), rows };
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

if (require.main === module) {
  const goldPath = argValue('--gold');
  const predictionPath = argValue('--prediction');
  if (!goldPath || !predictionPath) {
    console.error('Usage: node scripts/evaluate-paper-grade-gold.js --gold <private-gold.json> --prediction <prediction.json> [--allow-fail]');
    process.exit(2);
  }
  const gold = JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(path.resolve(predictionPath), 'utf8'));
  const result = evaluatePaperGradeGold(gold, prediction, { verifySources: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.safeToShip && !process.argv.includes('--allow-fail')) process.exitCode = 1;
}

module.exports = { evaluatePaperGradeGold, validateGold };
