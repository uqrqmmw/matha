'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NON_HUMAN = /(?:^|\b)(?:ai|bot|agent|codex|claude|chatgpt|openai)(?:\b|$)/i;
const SHA256 = /^[A-F0-9]{64}$/;
const MAX_GOLD_CASES = 30;
const SIGNOFF_CHECK_FIELDS = [
  'studentPixelsVerified', 'solutionPixelsVerified', 'truthModeVerified',
  'firstErrorEvidenceVerified', 'goodWorkEvidenceVerified',
];
const SIGNOFF_STATEMENT = 'I personally reviewed every bound student and official-solution image, '
  + 'and verified the proposed diagnosis or abstention truth for this exact gold hash.';
const BINDING_FIELDS = [
  'runId', 'sourceId', 'questionNo', 'promptSha256',
  'fullImageSha256', 'focusImageSha256', 'runStateSha256',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical evidence 含非有限數值');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('canonical evidence 含不可序列化欄位');
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

function predictionContent(value) {
  const marks = Array.isArray(value && value.marks) ? value.marks.slice(0, 2).map((mark) => ({
    box: Array.isArray(mark && mark.box) ? mark.box.slice(0, 4).map(Number) : [],
    label: String(mark && mark.label || ''),
  })) : [];
  return {
    schema: 1,
    no: Number(value && value.no),
    model: String(value && value.model || ''),
    readable: !!value && value.readable !== false,
    confidence: String(value && value.confidence || 'low'),
    read: String(value && value.read || ''),
    goodWork: Array.isArray(value && value.goodWork) ? value.goodWork.map(String) : [],
    firstErrorEvidence: value && value.firstErrorEvidence != null ? String(value.firstErrorEvidence) : null,
    firstError: value && value.firstError != null ? String(value.firstError) : null,
    errorKind: value && value.errorKind != null ? String(value.errorKind) : null,
    whyWrong: String(value && value.whyWrong || ''),
    repair: String(value && value.repair || ''),
    explanation: String(value && value.explanation || ''),
    solution: Array.isArray(value && value.solution) ? value.solution.map(String) : [],
    answer: String(value && value.answer || ''),
    nextTime: String(value && value.nextTime || ''),
    marks,
  };
}

function predictionContentDigest(value) {
  return canonicalDigest(predictionContent(value));
}

function normalized(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\\(?:left|right|displaystyle|textstyle|scriptstyle|scriptscriptstyle)\b/g, '')
    .replace(/\\[()[\]]|\${1,2}|[{}~\s]/g, '')
    .toLowerCase();
}

function asText(value) {
  return Array.isArray(value) ? value.join('；') : String(value == null ? '' : value);
}

function evidenceMatches(actual, aliases) {
  const candidate = normalized(asText(actual));
  if (candidate.length < 1) return false;
  return (aliases || []).map(normalized).filter(Boolean)
    .some((alias) => candidate.includes(alias) || alias.includes(candidate));
}

function questionNos(gold) {
  if (!Array.isArray(gold && gold.cases) || gold.cases.length < 1 || gold.cases.length > MAX_GOLD_CASES) {
    throw new Error(`detail gold cases 必須為 1 到 ${MAX_GOLD_CASES} 題`);
  }
  const numbers = gold.cases.map((row) => Number(row && row.no));
  if (numbers.some((no) => !Number.isInteger(no) || no < 1) || new Set(numbers).size !== numbers.length) {
    throw new Error('detail gold 題號必須為不重複正整數');
  }
  return numbers;
}

function expectedSpec(truth, field) {
  const prefix = field[0].toUpperCase() + field.slice(1);
  const aliases = truth[`expected${prefix}Aliases`] ?? truth[`${field}Aliases`];
  const exact = truth[`expected${prefix}`];
  if (aliases != null) {
    const values = Array.isArray(aliases) ? aliases : [aliases];
    if (!values.length || values.some((value) => !String(value == null ? '' : value).trim())) {
      throw new Error(`第 ${truth.no} 題 ${field} expected aliases 不合法`);
    }
    return { kind: 'aliases', values };
  }
  if (exact != null) {
    const values = Array.isArray(exact) ? exact : [exact];
    if (!values.length || values.some((value) => !String(value == null ? '' : value).trim())) {
      throw new Error(`第 ${truth.no} 題 expected${prefix} 不合法`);
    }
    return { kind: 'exact', values };
  }
  return null;
}

