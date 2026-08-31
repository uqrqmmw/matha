'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TEXTBOOK_LIBRARY = require('../textbook-catalog');
const TRUSTED_CORPUS = TEXTBOOK_LIBRARY.trustedCorpus || {};

const TOPICS = new Set(['num', 'line', 'poly', 'seq', 'comb', 'prob', 'data', 'trig1', 'trig2', 'exp', 'vec', 'svec', 'splane', 'mat']);
/* 歷史製作工具曾使用 vec3/space；app 與 bank.js 的正式 14 單元鍵是
   svec/splane。匯入時只在這個邊界轉換，避免未來空間教材 build 成功後
   卻被前端 validateQ 靜默拒絕。 */
const TOPIC_ALIASES = Object.freeze({ vec3:'svec', space:'splane' });
const TYPES = new Set(['single', 'multi', 'fill']);
const OUT_OF_RANGE_RE = [/\\(?:cot|sec|csc)\b/, /(?:餘切|正割|餘割)\s*函數/, /十分逼近法/];
const SUSPICIOUS_HTML_RE = /<\s*(?:script|iframe|object|embed|style)\b|\bon\w+\s*=|javascript\s*:/i;
const VISUAL_REFERENCE_RE = /(?:如|由|見|依|根據)(?:下|上|左|右|附)?圖(?:所示|可知|中)?|(?:下|上|左|右|附)圖(?:所示|中)?|圖中|圖示(?:如下)?|示意圖|依圖作答|(?:左|右|上|下)(?:側|方)(?:的)?(?:函數|座標|坐標|幾何|統計)?(?:圖|圖形|圖像|座標平面|坐標平面)|(?:座標|坐標)平面(?:中|上)?(?:繪有|畫有|標有|標示|如下|如附).{0,12}(?:曲線|圖形|直線|圓|點)|(?:曲線|圖形|座標平面|坐標平面)(?:如下|如附|如右|如左|如上|如下方|如右側)|(?:根據|依據|參照|參考)(?:附|下|上|左|右)?表|(?:附|下|上|左|右)表(?:中|所示|可知)?/;
const QUESTION_ROLES = new Set(['example', 'chapter-end-easy', 'chapter-end-medium', 'chapter-end-hard', 'comprehensive-review', 'unclassified']);
const CATALOG_BOOKS = [...(TEXTBOOK_LIBRARY.books || []), ...(TEXTBOOK_LIBRARY.supplemental || [])];
const BOOK_BY_SOURCE = new Map(CATALOG_BOOKS.flatMap((book) => (book.sourceNames || []).map((name) => [name, book])));
const BOOK_BY_ID = new Map(CATALOG_BOOKS.map((book) => [book.id, book]));
const UNTRUSTED_REVIEWER_RE = /(?:draft|smoke|not[-_\s]*a[-_\s]*human|not[-_\s]*human|not[-_\s]*importable|qa[-_\s]*only|forced|unsigned)/i;
const RELEASE_NON_HUMAN_RE = /(?:claude|codex|chatgpt|gpt|gemini|agent|bot|automation|自動|模型|人工智慧|\bai\b)/i;
const OWNER_DELEGATED_POLICY = 'owner-delegated-agent-direct-pixel-v1';
/* 題庫是整批啟動時載入；若依每頁 src 分包，1,294 題會膨脹成近千個
   Storage 請求。以教材為單位、每包最多 64 題，保留可讀的教材邊界，
   同時把首次冷啟動縮成數十個內容位址化檔案。 */
const PRIVATE_PACK_MAX_ITEMS = 64;
/* 逐頁核對後確認：題文已把印刷表格的全部欄列與數值完整序列化，位置/顏色/合併格不影響解題。
   這是 build-time 信任清單；外部 qpack 自報 visualComplete 或仿造 evidence 都不會取得 curated trust。 */
const VERIFIED_TEXT_COMPLETE_IDS = new Set([
  'v-exp-log1-p055-ex18', 'v-exp-log1-p240-c4a', 'v-exp-log1-p240-c4b', 'v-exp-log1-p254-m1',
  'v-log2-p065-adv-single-3', 'v-log2-p126-ex39-a', 'v-log2-p126-ex39-b',
  'v-prob-ev-p124-multi1', 'v-prob-ev-p156-ex32', 'v-prob-ev-p159-ex36-a', 'v-prob-ev-p159-ex36-b',
  'v-prob-ev-p183-ex-c10-a', 'v-prob-ev-p183-ex-c10-b', 'v-prob-ev-p184-mix1-a', 'v-prob-ev-p184-mix1-b',
  'v-trig-basic-p067-advsingle3', 'v-trig-basic-p168-ex7',
]);

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

