'use strict';

/*
 * Build a private, offline review package for textbook questions whose printed
 * figure has not yet been cropped and independently reviewed.
 *
 * This script deliberately does NOT create a student-facing figureAsset, mark
 * anything verified, or upload anything. Full-page renders are review evidence
 * only and may contain worked answers or solutions.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CATALOG = path.join(REPO_ROOT, 'textbook-catalog.js');

function shaFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function shaText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadCatalog(file) {
  const resolved = path.resolve(file);
  delete require.cache[require.resolve(resolved)];
  const catalog = require(resolved);
  if (!catalog || !Array.isArray(catalog.books)) throw new Error(`Invalid textbook catalog: ${resolved}`);
  return catalog;
}

function safeSegment(value, label) {
  const text = String(value || '');
  if (!/^[\w.-]+$/.test(text) || text === '.' || text === '..') throw new Error(`Unsafe ${label}: ${text}`);
  return text;
}

/* A/B/C or 1/2/3 suffixes are subparts of one printed exercise and normally
   share its diagram. The page remains part of the group key, so similarly
   named exercises on different pages can never be merged. */
function exerciseGroupId(questionId) {
  const id = safeSegment(questionId, 'question id');
  return id.replace(/(?:-(?:[a-z]|\d+)|(?<=\d)[a-d])$/i, '');
}

function groupPendingItems(items) {
  const grouped = new Map();
  for (const question of items) {
    const bookId = safeSegment(question && question.bookId, 'book id');
    const pageIndex = Number(question && question.page);
    if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error(`Question ${question && question.id} has no valid PDF page`);
    const exerciseId = exerciseGroupId(question.id);
    const key = `${bookId}|${pageIndex}|${exerciseId}`;
    if (!grouped.has(key)) grouped.set(key, { bookId, pageIndex, exerciseId, questions: [] });
    grouped.get(key).questions.push(question);
  }
  return [...grouped.values()].sort((a, b) => a.bookId.localeCompare(b.bookId)
    || a.pageIndex - b.pageIndex || a.exerciseId.localeCompare(b.exerciseId));
}

function parsePdfInfo(output) {
  const match = String(output).match(/^Pages:\s+(\d+)\s*$/mi);
  if (!match) throw new Error('pdfinfo did not report a page count');
  return { pages: Number(match[1]) };
}