function semanticCheck(truth, predicted, field, required) {
  const actual = predicted[field];
  const present = Array.isArray(actual) ? actual.length > 0 : !!String(actual == null ? '' : actual).trim();
  const expected = expectedSpec(truth, field);
  if (!present) return { present: false, expected: !!expected, ok: !required && !expected };
  if (!expected) return { present: true, expected: false, ok: true };
  const ok = expected.kind === 'exact'
    ? expected.values.some((value) => normalized(actual) === normalized(value))
    : evidenceMatches(actual, expected.values);
  return { present: true, expected: true, ok };
}

function directOrNested(row, names) {
  const nested = row && (row.predictionMetadata || row.metadata || row.binding) || {};
  for (const name of names) {
    if (row && row[name] != null) return row[name];
    if (nested[name] != null) return nested[name];
  }
  return null;
}

function bindingFor(prediction, predicted) {
  return {
    runId: directOrNested(predicted, ['runId', 'paperRunId'])
      ?? prediction.runId ?? prediction.paperRunId ?? null,
    sourceId: directOrNested(predicted, ['sourceId', 'paperId'])
      ?? prediction.sourceId ?? prediction.paperId ?? null,
    questionNo: directOrNested(predicted, ['questionNo', 'no']),
    promptSha256: directOrNested(predicted, ['promptSha256']) ?? prediction.promptSha256 ?? null,
    fullImageSha256: directOrNested(predicted, ['fullImageSha256', 'fullImageHash']),
    focusImageSha256: directOrNested(predicted, ['focusImageSha256', 'focusImageHash']),
    runStateSha256: directOrNested(predicted, ['runStateSha256', 'runStateHash'])
      ?? prediction.runStateSha256 ?? null,
  };
}

function expectedBinding(gold, truth) {
  const nested = truth.expectedPredictionMetadata || truth.expectedBinding || {};
  const top = gold.expectedPredictionMetadata || gold.expectedBinding || {};
  const aliases = {
    runId: ['runId', 'paperRunId'], sourceId: ['sourceId', 'paperId'], questionNo: ['questionNo', 'no'],
    promptSha256: ['promptSha256'], fullImageSha256: ['fullImageSha256', 'fullImageHash'],
    focusImageSha256: ['focusImageSha256', 'focusImageHash'],
    runStateSha256: ['runStateSha256', 'runStateHash'],
  };
  const out = {};
  for (const [field, names] of Object.entries(aliases)) {
    let value = null;
    for (const name of names) {
      if (nested[name] != null) { value = nested[name]; break; }
      if (top[name] != null) { value = top[name]; break; }
    }
    if (value != null) out[field] = value;
  }
  out.questionNo = truth.no;
  return out;
}

function validatePredictionBinding(gold, truth, prediction, predicted) {
  const binding = bindingFor(prediction, predicted);
  const expected = expectedBinding(gold, truth);
  const failures = [];
  if (!String(binding.runId || '').trim()) failures.push('runId');
  if (!String(binding.sourceId || '').trim()) failures.push('sourceId');
  if (Number(binding.questionNo) !== Number(truth.no)) failures.push('questionNo');
  for (const field of ['promptSha256', 'fullImageSha256', 'focusImageSha256', 'runStateSha256']) {
    binding[field] = String(binding[field] || '').toUpperCase();
    if (!SHA256.test(binding[field])) failures.push(field);
  }
  for (const field of BINDING_FIELDS) {
    if (expected[field] == null) continue;
    const actual = field === 'questionNo' ? Number(binding[field]) : String(binding[field]).toUpperCase();
    const wanted = field === 'questionNo' ? Number(expected[field]) : String(expected[field]).toUpperCase();
    if (actual !== wanted) failures.push(`expected:${field}`);
  }
  const topChecks = [
    ['runId', prediction.runId ?? prediction.paperRunId],
    ['sourceId', prediction.sourceId ?? prediction.paperId],
    ['promptSha256', prediction.promptSha256],
    ['runStateSha256', prediction.runStateSha256],
  ];
  for (const [field, topValue] of topChecks) {
    if (topValue == null) continue;
    if (String(binding[field]).toUpperCase() !== String(topValue).toUpperCase()) failures.push(`top:${field}`);
  }
  if (predicted.studentEvidenceSha256 != null
      && String(predicted.studentEvidenceSha256).toUpperCase() !== String(truth.studentEvidence.sha256).toUpperCase()) {
    failures.push('studentEvidenceSha256');
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], binding };
}