function canonicalTopic(value) {
  const topic = String(value || '').trim();
  return TOPIC_ALIASES[topic] || topic;
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

/* 短句「求 a 之值」不是題目身分；題幹、選項與答案不同就不可刪掉或共用學習記錄。 */
function questionSignature(q, maskNumbers, includeAnswer = true) {
  const norm = (value) => normalizeQuestion(value == null ? '' : value, maskNumbers);
  return JSON.stringify({
    type: String(q && q.type || ''),
    stem: norm(q && q.stem),
    q: norm(q && q.q),
    opts: Array.isArray(q && q.opts) ? q.opts.map(norm) : [],
    ans: includeAnswer && Array.isArray(q && q.ans) ? q.ans.map((value) => norm(value)) : [],
    fig: norm(q && q.fig),
    // Image-first textbook questions deliberately share a minimal index label.
    // Their trusted full-stem pixel hash is the question content identity; if it
    // is omitted, unrelated crops with the same final answer collapse as fake
    // duplicates during the private build.
    stemAssetSha256: String(q && q.stemAsset && q.stemAsset.sha256 || ''),
  });
}

function validateQuestion(q) {
  if (!q || typeof q.id !== 'string' || !q.id) return 'id-missing';
  if (!/^[\w.:-]+$/.test(q.id)) return 'id-invalid';
  if (['__proto__', 'constructor', 'prototype'].includes(q.id)) return 'id-reserved';
  if (!TOPICS.has(q.topic)) return 'topic-invalid';
  if (!TYPES.has(q.type)) return 'type-invalid';
  if (![1, 2, 3].includes(q.diff)) return 'difficulty-invalid';
  if (!q.q || typeof q.q !== 'string') return 'question-missing';
  if (q.q.length > 12000 || String(q.stem || '').length > 12000 || String(q.sol || '').length > 40000) return 'text-too-long';
  if (q.type === 'fill') {
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => typeof a !== 'string' && typeof a !== 'number')) return 'answer-invalid';
    if (q.ans.some((a) => String(a).length > 1000)) return 'answer-too-long';
  } else {
    if (!Array.isArray(q.opts) || q.opts.length < 2 || q.opts.some((o) => typeof o !== 'string' && typeof o !== 'number')) return 'options-invalid';
    if (q.opts.some((o) => String(o).length > 6000)) return 'options-too-long';
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some((a) => !Number.isInteger(a) || a < 0 || a >= q.opts.length)) return 'answer-invalid';
  }
  if (q.bookId != null && (typeof q.bookId !== 'string' || !/^[\w.-]+$/.test(q.bookId))) return 'book-id-invalid';
  if (q.page != null && (!Number.isInteger(Number(q.page)) || Number(q.page) < 1)) return 'page-invalid';
  if (q.role != null && !QUESTION_ROLES.has(q.role)) return 'role-invalid';
  if (q.stemAsset != null && !verifiedStemAsset(q)) return 'stem-asset-unverified';
  if (q.figureAsset != null && !verifiedFigureAsset(q)) return 'figure-asset-unverified';
  if (q.visualEvidence != null && !verifiedVisualEvidence(q)) return 'visual-evidence-unverified';
  for (const key of ['skills', 'methods', 'prerequisites']) {
    if (q[key] != null && (!Array.isArray(q[key]) || q[key].some((value) => typeof value !== 'string'))) return `${key}-invalid`;
  }
  return null;
}

function verifiedVisualEvidence(q) {
  const evidence = q && q.visualEvidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const book = q && BOOK_BY_ID.get(q.bookId);
  return evidence.status === 'verified-text-complete'
    && evidence.questionId === q.id && evidence.bookId === q.bookId
    && Number(evidence.pageIndex) === Number(q.page)
    && !!book && evidence.sourcePdfSha256 === book.pdfSha256
    && Number(evidence.reviewVersion) >= 1 && evidence.reviewer === 'independent-visual-audit'
    && typeof evidence.verifiedAt === 'string' ? evidence : null;
}

