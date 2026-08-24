'use strict';

/*
 * Convert a crop batch into student-facing figureAsset metadata only after a
 * separate reviewer has passed every promoted asset. This tool never uploads.
 * Both the enhanced private question source and upload-ready image directory
 * must live outside the public Git repository.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const TEXTBOOK_LIBRARY = require('../textbook-catalog');
const { enrichQuestionMetadata, validateQuestion, verifiedFigureAsset } = require('./build-private-bank');
const { assertPrivateOutput, isInside, pngDimensions } = require('./prepare-figure-review');

const REPO_ROOT = path.resolve(__dirname, '..');
const BOOKS = new Map(TEXTBOOK_LIBRARY.books.map((book) => [book.id, book]));

function shaFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeRelative(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('..')) {
    throw new Error(`Unsafe ${label}: ${String(relative)}`);
  }
  const resolved = path.resolve(root, relative);
  if (!isInside(root, resolved)) throw new Error(`${label} escapes its private root`);
  return resolved;
}

function normalizedBBox(box) {
  const values = ['x', 'y', 'width', 'height', 'pageWidth', 'pageHeight'].map((key) => Number(box && box[key]));
  if (!values.every(Number.isInteger)) throw new Error('Crop bbox must use integer rendered-page pixels');
  const [x, y, width, height, pageWidth, pageHeight] = values;
  if (x < 0 || y < 0 || width < 80 || height < 80 || pageWidth < width || pageHeight < height
    || x + width > pageWidth || y + height > pageHeight
    || box.coordinateSpace !== 'rendered-page-px' || !Number.isInteger(Number(box.renderedPageDpi))) {
    throw new Error('Crop bbox is outside the verified source page');
  }
  const clean = (value) => Number(value.toFixed(9));
  return [clean(x / pageWidth), clean(y / pageHeight), clean(width / pageWidth), clean(height / pageHeight)];
}

function reviewMap(review) {
  if (!review || review.kind !== 'matha-private-figure-independent-review' || Number(review.version) !== 1
    || typeof review.reviewer !== 'string' || review.reviewer.length < 3 || typeof review.reviewedAt !== 'string'
    || !Array.isArray(review.assets)) throw new Error('Independent review file is invalid');
  const requiredIntegrity = ['pdfSha256MatchesManifest', 'cropSha256MatchesManifest', 'sourcePageSha256MatchesManifest',
    'cropDimensionsMatchManifest', 'sourcePageDimensionsMatchManifest', 'bboxWithinSourcePage',
    'cropPixelsExactlyMatchSourceAtBbox'];
  const legacyQuestionBinding = review.integrity
    && (review.integrity.questionIdsMatchPendingQueue === true
      || review.integrity.questionIdsMatchCandidateGroupsAndPendingQueue === true);
  const legacyIntegrity = review.integrity && legacyQuestionBinding
    && requiredIntegrity.every((key) => review.integrity[key] === true);
  const modernIntegrity = review.decision === 'pass' && review.inputIntegrity
    && ['candidateManifestSha256Matches', 'reviewManifestSha256Matches', 'manifestAssetCountMatches',
      'manifestQuestionCountMatches'].every((key) => review.inputIntegrity[key] === true)
    && review.assets.every((row) => row && row.integrity && row.visual
      && ['pdfSha', 'sourcePageSha', 'cropSha', 'candidateSha', 'dimensions', 'bbox', 'pixelEquality',
        'bookPageQuestionIds'].every((key) => row.integrity[key] === true)
      && row.visual.completeFigureAndLabels === true && row.visual.containsAnswer === false
      && row.visual.containsSolution === false && row.visual.containsHandwriting === false
      && row.visual.containsAdjacentQuestion === false && row.visual.containsUnnecessaryQuestionText === false);
  if (!legacyIntegrity && !modernIntegrity) {
    throw new Error('Independent review did not pass every integrity gate');
  }
  const out = new Map();
  for (const row of review.assets) {
    if (!row || typeof row.groupId !== 'string' || out.has(row.groupId)) throw new Error('Independent review has a duplicate/invalid group');
    out.set(row.groupId, row);
  }
  return out;
}

function promoteReviewedFigures(options) {
  const sourceFile = path.resolve(options.sourceFile);
  const batchFile = path.resolve(options.batchFile);
  const reviewFile = path.resolve(options.reviewFile);
  const assetRoot = path.resolve(options.assetRoot || path.dirname(batchFile));
  const outputDir = path.resolve(options.outputDir);
  assertPrivateOutput(outputDir);
  if (isInside(REPO_ROOT, sourceFile) || isInside(REPO_ROOT, batchFile) || isInside(REPO_ROOT, reviewFile)) {
    throw new Error('Copyrighted source and review records must remain outside the public repository');
  }

  const raw = readJson(sourceFile);
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : Array.isArray(raw.extbank) ? raw.extbank : null);
  if (!items) throw new Error('Private source has no question array');
  const byId = new Map(items.map((question) => [question && question.id, question]));
  if (byId.size !== items.length) throw new Error('Private source has missing or duplicate question ids');

  const batch = readJson(batchFile);
  if (!batch || batch.kind !== 'matha-private-figure-review-batch' || Number(batch.version) !== 1 || !Array.isArray(batch.assets)) {
    throw new Error('Crop batch manifest is invalid');
  }
  const independent = readJson(reviewFile);
  const passed = reviewMap(independent);
  const passedCount = Number(independent.summary && (independent.summary.passed ?? independent.summary.passedAssets));
  const failedCount = Number(independent.summary && (independent.summary.failed ?? independent.summary.failedAssets));
  if (passed.size !== batch.assets.length || failedCount !== 0 || passedCount !== batch.assets.length) {
    throw new Error('Independent review does not cover the complete crop batch');
  }

  const uploadRoot = path.join(outputDir, 'figure-assets');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const promotedQuestions = new Set();
  const promotedAssets = [];

  for (const asset of batch.assets) {
    const reviewRow = passed.get(asset && asset.groupId);
    if (!reviewRow || reviewRow.passed !== true) throw new Error(`Independent review rejected ${asset && asset.groupId}`);
    const producer = asset.reviewEvidence && asset.reviewEvidence.reviewer;
    if (typeof producer !== 'string' || producer.length < 3 || producer === independent.reviewer
      || asset.reviewEvidence.sourcePageInspected !== true || asset.reviewEvidence.cropInspected !== true) {
      throw new Error(`Asset ${asset.groupId} lacks a distinct crop producer and reviewer`);
    }
    const safety = asset.safety || {};
    // Producer batches may deliberately remain `verified:false` until the
    // independent reviewer finishes. `firstPassPassed:true` is the producer's
    // content gate; the independent review below is what authorizes promotion.
    const producerSafetyPassed = safety.verified === true || safety.firstPassPassed === true;
    if (!producerSafetyPassed || safety.onlyNecessaryFigure !== true || safety.containsAnswer !== false
      || safety.containsSolution !== false || safety.containsHandwriting !== false
      || safety.containsAdjacentQuestion !== false || safety.containsQuestionText !== false) {
      throw new Error(`Asset ${asset.groupId} did not pass the content safety gates`);
    }
    if (!Array.isArray(asset.questionIds) || !asset.questionIds.length || asset.questionIds.some((id) => promotedQuestions.has(id))) {
      throw new Error(`Asset ${asset.groupId} has missing or duplicate question bindings`);
    }
    const book = BOOKS.get(asset.bookId);
    if (!book || book.pdfSha256 !== asset.pdfSha256) throw new Error(`Asset ${asset.groupId} has an untrusted source PDF`);

    const cropFile = safeRelative(assetRoot, asset.relativePath, 'crop path');
    const sourcePageFile = safeRelative(assetRoot, asset.sourceRenderedPage, 'source page path');
    if (!fs.existsSync(cropFile) || !fs.existsSync(sourcePageFile)) throw new Error(`Asset ${asset.groupId} is missing its crop/source page`);
    if (shaFile(cropFile) !== asset.sha256 || shaFile(sourcePageFile) !== asset.sourcePageSha256) {
      throw new Error(`Asset ${asset.groupId} failed SHA-256 verification`);
    }
    const cropDimensions = pngDimensions(cropFile);
    const pageDimensions = pngDimensions(sourcePageFile);
    if (cropDimensions.width !== Number(asset.dimensions && asset.dimensions.width)
      || cropDimensions.height !== Number(asset.dimensions && asset.dimensions.height)
      || pageDimensions.width !== Number(asset.bbox && asset.bbox.pageWidth)
      || pageDimensions.height !== Number(asset.bbox && asset.bbox.pageHeight)) {
      throw new Error(`Asset ${asset.groupId} dimensions do not match the manifest`);
    }
    const bbox = normalizedBBox(asset.bbox);
    const extension = asset.mime === 'image/png' ? 'png' : null;
    if (!extension) throw new Error(`Asset ${asset.groupId} has an unsupported reviewed rendition`);
    const storagePath = `${asset.bookId}/${asset.groupId}-${asset.sha256.slice(0, 16)}.${extension}`;
    const outputFile = safeRelative(uploadRoot, storagePath, 'upload asset path');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.copyFileSync(cropFile, outputFile);
    if (shaFile(outputFile) !== asset.sha256) throw new Error(`Copied asset ${asset.groupId} changed during promotion`);

    const figureAsset = {
      path:storagePath,
      sha256:asset.sha256,
      sourcePdfSha256:asset.pdfSha256,
      pageIndex:Number(asset.page),
      bbox,
      role:'question-figure',
      assetStatus:'verified',
      mime:asset.mime,
      width:cropDimensions.width,
      height:cropDimensions.height,
      containsAnswer:false,
      containsSolution:false,
      containsHandwriting:false,
      questionIds:[...asset.questionIds],
      bookId:asset.bookId,
      producer,
      verifier:{
        reviewer:independent.reviewer,
        reviewVersion:1,
        questionRoleVerified:true,
        safetyVerified:true,
        assetHashVerified:true,
        verifiedAt:independent.reviewedAt,
      },
    };

    for (const questionId of asset.questionIds) {
      const original = byId.get(questionId);
      if (!original) throw new Error(`Asset ${asset.groupId} references absent question ${questionId}`);
      const enriched = enrichQuestionMetadata(original);
      if (enriched.bookId !== asset.bookId || Number(enriched.page) !== Number(asset.page)) {
        throw new Error(`Asset ${asset.groupId} is bound to the wrong book/page for ${questionId}`);
      }
      const updated = { ...original, figureAsset };
      delete updated.visualStatus;
      delete updated.visualPendingReason;
      if (validateQuestion(enrichQuestionMetadata(updated)) || !verifiedFigureAsset(enrichQuestionMetadata(updated))) {
        throw new Error(`Promoted figureAsset failed the private-bank schema for ${questionId}`);
      }
      byId.set(questionId, updated);
      promotedQuestions.add(questionId);
    }
    promotedAssets.push({
      groupId:asset.groupId,
      questionIds:[...asset.questionIds],
      storagePath,
      sha256:asset.sha256,
      sourcePdfSha256:asset.pdfSha256,
      independentReviewer:independent.reviewer,
      verifiedAt:independent.reviewedAt,
    });
  }

  const updatedItems = items.map((question) => byId.get(question.id));
  const outputSource = Array.isArray(raw) ? updatedItems
    : Array.isArray(raw.items) ? { ...raw, items:updatedItems }
      : { ...raw, extbank:updatedItems };
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceOutput = path.join(outputDir, 'source-with-reviewed-figures.json');
  fs.writeFileSync(sourceOutput, `${JSON.stringify(outputSource, null, 2)}\n`);
  const promotion = {
    kind:'matha-private-figure-promotion',
    version:1,
    generatedAt:new Date().toISOString(),
    uploadPerformed:false,
    sourceFile:path.basename(sourceFile),
    sourceSha256:shaFile(sourceFile),
    batchFile:path.basename(batchFile),
    batchSha256:shaFile(batchFile),
    independentReviewFile:path.basename(reviewFile),
    independentReviewSha256:shaFile(reviewFile),
    summary:{ assets:promotedAssets.length, questions:promotedQuestions.size },
    assets:promotedAssets,
  };
  fs.writeFileSync(path.join(outputDir, 'promotion-manifest.json'), `${JSON.stringify(promotion, null, 2)}\n`);
  return { promotion, sourceOutput, uploadRoot };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    if (args[index] === '--source') { options.sourceFile = value; index++; }
    else if (args[index] === '--batch') { options.batchFile = value; index++; }
    else if (args[index] === '--review') { options.reviewFile = value; index++; }
    else if (args[index] === '--asset-root') { options.assetRoot = value; index++; }
    else if (args[index] === '--output') { options.outputDir = value; index++; }
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!options.sourceFile || !options.batchFile || !options.reviewFile || !options.outputDir) {
    throw new Error('Usage: node scripts/promote-reviewed-figures.js --source <private questions.json> --batch <crop manifest.json> --review <independent-review.json> --output <private dir> [--asset-root <batch dir>]');
  }
  return options;
}

if (require.main === module) {
  try {
    const result = promoteReviewedFigures(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ...result.promotion.summary, sourceOutput:result.sourceOutput, uploadRoot:result.uploadRoot }, null, 2));
  } catch (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { normalizedBBox, parseArgs, promoteReviewedFigures, reviewMap, safeRelative };