function validateGold(gold, { verifySources = true } = {}) {
  if (!gold || gold.schema !== 1 || !gold.id) throw new Error('detail gold schema 不合法');
  questionNos(gold);
  for (const row of gold.cases) {
    if (!['diagnose', 'abstain'].includes(row.expectedMode)) throw new Error(`第 ${row.no} 題 expectedMode 不合法`);
    if (!row.officialAnswer || !row.studentEvidence || !Array.isArray(row.solutionEvidence) || !row.solutionEvidence.length) {
      throw new Error(`第 ${row.no} 題缺答案或像素證據`);
    }
    if (!row.studentEvidence.file || !SHA256.test(String(row.studentEvidence.sha256 || '').toUpperCase())) {
      throw new Error(`第 ${row.no} 題學生像素綁定不合法`);
    }
    if (row.solutionEvidence.some((asset) => !asset || !asset.file || !SHA256.test(String(asset.sha256 || '').toUpperCase()))) {
      throw new Error(`第 ${row.no} 題官方詳解像素綁定不合法`);
    }
    if (row.expectedMode === 'diagnose' && (!Array.isArray(row.firstErrorEvidenceAliases) || !row.firstErrorEvidenceAliases.length)) {
      throw new Error(`第 ${row.no} 題缺第一錯步證據別名`);
    }
    for (const field of ['errorKind', 'whyWrong', 'repair', 'solution']) expectedSpec(row, field);
  }
  if (verifySources) {
    if (!gold.assetRoot || !fs.existsSync(gold.assetRoot)) throw new Error('detail gold assetRoot 不存在');
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
      if (approval.kind !== 'named-human-paper-detail-gold-signoff' || approval.statement !== SIGNOFF_STATEMENT
        || approvedBy.length < 3
        || NON_HUMAN.test(approvedBy) || !fs.existsSync(unsigned) || !fs.statSync(unsigned).isFile()
        || !fs.existsSync(packet) || !fs.statSync(packet).isFile()
        || !fs.existsSync(signoff) || !fs.statSync(signoff).isFile()
        || sha256(unsigned) !== String(approval.unsignedGoldSha256 || '').toUpperCase()
        || sha256(packet) !== String(approval.reviewPacketSha256 || '').toUpperCase()
        || sha256(signoff) !== String(approval.signoffSha256 || '').toUpperCase()) {
        throw new Error('detail gold 具名真人簽核或 exact-hash 證據不合法');
      }
      const signed = JSON.parse(fs.readFileSync(signoff, 'utf8'));
      const unsignedGold = JSON.parse(fs.readFileSync(unsigned, 'utf8'));
      const packetData = JSON.parse(fs.readFileSync(packet, 'utf8'));
      const nos = questionNos(gold);
      const checks = signed.checks;
      const signedDraft = { ...gold, releaseAuthority: unsignedGold.releaseAuthority,
        reviewStatus: unsignedGold.reviewStatus };
      delete signedDraft.releaseApproval;
      if (signed.kind !== 'matha-paper-detail-gold-signoff' || signed.releaseAuthority !== true
        || signed.version !== 1 || signed.approvedBy !== approvedBy || signed.goldId !== gold.id
        || signed.statement !== SIGNOFF_STATEMENT || signed.approvedAt !== approval.approvedAt
        || !/(?:Z|[+-]\d{2}:\d{2})$/.test(String(signed.approvedAt || ''))
        || String(signed.unsignedGoldSha256 || '').toUpperCase() !== sha256(unsigned)
        || String(signed.reviewPacketSha256 || '').toUpperCase() !== sha256(packet)
        || JSON.stringify(signed.questionNos) !== JSON.stringify(nos)
        || !Array.isArray(checks) || checks.length !== nos.length
        || JSON.stringify(checks.map((row) => Number(row && row.no))) !== JSON.stringify(nos)
        || checks.some((row) => !row || Object.keys(row).sort().join('|') !== ['no', ...SIGNOFF_CHECK_FIELDS].sort().join('|')
          || SIGNOFF_CHECK_FIELDS.some((field) => row[field] !== true))
        || packetData.kind !== 'matha-paper-detail-gold-review-packet'
        || packetData.releaseAuthority !== false || packetData.goldId !== gold.id
        || String(packetData.unsignedGoldSha256 || '').toUpperCase() !== sha256(unsigned)
        || JSON.stringify(packetData.questionNos) !== JSON.stringify(nos)
        || JSON.stringify(canonical(signedDraft)) !== JSON.stringify(canonical(unsignedGold))) {
        throw new Error('detail gold 簽核檔未綁定本次來源與完整題集');
      }
    }
  }
  return true;
}