function verifiedQuestionImageAsset(q, asset, role) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return null;
  const book = q && BOOK_BY_ID.get(q.bookId);
  const safePath = typeof asset.path === 'string' && asset.path.length <= 240
    && !asset.path.startsWith('/') && !asset.path.includes('..') && /^[\w./-]+\.(?:png|webp|jpe?g)$/i.test(asset.path);
  const safeHashes = /^[a-f0-9]{64}$/.test(String(asset.sha256 || '')) && /^[a-f0-9]{64}$/.test(String(asset.sourcePdfSha256 || ''));
  const box = Array.isArray(asset.bbox) ? asset.bbox.map(Number) : [];
  const safeBox = box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && box[2] >= .01 && box[3] >= .01 && box[0] + box[2] <= 1.000001 && box[1] + box[3] <= 1.000001;
  const page = Number(asset.pageIndex);
  const verifier = asset.verifier;
  const safeRendition = ['image/webp', 'image/png', 'image/jpeg'].includes(asset.mime)
    && Number.isInteger(Number(asset.width)) && Number(asset.width) >= 80
    && Number.isInteger(Number(asset.height)) && Number(asset.height) >= 80;
  const boundToQuestion = Array.isArray(asset.questionIds) && asset.questionIds.includes(q.id)
    && asset.bookId === q.bookId && page === Number(q.page)
    && !!book && book.pdfSha256 === asset.sourcePdfSha256;
  const independentlyReviewed = typeof asset.producer === 'string' && asset.producer.length >= 3
    && verifier && Number(verifier.reviewVersion) >= 1
    && typeof verifier.reviewer === 'string' && verifier.reviewer.length >= 3 && verifier.reviewer !== asset.producer
    && verifier.questionRoleVerified === true && verifier.safetyVerified === true && verifier.assetHashVerified === true
    && typeof verifier.verifiedAt === 'string';
  const stemCoverage = role !== 'question-stem' || (verifier.fullStemVerified === true
    && (q.type === 'fill' || (asset.includesOptions === true && verifier.optionsVerified === true)));
  return asset.assetStatus === 'verified' && asset.role === role
    && asset.containsAnswer === false && asset.containsSolution === false && asset.containsHandwriting === false
    && safePath && safeHashes && safeBox && safeRendition && boundToQuestion && independentlyReviewed && stemCoverage
    && Number.isInteger(page) && page >= 1 ? asset : null;
}
function verifiedStemAsset(q) { return verifiedQuestionImageAsset(q, q && q.stemAsset, 'question-stem'); }
function verifiedFigureAsset(q) { return verifiedQuestionImageAsset(q, q && q.figureAsset, 'question-figure'); }

function questionMissingVisualAsset(q) {
  if (!q) return false;
  if (verifiedStemAsset(q) || verifiedFigureAsset(q) || verifiedVisualEvidence(q)) return false;
  if (q.needsStemAsset || q.displayTruth === 'original-pdf-crop') return true;
  if (q.needsFigure) return true;
  const stem = `${String(q.stem || '')}\n${String(q.q || '')}`.replace(/<[^>]+>/g, ' ');
  return VISUAL_REFERENCE_RE.test(stem);
}

function sanitizeQuestion(input) {
  const q = { ...input };
  for (const key of ['q', 'stem', 'sol', 'tip', 'src', 'bookId', 'bookTitle', 'chapterId', 'sectionId', 'role', 'canonicalProblemId', 'variantGroup']) if (typeof q[key] === 'string') q[key] = cleanText(q[key]);
  if (q.stemAsset && typeof q.stemAsset === 'object' && !Array.isArray(q.stemAsset)) q.stemAsset = { ...q.stemAsset };
  if (q.figureAsset && typeof q.figureAsset === 'object' && !Array.isArray(q.figureAsset)) q.figureAsset = { ...q.figureAsset };
  if (q.visualEvidence && typeof q.visualEvidence === 'object' && !Array.isArray(q.visualEvidence)) q.visualEvidence = { ...q.visualEvidence };
  if (Array.isArray(q.opts)) q.opts = q.opts.map((v) => typeof v === 'string' ? cleanText(v) : v);
  if (Array.isArray(q.ans)) q.ans = q.ans.map((v) => typeof v === 'string' ? cleanText(v) : v);
  for (const key of ['skills', 'methods', 'prerequisites']) if (Array.isArray(q[key])) q[key] = q[key].map(cleanText).filter(Boolean);
  return q;
}

