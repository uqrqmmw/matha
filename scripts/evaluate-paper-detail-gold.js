'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NON_HUMAN = /(?:^|\b)(?:ai|bot|agent|codex|claude|chatgpt|openai)(?:\b|$)/i;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function normalized(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\\(?:left|right|displaystyle|textstyle|scriptstyle|scriptscriptstyle)\b/g, '')
    .replace(/\\[()[\]]|\${1,2}|[{}~\s]/g, '')
    .toLowerCase();
}

function evidenceMatches(actual, aliases) {
  const candidate = normalized(actual);
  if (candidate.length < 3) return false;
  return (aliases || []).map(normalized).filter((alias) => alias.length >= 3)
    .some((alias) => candidate.includes(alias) || alias.includes(candidate));
}

function validateGold(gold, { verifySources = true } = {}) {
  if (!gold || gold.schema !== 1 || !gold.id || !Array.isArray(gold.cases)) throw new Error('detail gold schema 不合法');
  const required = [3, 4, 11, 12, 13, 14, 16];
  const actual = gold.cases.map((row) => Number(row && row.no)).sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(required)) throw new Error('detail gold 必須正好包含首回 7 題真實失分題');
  for (const row of gold.cases) {
    if (!['diagnose', 'abstain'].includes(row.expectedMode)) throw new Error(`第 ${row.no} 題 expectedMode 不合法`);
    if (!row.officialAnswer || !row.studentEvidence || !Array.isArray(row.solutionEvidence) || !row.solutionEvidence.length) {
      throw new Error(`第 ${row.no} 題缺答案或像素證據`);
    }
    if (row.expectedMode === 'diagnose' && (!Array.isArray(row.firstErrorEvidenceAliases) || !row.firstErrorEvidenceAliases.length)) {
      throw new Error(`第 ${row.no} 題缺第一錯步證據別名`);
    }
  }
  if (verifySources) {
    for (const [name, source] of Object.entries(gold.sources || {})) {
      if (!source.path || !source.sha256 || !fs.existsSync(source.path)) throw new Error(`來源 ${name} 不完整`);
      if (sha256(source.path) !== String(source.sha256).toUpperCase()) throw new Error(`來源 ${name} 雜湊漂移`);
    }
    for (const row of gold.cases) {
      for (const asset of [row.studentEvidence, ...row.solutionEvidence]) {
        const file = path.resolve(gold.assetRoot, asset.file);
        if (!fs.existsSync(file)) throw new Error(`第 ${row.no} 題像素不存在：${asset.file}`);
        if (sha256(file) !== String(asset.sha256).toUpperCase()) throw new Error(`第 ${row.no} 題像素雜湊漂移：${asset.file}`);
      }
    }
    if (gold.releaseAuthority === true) {
      const approval = gold.releaseApproval || {};
      const approvedBy = String(approval.approvedBy || '').trim();
      const unsigned = path.resolve(String(approval.unsignedGoldPath || ''));
      const packet = path.resolve(String(approval.reviewPacketPath || ''));
      const signoff = path.resolve(String(approval.signoffPath || ''));
      if (approval.kind !== 'named-human-paper-detail-gold-signoff' || approvedBy.length < 3
        || NON_HUMAN.test(approvedBy) || !fs.existsSync(unsigned) || !fs.statSync(unsigned).isFile()
        || !fs.existsSync(packet) || !fs.statSync(packet).isFile()
        || !fs.existsSync(signoff) || !fs.statSync(signoff).isFile()
        || sha256(unsigned) !== String(approval.unsignedGoldSha256 || '').toUpperCase()
        || sha256(packet) !== String(approval.reviewPacketSha256 || '').toUpperCase()
        || sha256(signoff) !== String(approval.signoffSha256 || '').toUpperCase()) {
        throw new Error('detail gold 具名真人簽核或 exact-hash 證據不合法');
      }
      const signed = JSON.parse(fs.readFileSync(signoff, 'utf8'));
      if (signed.kind !== 'matha-paper-detail-gold-signoff' || signed.releaseAuthority !== true
        || signed.approvedBy !== approvedBy || signed.goldId !== gold.id
        || String(signed.unsignedGoldSha256 || '').toUpperCase() !== sha256(unsigned)
        || String(signed.reviewPacketSha256 || '').toUpperCase() !== sha256(packet)) {
        throw new Error('detail gold 簽核檔未綁定本次來源');
      }
    }
  }
  return true;
}

