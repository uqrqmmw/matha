'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOPICS = new Set(['num', 'line', 'poly', 'seq', 'comb', 'prob', 'data', 'trig1', 'trig2', 'exp', 'vec', 'vec3', 'space', 'mat']);
const TYPES = new Set(['single', 'multi', 'fill']);
const OUT_OF_RANGE_RE = [/\\(?:cot|sec|csc)\b/, /(?:餘切|正割|餘割)\s*函數/, /十分逼近法/];
const SUSPICIOUS_HTML_RE = /<\s*(?:script|iframe|object|embed|style)\b|\bon\w+\s*=|javascript\s*:/i;

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value) {
  return String(value)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeQuestion(value, maskNumbers) {
  let out = cleanText(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\\[()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (maskNumbers) out = out.replace(/(?<![a-z])[-+]?\d+(?:\.\d+)?/gi, '#');
  return out;
}

function validateQuestion(q) {
  if (!q || typeof q.id !== 'string' || !q.id) return 'id-missing';
  if (!/^[\w.:-]+$/.test(q.id)) return 'id-invalid';
  if (!TOPICS.has(q.topic)) return 'topic-invalid';
  if (!TYPES.has(q.type)) return 'type-invalid';
  if (![1, 2, 3].includes(q.diff)) return 'difficulty-invalid';
  if (!q.q || typeof q.q !== 'string') return 'question-missing';
  if (q.type === 'fill') {
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => typeof a !== 'string' && typeof a !== 'number')) return 'answer-invalid';
  } else {
    if (!Array.isArray(q.opts) || q.opts.length < 2) return 'options-invalid';
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => !Number.isInteger(a) || a < 0 || a >= q.opts.length)) return 'answer-invalid';
  }
  return null;
}

function sanitizeQuestion(input) {
  const q = { ...input };
  for (const key of ['q', 'stem', 'sol', 'tip', 'src']) if (typeof q[key] === 'string') q[key] = cleanText(q[key]);
  if (Array.isArray(q.opts)) q.opts = q.opts.map((v) => typeof v === 'string' ? cleanText(v) : v);
  if (Array.isArray(q.ans)) q.ans = q.ans.map((v) => typeof v === 'string' ? cleanText(v) : v);
  return q;
}

function loadBuiltinQuestions(repoRoot) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'bank.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'practice-bank.js'), 'utf8'), context);
  return vm.runInContext('BANK', context);
}

function sourceFileName(source, index) {
  const hint = String(source || 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 28) || 'pack';
  return `${String(index + 1).padStart(2, '0')}-${hint}-${sha(source || 'unknown').slice(0, 8)}.json`;
}

function sanitizeBank(items, builtinQuestions) {
  const report = {
    sourceTotal: items.length,
    accepted: 0,
    skipped: { schema: 0, missingFigure: 0, outOfRange: 0, suspiciousHtml: 0, duplicateId: 0, duplicateBuiltin: 0, duplicateLegacy: 0 },
    emojiCleaned: 0,
    templateGroups: 0,
  };
  const ids = new Set();
  const builtinText = new Set((builtinQuestions || []).map((q) => normalizeQuestion(q.q, false)).filter(Boolean));
  const legacyText = new Set();
  const accepted = [];

  for (const original of items) {
    const joined = [original && original.q, original && original.stem, original && original.sol, original && original.tip, ...((original && original.opts) || [])]
      .filter((v) => typeof v === 'string').join('\n');
    if (/\p{Extended_Pictographic}/u.test(joined)) report.emojiCleaned++;
    const q = sanitizeQuestion(original || {});
    if (validateQuestion(q)) { report.skipped.schema++; continue; }
    if (ids.has(q.id)) { report.skipped.duplicateId++; continue; }
    ids.add(q.id);
    if (q.needsFigure && !q.fig) { report.skipped.missingFigure++; continue; }
    if (OUT_OF_RANGE_RE.some((re) => re.test(q.q))) { report.skipped.outOfRange++; continue; }
    if (SUSPICIOUS_HTML_RE.test(joined)) { report.skipped.suspiciousHtml++; continue; }
    const exact = normalizeQuestion(q.q, false);
    if (builtinText.has(exact)) { report.skipped.duplicateBuiltin++; continue; }
    if (legacyText.has(exact)) { report.skipped.duplicateLegacy++; continue; }
    legacyText.add(exact);
    accepted.push(q);
  }

  const fingerprints = new Map();
  for (const q of accepted) {
    const fp = normalizeQuestion(q.q, true);
    if (!fingerprints.has(fp)) fingerprints.set(fp, []);
    fingerprints.get(fp).push(q);
  }
  for (const group of fingerprints.values()) {
    if (group.length < 2) continue;
    const grp = `legacy-${sha(normalizeQuestion(group[0].q, true)).slice(0, 14)}`;
    for (const q of group) q.grp = grp;
    report.templateGroups++;
  }
  report.accepted = accepted.length;
  return { items: accepted, report };
}

function buildPrivateBank(sourceFile, outputDir, repoRoot) {
  const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const sourceItems = Array.isArray(raw) ? raw : (raw.items || raw.extbank || []);
  const builtin = loadBuiltinQuestions(repoRoot);
  const { items, report } = sanitizeBank(sourceItems, builtin);
  const bySource = new Map();
  for (const q of items) {
    const source = q.src || '未標來源';
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(q);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const packs = [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-Hant')).map(([name, packItems], index) => {
    const file = sourceFileName(name, index);
    const envelope = { kind: 'qpack', name, version: 1, items: packItems };
    const json = `${JSON.stringify(envelope)}\n`;
    fs.writeFileSync(path.join(outputDir, file), json);
    return { id: `curated-${sha(name).slice(0, 16)}`, name, file, count: packItems.length, sha256: sha(json) };
  });
  const manifest = {
    schema: 1,
    visibility: 'authenticated',
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(sourceFile),
    report,
    packs,
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const positionals = [];
  let sourceFile = '';
  let outputDir = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') sourceFile = args[++i] || '';
    else if (args[i] === '--output') outputDir = args[++i] || '';
    else positionals.push(args[i]);
  }
  sourceFile ||= positionals[0] || '';
  outputDir ||= positionals[1] || '';
  if (!sourceFile || !outputDir) {
    console.error('Usage: node scripts/build-private-bank.js --source <source-qpack.json> --output <output-dir>');
    process.exit(2);
  }
  const manifest = buildPrivateBank(path.resolve(sourceFile), path.resolve(outputDir), path.resolve(__dirname, '..'));
  console.log(JSON.stringify(manifest, null, 2));
}

module.exports = { cleanText, normalizeQuestion, sanitizeBank, validateQuestion, buildPrivateBank };