function untrustedReviewSource(raw) {
  if (!raw || raw.kind !== 'private-question-source') return '';
  const reviewer = String(raw.reviewedBy || raw.reviewer || '').trim();
  if (!reviewer) return 'reviewer-missing';
  if (UNTRUSTED_REVIEWER_RE.test(reviewer)) return 'reviewer-not-human-signoff';
  const sourceItems = Array.isArray(raw.questions) ? raw.questions
    : Array.isArray(raw.items) ? raw.items
      : Array.isArray(raw.extbank) ? raw.extbank : [];
  if (sourceItems.some((q) => q && typeof q === 'object' && q.draftedBy && !q.reviewedBy && !q.reviewedAt)) return 'draft-markers-present';
  return '';
}

function namedHumanRelease(raw, trustBlockReason) {
  return !trustBlockReason && typeof raw.releaseApprovedBy === 'string'
    && raw.releaseApprovedBy.trim().length >= 3 && !UNTRUSTED_REVIEWER_RE.test(raw.releaseApprovedBy)
    && !RELEASE_NON_HUMAN_RE.test(raw.releaseApprovedBy)
    && (!raw.reviewPolicy || raw.reviewPolicy === 'named-human-dual-review-v1');
}

function ownerDelegatedRelease(raw, trustBlockReason) {
  if (trustBlockReason || raw.reviewPolicy !== OWNER_DELEGATED_POLICY) return false;
  const approval = raw.releaseApproval || {}, audit = raw.reviewAudit || {};
  const owner = String(raw.releaseApprovedBy || '').trim();
  const reviewer = String(approval.performedBy || '').trim();
  const version = Number(approval.version);
  const approvalHashes = Array.isArray(approval.delegatedReviewSha256)
    ? approval.delegatedReviewSha256 : [approval.delegatedReviewSha256];
  const validHashChain = (version === 1 && approvalHashes.length === 1)
    || (version === 2 && approvalHashes.length >= 2);
  return approval.kind === 'owner-delegated-agent-starter-private-release-signoff'
    && validHashChain && approval.authorizedBy === owner
    && owner.length >= 3 && !RELEASE_NON_HUMAN_RE.test(owner)
    && reviewer.length >= 3 && RELEASE_NON_HUMAN_RE.test(reviewer)
    && approval.humanPixelReviewClaimed === false
    && approvalHashes.every((value) => /^[a-f0-9]{64}$/.test(String(value || '')))
    && Array.isArray(audit.directReviewSha256)
    && audit.directReviewSha256.length === approvalHashes.length
    && audit.directReviewSha256.every((value, index) => value === approvalHashes[index])
    && /^[a-f0-9]{64}$/.test(String(approval.unsignedSourceSha256 || ''))
    && /^[a-f0-9]{64}$/.test(String(approval.assetManifestSha256 || ''))
    && Array.isArray(approval.sampleQuestionIds) && approval.sampleQuestionIds.length > 0;
}

