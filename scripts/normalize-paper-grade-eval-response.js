'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain } = require('../tests/helpers/load-app');

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

function main() {
  const responsePath = value('--response');
  const outputPath = value('--out');
  if (!responsePath || !outputPath) throw new Error('Usage: node scripts/normalize-paper-grade-eval-response.js --response <edge.json> --out <prediction.json>');
  const payload = JSON.parse(fs.readFileSync(path.resolve(responsePath), 'utf8'));
  if (!payload.json || !Array.isArray(payload.json.questions)) throw new Error('Edge response 缺少結構化 questions');
  const { context, run } = loadApp();
  context.__rawPaperGrade = payload.json;
  let grade = plain(run(`paperNormalizeAiGrade(PAPER_SOURCES[0], __rawPaperGrade, ${JSON.stringify(String(payload.model || 'gpt-5.5'))})`));
  const inkPath = value('--ink-sessions');
  const runId = value('--run-id');
  if (inkPath || runId) {
    if (!inkPath || !runId) throw new Error('--ink-sessions 與 --run-id 必須一起提供');
    const rows = JSON.parse(fs.readFileSync(path.resolve(inkPath), 'utf8'));
    context.__paperGrade = grade;
    context.__inkRows = rows;
    context.__inkRunId = runId;
    grade = plain(run(`(() => {
      const pages = {};
      for (let page = 0; page < PAPER_SOURCES[0].scans.length; page += 1) {
        const qid = 'paper:' + __inkRunId + ':v' + PAPER_LAYOUT_VERSION + ':' + page;
        const merged = paperInkMergePayloads(__inkRows.filter((row) => row && row.qid === qid).map((row) => row.strokes));
        pages[page] = { s:merged.s, deleted:new Set(merged.deleted) };
      }
      return paperGradeAlignMarksToInk(__paperGrade, pages);
    })()`));
  }
  const prediction = {
    schema: 1,
    id: `paper-mock-1-${String(payload.model || 'gpt-5.5')}-${Date.now()}`,
    model: String(payload.model || ''),
    requestId: String(payload.requestId || ''),
    usage: payload.usage || null,
    cases: grade.questions.map((row) => ({
      no: row.no,
      hasFinalAnswer: row.hasFinalAnswer,
      selectedOptions: row.selectedOptions || [],
      finalAnswer: row.finalAnswer || '',
      status: row.status,
      points: row.points,
      marks: row.marks || [],
    })),
  };
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(prediction, null, 2)}\n`, 'utf8');
  const anchored = prediction.cases.reduce((sum, row) => sum + row.marks.filter((mark) => mark.inkAnchored).length, 0);
  process.stdout.write(JSON.stringify({ output: path.resolve(outputPath), questions: prediction.cases.length, model: prediction.model, anchored }));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}