function pngDimensions(file) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length
      || header.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(`Not a valid PNG: ${file}`);
  } finally {
    fs.closeSync(fd);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPrivateOutput(outputDir) {
  if (isInside(REPO_ROOT, outputDir)) {
    throw new Error(`Private review output must be outside the Git repository: ${outputDir}`);
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function relativeUrl(fromFile, targetFile) {
  return path.relative(path.dirname(fromFile), targetFile).split(path.sep).map(encodeURIComponent).join('/');
}

function renderReviewHtml(manifest, outputFile) {
  const cards = manifest.assetGroups.map((group) => {
    const page = manifest.pageReferences.find((entry) => entry.bookId === group.bookId && entry.pageIndex === group.pageIndex);
    const image = relativeUrl(outputFile, path.join(path.dirname(outputFile), page.path));
    const questionText = group.questions.map((question) => `<details><summary>${escapeHtml(question.id)}</summary><p>${escapeHtml(question.text)}</p></details>`).join('');
    return `<article id="${escapeHtml(group.assetId)}">
      <header><strong>${escapeHtml(group.bookTitle)} / PDF p.${group.pageIndex}</strong><code>${escapeHtml(group.assetId)}</code></header>
      <div class="warning">REVIEW REFERENCE ONLY - may contain answers or solutions - never student-facing</div>
      <img loading="lazy" src="${image}" alt="Review-only full page ${group.pageIndex}">
      <section><b>Exercise group:</b> ${escapeHtml(group.exerciseId)}${questionText}</section>
      <dl><dt>Crop</dt><dd>pending</dd><dt>Student safe</dt><dd>NO</dd><dt>Verified</dt><dd>NO</dd></dl>
    </article>`;
  }).join('\n');
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Private figure crop review</title><style>
  :root{font-family:system-ui,sans-serif;color:#282621;background:#eeece6}body{margin:0}nav{position:sticky;top:0;z-index:2;padding:12px 18px;background:#fffdf7;border-bottom:1px solid #bcb8ad}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;padding:16px}article{background:#fff;border:1px solid #c9c5ba;border-radius:10px;overflow:hidden}header,section,dl{padding:10px 12px}header{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}code{font-size:11px}.warning{padding:8px 12px;background:#f0d9d3;color:#71291d;font-weight:700;font-size:12px}img{display:block;width:100%;height:440px;object-fit:contain;background:#d9d7d0}details{margin-top:8px}p{white-space:pre-wrap;font-size:13px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}dt{font-weight:700}dd{margin:0}</style></head>
  <body><nav><b>Private offline crop review</b> - ${manifest.summary.assetGroups} groups / ${manifest.summary.uniquePages} pages / ${manifest.summary.questions} questions. Full pages are evidence only.</nav><main>${cards}</main></body></html>`;
  fs.writeFileSync(outputFile, html);
}

function verifyBook(book, pdfRoot, pdfinfoCommand) {
  if (!book.pdfSha256 || !/^[a-f0-9]{64}$/i.test(book.pdfSha256)) throw new Error(`Catalog has no trusted PDF SHA-256 for ${book.id}`);
  const pdfPath = path.resolve(pdfRoot, book.file);
  if (!isInside(pdfRoot, pdfPath) || !fs.existsSync(pdfPath)) throw new Error(`PDF not found for ${book.id}: ${pdfPath}`);
  const actualSha256 = shaFile(pdfPath);
  if (actualSha256 !== book.pdfSha256.toLowerCase()) throw new Error(`PDF SHA-256 mismatch for ${book.id}: expected ${book.pdfSha256}, got ${actualSha256}`);
  const info = parsePdfInfo(execFileSync(pdfinfoCommand, [pdfPath], { encoding: 'utf8', windowsHide: true }));
  if (info.pages !== Number(book.pages)) throw new Error(`PDF page count mismatch for ${book.id}: expected ${book.pages}, got ${info.pages}`);
  return { pdfPath, actualSha256, pages: info.pages };
}

function prepareFigureReview(options) {
  const pendingFile = path.resolve(options.pendingFile);
  const pdfRoot = path.resolve(options.pdfRoot);
  const outputDir = path.resolve(options.outputDir);
  const catalogFile = path.resolve(options.catalogFile || DEFAULT_CATALOG);
  const dpi = Number(options.dpi || 84);
  const pdfinfoCommand = options.pdfinfoCommand || 'pdfinfo';
  const pdftoppmCommand = options.pdftoppmCommand || 'pdftoppm';
  if (!Number.isInteger(dpi) || dpi < 48 || dpi > 180) throw new Error('Review DPI must be an integer from 48 to 180');
  assertPrivateOutput(outputDir);
  const pending = readJson(pendingFile);
  if (pending.kind !== 'pending-visual-queue' || !Array.isArray(pending.items)) throw new Error('Expected a pending-visual-queue JSON file');
  const catalog = loadCatalog(catalogFile);
  const books = new Map(catalog.books.map((book) => [book.id, book]));
  const groups = groupPendingItems(pending.items);
  const referencedBookIds = [...new Set(groups.map((group) => group.bookId))].sort();

  // Verify every source before writing even one render. A bad scan must fail closed.
  const verifiedBooks = new Map();
  for (const bookId of referencedBookIds) {
    const book = books.get(bookId);
    if (!book) throw new Error(`Book ${bookId} is absent from the catalog`);
    verifiedBooks.set(bookId, { book, ...verifyBook(book, pdfRoot, pdfinfoCommand) });
  }
  for (const group of groups) {
    const verified = verifiedBooks.get(group.bookId);
    if (group.pageIndex > verified.pages) throw new Error(`Question group ${group.exerciseId} requests page ${group.pageIndex}, but ${group.bookId} has ${verified.pages}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '.private-output-do-not-upload'), 'PRIVATE COPYRIGHTED REVIEW MATERIAL\nNever upload or publish this directory.\n');
  const uniquePages = [...new Map(groups.map((group) => [`${group.bookId}|${group.pageIndex}`, group])).values()];
  const pageReferences = [];
  for (const pageGroup of uniquePages) {
    const verified = verifiedBooks.get(pageGroup.bookId);
    const pageDir = path.join(outputDir, 'review-pages', safeSegment(pageGroup.bookId, 'book id'));
    fs.mkdirSync(pageDir, { recursive: true });
    const prefix = path.join(pageDir, `p${String(pageGroup.pageIndex).padStart(4, '0')}`);
    const outputFile = `${prefix}.png`;
    execFileSync(pdftoppmCommand, ['-f', String(pageGroup.pageIndex), '-l', String(pageGroup.pageIndex), '-r', String(dpi), '-png', '-singlefile', verified.pdfPath, prefix], { stdio: 'pipe', windowsHide: true });
    if (!fs.existsSync(outputFile)) throw new Error(`Renderer did not create ${outputFile}`);
    const dimensions = pngDimensions(outputFile);
    pageReferences.push({
      bookId: pageGroup.bookId,
      pageIndex: pageGroup.pageIndex,
      path: path.relative(outputDir, outputFile).split(path.sep).join('/'),
      sha256: shaFile(outputFile),
      mime: 'image/png',
      ...dimensions,
      dpi,
      usage: 'review-reference-only',
      studentUsable: false,
      mayContainAnswerOrSolution: true,
    });
  }

  const generatedAt = new Date().toISOString();
  const assetGroups = groups.map((group) => {
    const verified = verifiedBooks.get(group.bookId);
    const assetId = `fig-${shaText(`${group.bookId}|${group.pageIndex}|${group.exerciseId}`).slice(0, 20)}`;
    return {
      assetId,
      assetStatus: 'pending-crop-review',
      studentUsable: false,
      verified: false,
      exerciseId: group.exerciseId,
      questionIds: group.questions.map((question) => question.id).sort(),
      questions: group.questions.map((question) => ({
        id: question.id,
        text: [question.stem, question.q].filter(Boolean).join('\n'),
        pendingReason: question.visualPendingReason || 'visual-asset-required',
      })),
      bookId: group.bookId,
      bookTitle: verified.book.title,
      pageIndex: group.pageIndex,
      sourcePdf: {
        file: verified.book.file,
        sha256: verified.actualSha256,
        pageCount: verified.pages,
      },
      crop: {
        status: 'pending',
        bboxNormalized: null,
        candidateAssetPath: `crops/${group.bookId}/${assetId}.webp`,
        cropSha256: null,
        width: null,
        height: null,
        mime: null,
      },
      safety: {
        fullPageReferenceOnly: true,
        containsAnswer: 'unknown',
        containsSolution: 'unknown',
        containsHandwriting: 'unknown',
        questionRoleVerified: false,
        independentlyReviewed: false,
        safeForStudent: false,
        reviewNotes: [],
      },
    };
  });
  const manifest = {
    kind: 'private-figure-review',
    schema: 1,
    generatedAt,
    privacy: {
      localOnly: true,
      uploadPerformed: false,
      fullPagesStudentUsable: false,
      automaticVerificationPerformed: false,
    },
    inputs: {
      pendingFile: path.basename(pendingFile),
      pendingSha256: shaFile(pendingFile),
      catalogFile: path.basename(catalogFile),
      catalogSha256: shaFile(catalogFile),
      pdfRoot,
    },
    grouping: {
      strategy: 'same book + same physical PDF page + printed exercise id with only terminal subpart suffix removed',
      terminalSubparts: ['-a', '-b', '-c', '-d', '-1', '-2', '-3', '-4', 'a/b/c/d appended after a digit'],
    },
    summary: {
      questions: pending.items.length,
      assetGroups: assetGroups.length,
      uniquePages: pageReferences.length,
      books: verifiedBooks.size,
      verifiedAssets: 0,
      studentUsableAssets: 0,
    },
    books: [...verifiedBooks.values()].map((entry) => ({
      bookId: entry.book.id,
      title: entry.book.title,
      file: entry.book.file,
      sha256: entry.actualSha256,
      pageCount: entry.pages,
      shaVerified: true,
      pageCountVerified: true,
    })),
    pageReferences,
    assetGroups,
  };
  const manifestFile = path.join(outputDir, 'review-manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  renderReviewHtml(manifest, path.join(outputDir, 'review.html'));
  return manifest;
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--pending') { options.pendingFile = value; i++; }
    else if (args[i] === '--pdf-root') { options.pdfRoot = value; i++; }
    else if (args[i] === '--output') { options.outputDir = value; i++; }
    else if (args[i] === '--catalog') { options.catalogFile = value; i++; }
    else if (args[i] === '--dpi') { options.dpi = Number(value); i++; }
    else if (args[i] === '--pdfinfo') { options.pdfinfoCommand = value; i++; }
    else if (args[i] === '--pdftoppm') { options.pdftoppmCommand = value; i++; }
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!options.pendingFile || !options.pdfRoot || !options.outputDir) {
    throw new Error('Usage: node scripts/prepare-figure-review.js --pending <pending-visuals.json> --pdf-root <PDF directory> --output <private output directory> [--dpi 84]');
  }
  return options;
}

if (require.main === module) {
  try {
    const manifest = prepareFigureReview(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(manifest.summary, null, 2));
  } catch (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = {
  assertPrivateOutput,
  exerciseGroupId,
  groupPendingItems,
  isInside,
  parseArgs,
  parsePdfInfo,
  pngDimensions,
  prepareFigureReview,
  renderReviewHtml,
};
