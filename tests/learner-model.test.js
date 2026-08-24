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

test('重建基準只排除舊分析，原始作答與原卷仍保留且舊裝置不能把切點倒退', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'num');
    const source = PAPER_SOURCES[0];
    S.attempts = [{ qid:q.id, ok:true, mode:'mixed', d:today(), ts:50 }];
    S.mocks = [{ d:today(), ts:50, score:75, total:100, ok:75, n:100, acc:.75 }];
    S.paperRuns = [{ id:'old-paper', sourceId:source.id, name:source.title, status:'awaiting-correction', due:today(),
      createdAt:30, submittedAt:50, score:75, wrongNos:[2], aiGrade:{ gradedAt:50, score:75, wrongNos:[2], questions:[] }, review:{} }];
    S.learningBaselineResetAt = 100;
    const merged = mergeState({ learningBaselineResetAt:100, attempts:S.attempts }, { learningBaselineResetAt:80, attempts:[] });
    return { evidence:learningEvidenceLedger().length, cal:mockCalibration().count, action:nextBestAction().kind,
      attempts:S.attempts.length, papers:S.paperRuns.length, history:paperRunHistoryHTML(), mergedCut:merged.learningBaselineResetAt };
  })()`));
  assert.equal(result.evidence, 0);
  assert.equal(result.cal, 0);
  assert.equal(result.action, 'mock');
  assert.equal(result.attempts, 1);
  assert.equal(result.papers, 1);
  assert.match(result.history, /基準重置前，僅保留卷面/);
  assert.doesNotMatch(result.history, /75\/100/);
  assert.equal(result.mergedCut, 100);
});

test('知道所屬單元與找到破題方向分開累積，不把只會分類冒充成會解', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'prob');
    S.visionQueue = [{ id:'vq', qid:q.id, ts:10, done:false, attempts:[
      { ts:11, d:today(), hasDirection:false, topic:'prob', concept:'條件機率分母' },
      { ts:12, d:today(), hasDirection:false, topic:'num', concept:'' },
    ] }];
    const model = learnerModel(), row = model.topics.prob;
    return { recognitionN:row.recognitionN, recognitionRate:row.recognitionRate, directionN:row.directionN, directionRate:row.directionRate };
  })()`));
  assert.equal(result.recognitionN, 2);
  assert.equal(result.recognitionRate, 0.5);
  assert.equal(result.directionN, 2);
  assert.ok(result.directionRate < 0.1);
});

test('沒有新證據時不把未知單元冒充成弱項', () => {
  const { run } = loadApp();
  const html = run(`(() => {
    S.learningBaselineResetAt = 100;
    S.attempts = [{ qid:BANK[0].id, ok:false, d:today(), ts:50 }];
    return learnerModelCard();
  })()`);
  assert.match(html, /不能判定任何單元是弱項/);
  assert.doesNotMatch(html, /模型 50\/100/);
});
