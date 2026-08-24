'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promoteReviewedFigures } = require('../scripts/promote-reviewed-figures');
const { verifiedFigureAsset } = require('../scripts/build-private-bank');

function png(file, width, height) {
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, header);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-promote-'));
  const sourceFile = path.join(root, 'source.json');
  const batchFile = path.join(root, 'manifest.json');
  const reviewFile = path.join(root, 'independent-review.json');
  const cropFile = path.join(root, 'crops', 'figure.png');
  const pageFile = path.join(root, 'pages', 'page-031.png');
  const outputDir = path.join(root, 'output');
  png(cropFile, 200, 120);
  png(pageFile, 1000, 1400);
  fs.writeFileSync(sourceFile, `${JSON.stringify([{ id:'v-cramer-circle-p31-ex40', topic:'line', type:'fill', diff:2,
    q:'如右圖求值', ans:['1'], needsFigure:true, src:'114班·克拉瑪與圓線' }])}\n`);
  const batch = {
    kind:'matha-private-figure-review-batch', version:1,
    assets:[{
      groupId:'cramer-p031-ex40', questionIds:['v-cramer-circle-p31-ex40'], bookId:'matha-114-cramer-circle',
      pdfSha256:'92acde764f180e8974f14aef8a916ecb74e904284814f4e2bd0bc74e726fea1c', page:31,
      sourceRenderedPage:'pages/page-031.png', sourcePageSha256:sha(pageFile),
      bbox:{ x:100, y:200, width:200, height:120, pageWidth:1000, pageHeight:1400, coordinateSpace:'rendered-page-px', renderedPageDpi:180 },
      relativePath:'crops/figure.png', mime:'image/png', dimensions:{ width:200, height:120 }, sha256:sha(cropFile),
      safety:{ verified:false, firstPassPassed:true, onlyNecessaryFigure:true, containsQuestionText:false, containsAnswer:false,
        containsSolution:false, containsHandwriting:false, containsAdjacentQuestion:false },
      reviewEvidence:{ sourcePageInspected:true, cropInspected:true, reviewer:'crop-agent' },
    }],
  };
  const review = {
    kind:'matha-private-figure-independent-review', version:1, reviewer:'audit-agent', reviewedAt:'2026-08-25T00:00:00+08:00',
    summary:{ passed:1, failed:0 }, assets:[{ groupId:'cramer-p031-ex40', passed:true }],
    integrity:{ pdfSha256MatchesManifest:true, cropSha256MatchesManifest:true, sourcePageSha256MatchesManifest:true,
      cropDimensionsMatchManifest:true, sourcePageDimensionsMatchManifest:true, bboxWithinSourcePage:true,
      cropPixelsExactlyMatchSourceAtBbox:true, questionIdsMatchPendingQueue:true },
  };
  fs.writeFileSync(batchFile, JSON.stringify(batch));
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  return { root, sourceFile, batchFile, reviewFile, outputDir, batch, review };
}

test('只有雙人審核且雜湊、來源頁、題號全部一致的裁圖可 promotion', () => {
  const fx = fixture();
  const result = promoteReviewedFigures(fx);
  assert.deepEqual(result.promotion.summary, { assets:1, questions:1 });
  assert.equal(result.promotion.uploadPerformed, false);
  assert.equal(result.promotion.outputSourceSha256, sha(result.sourceOutput));
  const output = JSON.parse(fs.readFileSync(result.sourceOutput, 'utf8'));
  const asset = output[0].figureAsset;
  assert.equal(asset.producer, 'crop-agent');
  assert.equal(asset.verifier.reviewer, 'audit-agent');
  assert.deepEqual(asset.bbox, [.1, 0.142857143, .2, 0.085714286]);
  assert.equal(verifiedFigureAsset({ ...output[0], bookId:'matha-114-cramer-circle', page:31 }), asset);
  assert.equal(sha(path.join(result.uploadRoot, asset.path)), asset.sha256);
});

