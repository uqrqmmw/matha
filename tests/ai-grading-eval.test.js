'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-grading-detail-golden.json'), 'utf8'));

test('原版詳批第一錯步只信任 read 中可核對的 golden 證據', () => {
  assert.equal(golden.schema, 1);
  const { context, run } = loadApp();
  context.__goldenCases = golden.cases;
  const results = plain(run(`__goldenCases.map((fixture) => {
    const detail = paperNormalizeAiDetail(PAPER_SOURCES[0], 2, fixture.raw, 'gpt-5.5');
    return {
      id: fixture.id,
      confidence: detail.confidence,
      trusted: !!detail.firstErrorEvidence && !!detail.firstError && !!detail.errorKind,
      markCount: detail.marks.length,
      firstErrorEvidence: detail.firstErrorEvidence,
    };
  })`));

  assert.deepEqual(results.map(({ id, confidence, trusted, markCount }) => ({ id, confidence, trusted, markCount })),
    golden.cases.map((fixture) => ({ id:fixture.id, ...fixture.expected })));
  assert.equal(results[0].firstErrorEvidence, golden.cases[0].raw.firstErrorEvidence);
  assert.equal(results[1].firstErrorEvidence, null);
  assert.equal(results[2].firstErrorEvidence, golden.cases[2].raw.firstErrorEvidence);
  assert.equal(results[3].firstErrorEvidence, null);
});

test('影像優先教材題的 AI 批改先收到原題裁圖，再收到學生手寫', async () => {
  const { run } = loadApp();
  const content = await run(`(async () => {
    appendQuestionStemForAi = async (items) => {
      items.push({ type:'text', text:'STEM-LABEL' });
      items.push({ type:'image', source:{ type:'base64', media_type:'image/png', data:'stem-image' } });
      return true;
    };
    aiJSON = async (items) => items;
    return aiGradeCall({ id:'crop-q', q:'原卷題目定位字串', topic:'num', sol:'' }, '3', 'student-ink', [], 0);
  })()`);
  const images = plain(content).filter((item) => item.type === 'image').map((item) => item.source.data);
  assert.deepEqual(images, ['stem-image', 'student-ink']);
  assert.match(plain(content).find((item) => item.type === 'text' && item.text.includes('題目：')).text,
    /題目：原卷題目定位字串/);
});

test('有驗證原題裁圖時提示詞不把 metadata 定位字串冒充題目', () => {
  const { run } = loadApp();
  const text = run(`(() => {
    verifiedStemAsset = () => ({ assetStatus:'verified' });
    return questionPromptText({ q:'原卷題目｜book p8｜q1' });
  })()`);
  assert.match(text, /完整題目.*原 PDF 題目裁圖/);
  assert.doesNotMatch(text, /book p8/);
});