function evaluatePaperDetailGold(gold, prediction, options = {}) {
  validateGold(gold, options);
  if (!prediction || prediction.schema !== 1 || !Array.isArray(prediction.cases)) {
    throw new Error('detail prediction schema 不合法');
  }
  if (prediction.goldId != null && prediction.goldId !== gold.id) throw new Error('detail prediction goldId 不相符');
  const predictionNos = prediction.cases.map((row) => Number(row && row.no));
  if (predictionNos.some((no) => !Number.isInteger(no)) || new Set(predictionNos).size !== predictionNos.length) {
    throw new Error('detail prediction 題號重複或不合法');
  }
  const byNo = new Map(prediction.cases.map((row) => [Number(row && row.no), row]));
  let diagnosable = 0;
  let predictedDiagnoses = 0;
  let correctDiagnoses = 0;
  let abstainCases = 0;
  let correctAbstains = 0;
  let falsePositiveDiagnoses = 0;
  let goodWorkCases = 0;
  let goodWorkMatches = 0;
  let metadataMatches = 0;
  let semanticMatches = 0;
  const rows = [];
  for (const truth of gold.cases) {
    const predicted = byNo.get(Number(truth.no)) || {};
    const hasDiagnosis = ['high', 'medium'].includes(predicted.confidence)
      && !!predicted.firstErrorEvidence && !!predicted.firstError;
    const derivedMode = hasDiagnosis ? 'diagnose' : 'abstain';
    const declaredMode = predicted.mode == null ? derivedMode : String(predicted.mode);
    const modeOk = declaredMode === truth.expectedMode && declaredMode === derivedMode;
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
      goodWorkOk = goodAliases.some((alias) => evidenceMatches(predicted.goodWork || [], [alias]));
      if (goodWorkOk) goodWorkMatches += 1;
    }
    const semantic = {};
    for (const field of ['errorKind', 'whyWrong', 'repair', 'solution']) {
      semantic[field] = semanticCheck(truth, predicted, field, hasDiagnosis);
    }
    const semanticOk = modeOk && Object.values(semantic).every((item) => item.ok);
    if (semanticOk) semanticMatches += 1;
    const metadata = validatePredictionBinding(gold, truth, prediction, predicted);
    if (metadata.ok) metadataMatches += 1;
    rows.push({
      no: truth.no, expectedMode: truth.expectedMode, predictedMode: declaredMode,
      hasDiagnosis, modeOk, evidenceOk, diagnosisOk, goodWorkOk,
      semantic, semanticOk, metadataOk: metadata.ok, metadataFailures: metadata.failures,
      binding: metadata.binding,
    });
  }
  const precision = predictedDiagnoses ? correctDiagnoses / predictedDiagnoses : 0;
  const coverage = diagnosable ? correctDiagnoses / diagnosable : 1;
  const abstainAccuracy = abstainCases ? correctAbstains / abstainCases : 1;
  const goodWorkRate = goodWorkCases ? goodWorkMatches / goodWorkCases : 1;
  const caseCount = gold.cases.length;
  const gates = {
    precisionAtLeast90: precision >= 0.9,
    coverageAtLeast60: coverage >= 0.6,
    unsupportedDiagnosisZero: falsePositiveDiagnoses === 0,
    goodWorkAtLeast80: goodWorkRate >= 0.8,
    semanticContractAllMatch: semanticMatches === caseCount,
    metadataAllBound: metadataMatches === caseCount,
    humanReleaseApproved: gold.releaseAuthority === true,
  };
  return {
    schema: 2,
    goldId: gold.id,
    caseCount,
    metrics: {
      precision: { matched: correctDiagnoses, total: predictedDiagnoses, rate: precision },
      coverage: { matched: correctDiagnoses, total: diagnosable, rate: coverage },
      abstain: { matched: correctAbstains, total: abstainCases, rate: abstainAccuracy },
      unsupportedDiagnoses: falsePositiveDiagnoses,
      goodWork: { matched: goodWorkMatches, total: goodWorkCases, rate: goodWorkRate },
      semantic: { matched: semanticMatches, total: caseCount, rate: semanticMatches / caseCount },
      metadata: { matched: metadataMatches, total: caseCount, rate: metadataMatches / caseCount },
    },
    gates,
    safeToShip: Object.values(gates).every(Boolean),
    rows,
  };
}

