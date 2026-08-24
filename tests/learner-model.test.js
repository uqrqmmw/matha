'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('統一證據層涵蓋作答、眼刷、訂正、保留、大綱、觀念與原卷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const num = BANK.find((q) => q.topic === 'num');
    const prob = BANK.find((q) => q.topic === 'prob');
    const source = PAPER_SOURCES[0];
    S.attempts = [{ qid:num.id, ok:false, err:'方法選錯', d:today(), mode:'adaptive-textbook', ts:10 }];
    S.sidePractice = [{ qid:prob.id, topic:'prob', ok:true, kind:'independent-transfer', d:today(), ts:11 }];
    S.corrections = [{ id:'c1', d:today(), due:today(), mockTs:12, entries:[{
      qid:prob.id, examNo:1, answered:false, done:true, level:3, completedAt:16,
      logs:[{ ts:14, note:'先縮小樣本空間', topic:'prob', resolved:true }],
      retentionLogs:[{ ts:15, d:today(), ok:true, stage:0, mode:'adaptive-textbook' }],
    }] }];
    S.visionQueue = [{ id:'vq1', qid:num.id, done:false, attempts:[{ ts:17, d:today(), hasDirection:false, topic:'num' }] }];
    S.visionHistory = [{ id:'vision-result-vh1', qid:prob.id, ts:18, d:today(), outcome:'works', days:1, attempts:[{ hasDirection:true }] }];
    S.conceptAttempts = [{ id:'ca1', conceptId:'concept-function', ts:19, d:today(), understood:false }];
    S.outlineAttempts = [{ id:'oa1', unitId:'outline-1', ts:20, d:today(), coverage:60 }];
    S.paperRuns = [{ id:'pr1', sourceId:source.id, d:today(), submittedAt:21, status:'awaiting-correction',
      aiGrade:{ gradedAt:21, questions:[{ no:1, status:'incorrect', points:0, topic:'num' }] }, review:{} }];
    const evidence = learningEvidenceLedger();
    return { stages:[...new Set(evidence.map((x) => x.stage))], sources:[...new Set(evidence.map((x) => x.source))], count:evidence.length };
  })()`));
  for (const stage of ['solve', 'direction', 'correction', 'retention', 'concept', 'recall']) assert.ok(result.stages.includes(stage), stage);
  for (const source of ['adaptive-textbook', 'vision', 'correction', 'paper-mock']) assert.ok(result.sources.includes(source), source);
  assert.ok(result.count >= 10);
});

test('單次失誤不會被宣布成弱項，重複獨立失誤才提高優先度', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'num');
    S.attempts = [{ qid:q.id, ok:false, err:'方法選錯', d:today(), mode:'mixed', ts:1 }];
    const once = learnerModel();
    S.attempts = Array.from({ length:6 }, (_, i) => ({ qid:q.id, ok:false, err:'方法選錯', d:today(), mode:'mixed', ts:i + 1 }));
    const repeated = learnerModel();
    return {
      onceWeak:once.needs.some((row) => row.topic === 'num'),
      onceConfidence:once.topics.num.confidence.key,
      repeatedWeak:repeated.needs.some((row) => row.topic === 'num'),
      priority:repeated.topics.num.priority,
    };
  })()`));
  assert.equal(result.onceWeak, false);
  assert.equal(result.onceConfidence, 'low');
  assert.equal(result.repeatedWeak, true);
  assert.ok(result.priority > 1);
});

test('學習者模型會進入個人化提示與進度頁，並明示不可取代卷面證據', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML:'' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'prob');
    S.attempts = Array.from({ length:5 }, (_, i) => ({ qid:q.id, ok:i === 4, err:i === 4 ? null : '方法選錯', d:today(), mode:'mixed', ts:i + 1 }));
    const prompt = learnerContextForAi('prob');
    renderStats();
    return { prompt, html:document.querySelector('#app').innerHTML };
  })()`));
  assert.match(result.prompt, /累積學習者模型/);
  assert.match(result.prompt, /不可取代本題卷面證據/);
  assert.match(result.html, /AI 對你的理解/);
  assert.match(result.html, /一次錯誤不會被宣布成弱項/);
});