function enrichQuestionMetadata(input) {
  const q = { ...input };
  q.topic = canonicalTopic(q.topic);
  const book = BOOK_BY_SOURCE.get(q.src);
  const page = String(q.id || '').match(/-p0*(\d+)/i);
  const sourceId = String(q.id || '');
  const isExample = /-ex[a-z]*\d/i.test(sourceId);
  const isAdvanced = /-adv(?:-|$)/i.test(sourceId);
  const isFoundation = /-(?:basic|base)(?:-|$)/i.test(sourceId);
  if (book) {
    q.bookId ||= book.id;
    q.bookTitle ||= book.title;
    q.edition ||= '114';
  }
  q.chapterId ||= q.topic;
  if (q.page == null && page) q.page = Number(page[1]);
  /* 教材實頁核對：ex 是例題、adv 是「進階試題演練」、basic/base 是明示的
     基礎區；s/m/f/c 是題型代碼，絕不可猜成難度。沒有頁面證據的題保留
     unclassified，仍用原始 diff 排序，不讓錯誤 metadata 污染推薦。 */
  q.role ||= isExample ? 'example'
    : isAdvanced ? 'chapter-end-hard'
      : isFoundation ? 'chapter-end-easy' : 'unclassified';
  q.sectionLevel ||= isExample ? 'example'
    : isAdvanced ? 'advanced'
      : isFoundation ? 'foundation' : 'unverified';
  q.roleProvenance ||= q.role === 'unclassified' ? 'awaiting-page-verification' : 'printed-section-id';
  q.sourceDifficulty ??= q.diff;
  q.difficultyProvenance ||= 'legacy-curation';
  q.canonicalProblemId ||= `problem-${sha(questionSignature(q, false, true)).slice(0, 20)}`;
  q.estimatedMinutes ??= ({ 1:2, 2:4, 3:7 }[q.diff] || 4);
  if (VERIFIED_TEXT_COMPLETE_IDS.has(q.id) && book && q.page) {
    q.visualEvidence = {
      status:'verified-text-complete', questionId:q.id, bookId:q.bookId, sourcePdfSha256:book.pdfSha256,
      pageIndex:Number(q.page), reviewVersion:1, reviewer:'independent-visual-audit', verifiedAt:'2026-08-25T00:00:00+08:00',
    };
  }
  q.visibility = 'private';
  return q;
}

function loadBuiltinQuestions(repoRoot) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'bank.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'practice-bank.js'), 'utf8'), context);
  return vm.runInContext('BANK', context);
}

function sourceFileName(source, index, contentHash) {
  const hint = String(source || 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 28) || 'pack';
  return `${String(index + 1).padStart(2, '0')}-${hint}-${sha(source || 'unknown').slice(0, 8)}-${String(contentHash || '').slice(0, 10)}.json`;
}

function sanitizeBank(items, builtinQuestions) {
  const report = {
    sourceTotal: items.length,
    accepted: 0,
    skipped: { schema: 0, missingStem: 0, missingFigure: 0, visualReferenceMissing: 0, outOfRange: 0, suspiciousHtml: 0, duplicateId: 0, duplicateBuiltin: 0, duplicateLegacy: 0, untrustedReview: 0 },
    emojiCleaned: 0,
    templateGroups: 0,
    visual: { pending: 0, verified: 0, textComplete: 0 },
  };
  const ids = new Set();
  const builtinText = new Set((builtinQuestions || []).map((q) => questionSignature(q, false, true)).filter(Boolean));
  const legacyText = new Set();
  const accepted = [];
  const pendingVisuals = [];

  for (const original of items) {
    // 掃描面涵蓋所有會被前端渲染的欄位：ans（fill 正解會進 innerHTML）、src、fig/solFig（SVG）不能漏
    const joined = [original && original.q, original && original.stem, original && original.sol, original && original.tip, original && original.src, original && original.fig, original && original.solFig, ...((original && original.opts) || []), ...((original && Array.isArray(original.ans) ? original.ans : []))]
      .filter((v) => typeof v === 'string').join('\n');
    if (/\p{Extended_Pictographic}/u.test(joined)) report.emojiCleaned++;
    const q = enrichQuestionMetadata(sanitizeQuestion(original || {}));
    const visualMissing = questionMissingVisualAsset(q);
    const schemaError = validateQuestion(q);
    /* 未附圖的題目仍是完整的待辦資料，不因尚未產生 asset 而算 schema 壞題。 */
    if (schemaError && !(visualMissing && schemaError === 'figure-asset-unverified')) { report.skipped.schema++; continue; }
    if (ids.has(q.id)) { report.skipped.duplicateId++; continue; }
    ids.add(q.id);
    if (OUT_OF_RANGE_RE.some((re) => re.test(q.q))) { report.skipped.outOfRange++; continue; }
    if (SUSPICIOUS_HTML_RE.test(joined)) { report.skipped.suspiciousHtml++; continue; }
    const exact = questionSignature(q, false, true);
    if (builtinText.has(exact)) { report.skipped.duplicateBuiltin++; continue; }
    if (legacyText.has(exact)) { report.skipped.duplicateLegacy++; continue; }
    legacyText.add(exact);
    if (visualMissing) {
      q.visualStatus = 'pending-asset-qa';
      q.visualPendingReason = q.needsStemAsset || q.displayTruth === 'original-pdf-crop'
        ? 'missing-verified-original-stem-crop'
        : q.needsFigure && !q.fig ? 'missing-explicit-figure' : 'visual-reference-without-verified-asset';
      pendingVisuals.push(q);
      report.visual.pending++;
      if (q.needsStemAsset || q.displayTruth === 'original-pdf-crop') report.skipped.missingStem++;
      else if (q.needsFigure && !q.fig) report.skipped.missingFigure++;
      else report.skipped.visualReferenceMissing++;
      continue;
    }
    if (verifiedFigureAsset(q)) report.visual.verified++;
    if (verifiedVisualEvidence(q)) report.visual.textComplete++;
    accepted.push(q);
  }

  const fingerprints = new Map();
  for (const q of accepted) {
    const fp = questionSignature(q, true, false);
    if (!fingerprints.has(fp)) fingerprints.set(fp, []);
    fingerprints.get(fp).push(q);
  }
  for (const group of fingerprints.values()) {
    if (group.length < 2) continue;
    const grp = `legacy-${sha(questionSignature(group[0], true, false)).slice(0, 14)}`;
    for (const q of group) { q.grp = grp; q.variantGroup ||= grp; }
    report.templateGroups++;
  }
  for (const q of accepted) if (q.grp && !q.variantGroup) q.variantGroup = q.grp;
  report.accepted = accepted.length;
  return { items: accepted, pendingVisuals, report };
}