function aggregatePaperDetailGoldResults(results, { minimumCases = 30 } = {}) {
  if (!Array.isArray(results) || !results.length) throw new Error('detail evaluation aggregate 至少需要一份結果');
  if (!Number.isInteger(minimumCases) || minimumCases < 1) throw new Error('minimumCases 必須為正整數');
  const identities = new Set();
  const rows = [];
  let predicted = 0;
  let precisionMatched = 0;
  let diagnosable = 0;
  let coverageMatched = 0;
  let abstainTotal = 0;
  let abstainMatched = 0;
  let unsupported = 0;
  let goodTotal = 0;
  let goodMatched = 0;
  let semanticMatched = 0;
  let metadataMatched = 0;
  let approved = true;
  for (const result of results) {
    if (!result || !Array.isArray(result.rows) || !result.metrics || !result.gates) throw new Error('detail evaluation 結果不合法');
    for (const row of result.rows) {
      const source = String(row.binding && row.binding.sourceId || '');
      const run = String(row.binding && row.binding.runId || '');
      const identity = `${source}\u0000${run}\u0000${Number(row.no)}`;
      if (!source || !run || identities.has(identity)) throw new Error('detail aggregate 有未綁定或重複的 run/source/no');
      identities.add(identity);
      rows.push({ goldId: result.goldId, ...row });
    }
    predicted += result.metrics.precision.total;
    precisionMatched += result.metrics.precision.matched;
    diagnosable += result.metrics.coverage.total;
    coverageMatched += result.metrics.coverage.matched;
    abstainTotal += result.metrics.abstain.total;
    abstainMatched += result.metrics.abstain.matched;
    unsupported += result.metrics.unsupportedDiagnoses;
    goodTotal += result.metrics.goodWork.total;
    goodMatched += result.metrics.goodWork.matched;
    semanticMatched += result.metrics.semantic.matched;
    metadataMatched += result.metrics.metadata.matched;
    approved = approved && result.gates.humanReleaseApproved === true;
  }
  const count = rows.length;
  const precision = predicted ? precisionMatched / predicted : 0;
  const coverage = diagnosable ? coverageMatched / diagnosable : 1;
  const goodWork = goodTotal ? goodMatched / goodTotal : 1;
  const gates = {
    casesAtLeastMinimum: count >= minimumCases,
    precisionAtLeast90: precision >= 0.9,
    coverageAtLeast60: coverage >= 0.6,
    unsupportedDiagnosisZero: unsupported === 0,
    goodWorkAtLeast80: goodWork >= 0.8,
    semanticContractAllMatch: semanticMatched === count,
    metadataAllBound: metadataMatched === count,
    allGoldHumanApproved: approved,
  };
  return {
    schema: 1,
    kind: 'matha-paper-detail-gold-aggregate',
    evaluationCount: results.length,
    caseCount: count,
    minimumCases,
    metrics: {
      precision: { matched: precisionMatched, total: predicted, rate: precision },
      coverage: { matched: coverageMatched, total: diagnosable, rate: coverage },
      abstain: { matched: abstainMatched, total: abstainTotal, rate: abstainTotal ? abstainMatched / abstainTotal : 1 },
      unsupportedDiagnoses: unsupported,
      goodWork: { matched: goodMatched, total: goodTotal, rate: goodWork },
      semantic: { matched: semanticMatched, total: count, rate: semanticMatched / count },
      metadata: { matched: metadataMatched, total: count, rate: metadataMatched / count },
    },
    gates,
    safeToShip: Object.values(gates).every(Boolean),
    rows,
  };
}