test('逐資產新版獨立審核格式也必須每項安全與完整性全數通過', () => {
  const fx = fixture();
  fx.review.decision = 'pass';
  fx.review.summary = { passedAssets:1, failedAssets:0 };
  fx.review.inputIntegrity = {
    candidateManifestSha256Matches:true, reviewManifestSha256Matches:true,
    manifestAssetCountMatches:true, manifestQuestionCountMatches:true,
  };
  fx.review.assets = [{
    groupId:'cramer-p031-ex40', passed:true,
    integrity:{ pdfSha:true, sourcePageSha:true, cropSha:true, candidateSha:true, dimensions:true,
      bbox:true, pixelEquality:true, bookPageQuestionIds:true },
    visual:{ completeFigureAndLabels:true, containsAnswer:false, containsSolution:false, containsHandwriting:false,
      containsAdjacentQuestion:false, containsUnnecessaryQuestionText:false },
  }];
  delete fx.review.integrity;
  fs.writeFileSync(fx.reviewFile, JSON.stringify(fx.review));
  assert.deepEqual(promoteReviewedFigures(fx).promotion.summary, { assets:1, questions:1 });

  const unsafe = fixture();
  unsafe.review.decision = 'pass';
  unsafe.review.summary = { passedAssets:1, failedAssets:0 };
  unsafe.review.inputIntegrity = fx.review.inputIntegrity;
  unsafe.review.assets = JSON.parse(JSON.stringify(fx.review.assets));
  unsafe.review.assets[0].visual.containsAnswer = true;
  delete unsafe.review.integrity;
  fs.writeFileSync(unsafe.reviewFile, JSON.stringify(unsafe.review));
  assert.throws(() => promoteReviewedFigures(unsafe), /integrity gate/);
});

test('獨立審核可用較明確的題號綁定欄位名稱，但其他完整性門檻不放寬', () => {
  const fx = fixture();
  delete fx.review.integrity.questionIdsMatchPendingQueue;
  fx.review.integrity.questionIdsMatchCandidateGroupsAndPendingQueue = true;
  fs.writeFileSync(fx.reviewFile, JSON.stringify(fx.review));
  assert.deepEqual(promoteReviewedFigures(fx).promotion.summary, { assets:1, questions:1 });

  const missing = fixture();
  delete missing.review.integrity.questionIdsMatchPendingQueue;
  fs.writeFileSync(missing.reviewFile, JSON.stringify(missing.review));
  assert.throws(() => promoteReviewedFigures(missing), /integrity gate/);
});

test('獨立審核可明列 candidate 與 review groups 的題號綁定，但仍須通過其餘門檻', () => {
  const fx = fixture();
  delete fx.review.integrity.questionIdsMatchPendingQueue;
  fx.review.integrity.questionIdsMatchCandidateGroupsReviewGroupsAndPendingQueue = true;
  fs.writeFileSync(fx.reviewFile, JSON.stringify(fx.review));
  assert.deepEqual(promoteReviewedFigures(fx).promotion.summary, { assets:1, questions:1 });
});

test('同一人自產自審、審核不完整或 crop 被改動時一律 fail closed', () => {
  const same = fixture();
  same.review.reviewer = 'crop-agent';
  fs.writeFileSync(same.reviewFile, JSON.stringify(same.review));
  assert.throws(() => promoteReviewedFigures(same), /distinct crop producer and reviewer/);

  const incomplete = fixture();
  incomplete.review.integrity.cropPixelsExactlyMatchSourceAtBbox = false;
  fs.writeFileSync(incomplete.reviewFile, JSON.stringify(incomplete.review));
  assert.throws(() => promoteReviewedFigures(incomplete), /integrity gate/);

  const noProducerSafety = fixture();
  noProducerSafety.batch.assets[0].safety.firstPassPassed = false;
  fs.writeFileSync(noProducerSafety.batchFile, JSON.stringify(noProducerSafety.batch));
  assert.throws(() => promoteReviewedFigures(noProducerSafety), /content safety gates/);

  const changed = fixture();
  fs.appendFileSync(path.join(changed.root, 'crops', 'figure.png'), 'tampered');
  assert.throws(() => promoteReviewedFigures(changed), /SHA-256/);
});