function evaluatePaperDetailGold(gold, prediction, options = {}) {
  validateGold(gold, options);
  if (!prediction || !Array.isArray(prediction.cases)) throw new Error('detail prediction schema 不合法');
  const byNo = new Map(prediction.cases.map((row) => [Number(row && row.no), row]));
  let diagnosable = 0;
  let predictedDiagnoses = 0;
  let correctDiagnoses = 0;
  let abstainCases = 0;
  let correctAbstains = 0;
  let falsePositiveDiagnoses = 0;
  let goodWorkCases = 0;
  let goodWorkMatches = 0;
  const rows = [];
  for (const truth of gold.cases) {
    const predicted = byNo.get(truth.no) || {};
    const hasDiagnosis = ['high', 'medium'].includes(predicted.confidence)
      && !!predicted.firstErrorEvidence && !!predicted.firstError;
    if (hasDiagnosis) predictedDiagnoses += 1;
    const evidenceOk = hasDiagnosis && evidenceMatches(predicted.firstErrorEvidence, truth.firstErrorEvidenceAliases);
    const diagnosisOk = truth.expectedMode === 'diagnose' && evidenceOk;
    if (truth.expectedMode === 'diagnose') {
      diagnosable += 1;
      if (diagnosisOk) correctDiagnoses += 1;
    } else {
      abstainCases += 1;
      if (!hasDiagnosis) correctAbstains += 1;
      else falsePositiveDiagnoses += 1;
    }
    const goodAliases = truth.goodWorkEvidenceAliases || [];
    let goodWorkOk = null;
    if (goodAliases.length) {
      goodWorkCases += 1;
      const joined = (predicted.goodWork || []).join('；');
      goodWorkOk = goodAliases.some((alias) => evidenceMatches(joined, [alias]));
      if (goodWorkOk) goodWorkMatches += 1;
    }
    rows.push({ no: truth.no, expectedMode: truth.expectedMode, hasDiagnosis, evidenceOk, diagnosisOk, goodWorkOk });
  }
  const precision = predictedDiagnoses ? correctDiagnoses / predictedDiagnoses : 0;
  const coverage = diagnosable ? correctDiagnoses / diagnosable : 1;
  const abstainAccuracy = abstainCases ? correctAbstains / abstainCases : 1;
  const goodWorkRate = goodWorkCases ? goodWorkMatches / goodWorkCases : 1;
  const gates = {
    precisionAtLeast90: precision >= 0.9,
    coverageAtLeast60: coverage >= 0.6,
    unsupportedDiagnosisZero: falsePositiveDiagnoses === 0,
    goodWorkAtLeast80: goodWorkRate >= 0.8,
    humanReleaseApproved: gold.releaseAuthority === true,
  };
  return {
    schema: 1,
    goldId: gold.id,
    metrics: {
      precision: { matched: correctDiagnoses, total: predictedDiagnoses, rate: precision },
      coverage: { matched: correctDiagnoses, total: diagnosable, rate: coverage },
      abstain: { matched: correctAbstains, total: abstainCases, rate: abstainAccuracy },
      unsupportedDiagnoses: falsePositiveDiagnoses,
      goodWork: { matched: goodWorkMatches, total: goodWorkCases, rate: goodWorkRate },
    },
    gates,
    safeToShip: Object.values(gates).every(Boolean),
    rows,
  };
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

if (require.main === module) {
  const goldPath = argValue('--gold');
  const predictionPath = argValue('--prediction');
  if (!goldPath || !predictionPath) {
    console.error('Usage: node scripts/evaluate-paper-detail-gold.js --gold <private-gold.json> --prediction <prediction.json> [--allow-fail]');
    process.exit(2);
  }
  const gold = JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(path.resolve(predictionPath), 'utf8'));
  const result = evaluatePaperDetailGold(gold, prediction, { verifySources: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.safeToShip && !process.argv.includes('--allow-fail')) process.exitCode = 1;
}

module.exports = { evaluatePaperDetailGold, validateGold };