const PERSONAL_VERDICTS = Object.freeze({
  'diagnosis-correct': { expectedMode: 'diagnose', observedMode: 'diagnose', correct: true },
  'diagnosis-wrong': { expectedMode: 'diagnose', observedMode: 'diagnose', correct: false },
  'missed-diagnosis': { expectedMode: 'diagnose', observedMode: 'abstain', correct: false },
  'abstain-correct': { expectedMode: 'abstain', observedMode: 'abstain', correct: true },
  'should-abstain': { expectedMode: 'abstain', observedMode: 'diagnose', correct: false },
});

function finiteRateEqual(actual, expected) {
  if (actual == null || expected == null) return actual == null && expected == null;
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) < 1e-12;
}

function verifyCanonicalField(value, field = 'canonicalDigest', omitted = [field]) {
  const expected = String(value && value[field] || '').toLowerCase();
  if (!SHA256.test(expected.toUpperCase())) return false;
  const unsigned = { ...value };
  for (const name of omitted) delete unsigned[name];
  return canonicalDigest(unsigned) === expected;
}

function evaluatePersonalDetailEvidence(evidence, { minimumCases = 30 } = {}) {
  if (!evidence || evidence.kind !== 'matha-paper-detail-personal-gold-v1'
    || evidence.schemaVersion !== 1 || evidence.releaseAuthority !== false
    || evidence.humanReviewed !== true || !Array.isArray(evidence.cases) || !evidence.cases.length) {
    throw new Error('個人詳批 evidence schema 不合法');
  }
  if (!Number.isInteger(minimumCases) || minimumCases < 1) throw new Error('minimumCases 必須為正整數');
  if (!verifyCanonicalField(evidence)) throw new Error('個人詳批 evidence canonical digest 漂移');
  const identities = new Set();
  const rows = [];
  let predictedDiagnose = 0;
  let expectedDiagnose = 0;
  let correctDiagnoses = 0;
  let coveredDiagnoses = 0;
  let correctAbstains = 0;
  let abstainCases = 0;
  let unsupportedDiagnoses = 0;
  for (const sourceRow of evidence.cases) {
    if (!sourceRow || !verifyCanonicalField(sourceRow)) throw new Error('個人詳批 case canonical digest 漂移');
    const metadata = sourceRow.predictionMetadata;
    const prediction = sourceRow.prediction;
    const review = sourceRow.humanReview;
    if (!metadata || !prediction || !review) throw new Error('個人詳批 case 缺 prediction、metadata 或真人 verdict');
    if (!verifyCanonicalField(metadata, 'canonicalDigest', ['canonicalDigest', 'predictionId'])) {
      throw new Error('個人詳批 prediction metadata canonical digest 漂移');
    }
    const metadataResult = validatePredictionBinding({}, { no: sourceRow.questionNo }, {}, {
      no: sourceRow.questionNo, predictionMetadata: metadata,
    });
    if (!metadataResult.ok) throw new Error(`個人詳批 prediction metadata 未完整綁定：${metadataResult.failures.join(',')}`);
    const identity = `${metadata.sourceId}\u0000${metadata.runId}\u0000${Number(metadata.questionNo)}`;
    if (identities.has(identity)) throw new Error('個人詳批 evidence 有重複 run/source/no');
    identities.add(identity);
    const rule = PERSONAL_VERDICTS[String(review.verdict || '')];
    const observedFromPrediction = prediction.firstError && prediction.firstErrorEvidence ? 'diagnose' : 'abstain';
    const contentSha256 = String(sourceRow.predictionContentSha256 || '').toLowerCase();
    if (!rule || String(sourceRow.id || '') !== `${metadata.runId}:${metadata.questionNo}`
      || String(sourceRow.runId || '') !== String(metadata.runId)
      || String(sourceRow.sourceId || '') !== String(metadata.sourceId)
      || Number(sourceRow.questionNo) !== Number(metadata.questionNo)
      || String(sourceRow.predictionId || '') !== String(metadata.predictionId)
      || String(metadata.predictionId || '') !== `detail-pred-${String(metadata.canonicalDigest).slice(0, 24)}`
      || String(review.predictionId || '') !== String(metadata.predictionId)
      || String(review.predictionMetadataSha256 || '').toLowerCase() !== String(metadata.canonicalDigest).toLowerCase()
      || !SHA256.test(contentSha256.toUpperCase())
      || contentSha256 !== predictionContentDigest(prediction)
      || String(review.predictionContentSha256 || '').toLowerCase() !== contentSha256
      || sourceRow.predictionConflict === true
      || String(review.runId || '') !== String(metadata.runId)
      || String(review.sourceId || '') !== String(metadata.sourceId)
      || Number(review.questionNo) !== Number(metadata.questionNo)
      || review.reviewer !== '本人' || review.reviewSource !== 'in-app-self-review'
      || review.expectedMode !== rule.expectedMode || review.observedMode !== rule.observedMode
      || review.diagnosisCorrect !== rule.correct || observedFromPrediction !== rule.observedMode
      || (['diagnosis-wrong', 'missed-diagnosis'].includes(review.verdict)
        && String(review.correctedFirstErrorEvidence || '').trim().length < 2)) {
      throw new Error(`個人詳批第 ${sourceRow.questionNo} 題 verdict 或綁定不一致`);
    }
    if (rule.observedMode === 'diagnose') predictedDiagnose += 1;
    if (rule.expectedMode === 'diagnose') {
      expectedDiagnose += 1;
      if (rule.observedMode === 'diagnose') coveredDiagnoses += 1;
      if (review.verdict === 'diagnosis-correct') correctDiagnoses += 1;
    } else {
      abstainCases += 1;
      if (review.verdict === 'abstain-correct') correctAbstains += 1;
      if (review.verdict === 'should-abstain') unsupportedDiagnoses += 1;
    }
    rows.push({
      id: sourceRow.id, runId: metadata.runId, sourceId: metadata.sourceId,
      questionNo: Number(metadata.questionNo), verdict: review.verdict,
      expectedMode: rule.expectedMode, observedMode: rule.observedMode,
      diagnosisCorrect: rule.correct, metadataOk: true, canonicalDigest: sourceRow.canonicalDigest,
    });
  }
  const count = rows.length;
  const precision = predictedDiagnose ? correctDiagnoses / predictedDiagnose : null;
  const coverage = expectedDiagnose ? coveredDiagnoses / expectedDiagnose : null;
  const correctCoverage = expectedDiagnose ? correctDiagnoses / expectedDiagnose : null;
  const sourceResult = evidence.result || {};
  if (Number(sourceResult.reviewed) !== count
    || Number(sourceResult.predictedDiagnose) !== predictedDiagnose
    || Number(sourceResult.expectedDiagnose) !== expectedDiagnose
    || Number(sourceResult.correctDiagnoses) !== correctDiagnoses
    || Number(sourceResult.coveredDiagnoses) !== coveredDiagnoses
    || !finiteRateEqual(sourceResult.precision, precision)
    || !finiteRateEqual(sourceResult.coverage, coverage)
    || sourceResult.sevenReady !== (count >= 7 && precision != null && coverage != null && precision >= 0.9 && coverage >= 0.6)
    || sourceResult.thirtyReady !== (count >= 30 && count >= 7 && precision != null && coverage != null
      && precision >= 0.9 && coverage >= 0.6)) {
    throw new Error('個人詳批 evidence result 與逐題 verdict 重算不一致');
  }
  const qualityPass = precision != null && coverage != null && precision >= 0.9 && coverage >= 0.6;
  const gates = {
    canonicalAndMetadataBound: true,
    casesAtLeastMinimum: count >= minimumCases,
    precisionAtLeast90: precision != null && precision >= 0.9,
    coverageAtLeast60: coverage != null && coverage >= 0.6,
  };
  return {
    schema: 1,
    kind: 'matha-paper-detail-personal-gold-evaluation',
    generatedAt: new Date().toISOString(),
    caseCount: count,
    minimumCases,
    metrics: {
      precision: { matched: correctDiagnoses, total: predictedDiagnose, rate: precision },
      coverage: { matched: coveredDiagnoses, total: expectedDiagnose, rate: coverage },
      correctCoverage: { matched: correctDiagnoses, total: expectedDiagnose, rate: correctCoverage },
      abstain: { matched: correctAbstains, total: abstainCases,
        rate: abstainCases ? correctAbstains / abstainCases : 1 },
      unsupportedDiagnoses,
    },
    semanticGold: {
      strict: false,
      reason: '真人 verdict 只標註第一錯步 diagnose/abstain 與是否正確；未逐欄提供 errorKind、whyWrong、repair、solution 真值。',
      evaluatedFields: ['mode', 'first-error-verdict'],
      unevaluatedFields: ['errorKind', 'whyWrong', 'repair', 'solution'],
    },
    gates,
    sevenCaseQualityReady: count >= 7 && qualityPass,
    thirtyCasePersonalGoldReady: count >= 30 && qualityPass,
    eligibleForPersonalCalibration: Object.values(gates).every(Boolean),
    safeToClaimStrictSemanticQuality: false,
    safeToShip: false,
    rows,
  };
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

function evaluatePair(goldPath, predictionPath) {
  const gold = JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(path.resolve(predictionPath), 'utf8'));
  return evaluatePaperDetailGold(gold, prediction, { verifySources: true });
}