function buildPrivateBank(sourceFile, outputDir, repoRoot) {
  const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const sourceItems = Array.isArray(raw) ? raw : (raw.items || raw.extbank || raw.questions || []);
  const builtin = loadBuiltinQuestions(repoRoot);
  const trustBlockReason = untrustedReviewSource(raw);
  const { items, pendingVisuals, report } = trustBlockReason
    ? (() => {
      const blocked = sanitizeBank([], builtin);
      blocked.report.sourceTotal = sourceItems.length;
      blocked.report.skipped.untrustedReview = sourceItems.length;
      blocked.report.trustBlockReason = trustBlockReason;
      return blocked;
    })()
    : sanitizeBank(sourceItems, builtin);
  const byBook = new Map();
  for (const q of items) {
    const key = q.bookId || `source-${sha(q.src || '未標來源').slice(0, 16)}`;
    if (!byBook.has(key)) byBook.set(key, {
      name: q.bookTitle || q.src || q.bookId || '未標來源',
      items: [],
    });
    byBook.get(key).items.push(q);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const packs = [];
  for (const [bookKey, group] of [...byBook.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const chunkCount = Math.ceil(group.items.length / PRIVATE_PACK_MAX_ITEMS);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const packItems = group.items.slice(
        chunkIndex * PRIVATE_PACK_MAX_ITEMS,
        (chunkIndex + 1) * PRIVATE_PACK_MAX_ITEMS,
      );
      const name = chunkCount > 1 ? `${group.name}（${chunkIndex + 1}/${chunkCount}）` : group.name;
      const envelope = { kind: 'qpack', name, version: 2, items: packItems };
      const json = `${JSON.stringify(envelope)}\n`;
      const digest = sha(json);
      const file = sourceFileName(`${bookKey}-${chunkIndex + 1}`, packs.length, digest);
      fs.writeFileSync(path.join(outputDir, file), json);
      packs.push({
        id: `curated-${sha(`${bookKey}#${chunkIndex + 1}`).slice(0, 16)}`,
        name, file, count: packItems.length, sha256: digest,
      });
    }
  }
  const generatedAt = new Date().toISOString();
  const corpusGeneration = String(raw.corpusGeneration || 'legacy-unverified');
  const sourceInventorySha256 = String(raw.sourceInventorySha256 || '');
  const verificationPolicy = String(raw.verificationPolicy || '');
  const reviewAudit = raw.reviewAudit && typeof raw.reviewAudit === 'object' ? raw.reviewAudit : {};
  const releaseAuthorized = namedHumanRelease(raw, trustBlockReason)
    || ownerDelegatedRelease(raw, trustBlockReason);
  const releaseChecks = {
    corpusGeneration: corpusGeneration === TRUSTED_CORPUS.generation,
    sourceInventory: sourceInventorySha256 === TRUSTED_CORPUS.sourceInventorySha256,
    sourceDocuments: Number(raw.sourceDocuments) === Number(TRUSTED_CORPUS.sourceDocuments),
    sourcePages: Number(raw.sourcePages) === Number(TRUSTED_CORPUS.sourcePages),
    ocrProvider: raw.ocrProvider === TRUSTED_CORPUS.ocrProvider,
    ocrModel: raw.ocrModel === TRUSTED_CORPUS.ocrModel,
    verificationPolicy: verificationPolicy === TRUSTED_CORPUS.verificationPolicy,
    originalPdfVerified: raw.originalPdfVerified === true,
    answerKeyVerified: raw.answerKeyVerified === true,
    mathematicalCorrectnessVerified: raw.mathematicalCorrectnessVerified === true,
    questionProvenance: items.length > 0 && items.every((q) => BOOK_BY_ID.has(q.bookId)
      && Number.isInteger(Number(q.page)) && Number(q.page) >= 1 && typeof q.src === 'string' && q.src.trim()),
    originalStemAssets: items.length > 0 && items.every((q) => q.displayTruth === 'original-pdf-crop'
      && !!verifiedStemAsset(q)),
    noPendingVisuals: pendingVisuals.length === 0 && items.length === sourceItems.length,
    reviewAudit: Number(reviewAudit.sourceQuestionCount) === sourceItems.length
      && Number(reviewAudit.approvedQuestionCount) === items.length + pendingVisuals.length
      && typeof reviewAudit.completedAt === 'string' && !Number.isNaN(Date.parse(reviewAudit.completedAt)),
    releaseAuthorization: releaseAuthorized,
  };
  const releaseReady = Object.values(releaseChecks).every(Boolean);
  const pendingVisualEnvelope = {
    kind: 'pending-visual-queue', version: 1, generatedAt, count: pendingVisuals.length, items: pendingVisuals,
  };
  const pendingVisualJson = `${JSON.stringify(pendingVisualEnvelope, null, 2)}\n`;
  const manifest = {
    schema: 3,
    visibility: 'authenticated',
    generatedAt,
    corpusGeneration,
    sourceInventorySha256,
    sourceDocuments: Number(raw.sourceDocuments) || 0,
    sourcePages: Number(raw.sourcePages) || 0,
    ocrProvider: String(raw.ocrProvider || ''),
    ocrModel: String(raw.ocrModel || ''),
    verificationPolicy,
    reviewPolicy: String(raw.reviewPolicy || 'named-human-dual-review-v1'),
    mathematicalCorrectnessVerified: raw.mathematicalCorrectnessVerified === true,
    releaseReady,
    releaseChecks,
    releaseApprovedBy: releaseReady ? raw.releaseApprovedBy : null,
    releaseApproval: releaseReady && raw.releaseApproval && typeof raw.releaseApproval === 'object'
      ? raw.releaseApproval : null,
    sourceFile: path.basename(sourceFile),
    sourceSha256: sha(fs.readFileSync(sourceFile)),
    report,
    library: {
      schema: TEXTBOOK_LIBRARY.schema,
      verifiedBooks: TEXTBOOK_LIBRARY.verifiedCount,
      readyBooks: TEXTBOOK_LIBRARY.books.filter((book) => book.ingestion === 'released').length,
      pendingBooks: TEXTBOOK_LIBRARY.books.filter((book) => book.ingestion !== 'released').length,
    },
    pendingVisuals: { file: 'pending-visuals.json', count: pendingVisuals.length, sha256: sha(pendingVisualJson) },
    packStrategy: { kind: 'book-chunks-v1', maxItems: PRIVATE_PACK_MAX_ITEMS },
    packs,
  };
  /* 待補圖檔是私有製作佇列，不上 GitHub Pages；缺圖題逐題可追，不再被粗暴省略。 */
  fs.writeFileSync(path.join(outputDir, 'pending-visuals.json'), pendingVisualJson);
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

module.exports = { cleanText, canonicalTopic, normalizeQuestion, questionSignature, sanitizeBank, validateQuestion, verifiedStemAsset, verifiedFigureAsset, verifiedVisualEvidence, questionMissingVisualAsset, enrichQuestionMetadata, untrustedReviewSource, namedHumanRelease, ownerDelegatedRelease, buildPrivateBank };