if (require.main === module) {
  const manifestPath = argValue('--manifest');
  const personalEvidencePath = argValue('--personal-evidence');
  let result;
  if (personalEvidencePath) {
    const evidence = JSON.parse(fs.readFileSync(path.resolve(personalEvidencePath), 'utf8'));
    result = evaluatePersonalDetailEvidence(evidence, {
      minimumCases: Number(argValue('--minimum-cases') || 30),
    });
  } else if (manifestPath) {
    const resolvedManifest = path.resolve(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
    if (!manifest || manifest.kind !== 'matha-paper-detail-evaluation-manifest'
      || manifest.schema !== 1 || !Array.isArray(manifest.pairs) || !manifest.pairs.length) {
      throw new Error('detail evaluation manifest 不合法');
    }
    const root = path.dirname(resolvedManifest);
    const results = manifest.pairs.map((pair) => evaluatePair(
      path.resolve(root, String(pair.gold || '')),
      path.resolve(root, String(pair.prediction || '')),
    ));
    result = aggregatePaperDetailGoldResults(results, {
      minimumCases: Number(manifest.minimumCases || argValue('--minimum-cases') || 30),
    });
  } else {
    const goldPath = argValue('--gold');
    const predictionPath = argValue('--prediction');
    if (!goldPath || !predictionPath) {
      console.error('Usage: node scripts/evaluate-paper-detail-gold.js --gold <private-gold.json> --prediction <prediction.json> [--allow-fail]\n'
        + '   or: node scripts/evaluate-paper-detail-gold.js --manifest <pairs.json> [--minimum-cases 30] [--allow-fail]\n'
        + '   or: node scripts/evaluate-paper-detail-gold.js --personal-evidence <app-export.json> [--minimum-cases 30] [--allow-fail]');
      process.exit(2);
    }
    result = evaluatePair(goldPath, predictionPath);
  }
  console.log(JSON.stringify(result, null, 2));
  const passed = result.kind === 'matha-paper-detail-personal-gold-evaluation'
    ? result.eligibleForPersonalCalibration : result.safeToShip;
  if (!passed && !process.argv.includes('--allow-fail')) process.exitCode = 1;
}

module.exports = {
  aggregatePaperDetailGoldResults, canonicalDigest, evaluatePaperDetailGold,
  predictionContent, predictionContentDigest,
  evaluatePersonalDetailEvidence, questionNos, validateGold,
};
