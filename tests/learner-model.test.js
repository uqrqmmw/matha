'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const { loadApp, plain } = require('./helpers/load-app');

test('能力目標證據匯出只接受重置後三回互異正式卷且輸出可重算、無敏感資料', async () => {
  const { run, context } = loadApp();
  context.crypto = webcrypto;
  context.TextEncoder = TextEncoder;
  const result = plain(await run(`(async () => {
    const formal = PAPER_SOURCES.filter((source) => source.questions === 20 && source.minutes === 100 && source.calibrationEligible !== false).slice(-4);
    const practice = PAPER_SOURCES.find((source) => source.calibrationEligible === false || source.questions !== 20);
    const makeRun = (id, source, score, submittedAt, freshnessConfirmedAt, day) => {
      const questions = Array.from({ length:20 }, (_, index) => ({
        no:index + 1, status:index < score / 5 ? 'correct' : 'incorrect',
        points:index < score / 5 ? 5 : 0, maxPoints:5,
        read:'private-read-' + id, finalAnswer:'private-answer-' + id,
        selectedOptions:[1], strokes:'private-strokes-' + id, token:'private-token-' + id, email:'private@example.com',
      }));
      return {
        id, sourceId:source.id, d:day, createdAt:submittedAt - 100, submittedAt,
        freshnessConfirmedAt, calibrationEligible:true, status:'awaiting-correction', score,
        strokes:'run-strokes-' + id, token:'run-token-' + id, email:'run@example.com',
        aiGrade:{ score, gradedAt:submittedAt + 50, questions, strokes:'grade-strokes', token:'grade-token', email:'grade@example.com' },
      };
    };
    const extFor = (row, source) => ({
      id:'external-' + row.id, paperRunId:row.id, sourceId:source.id, d:row.d, ts:row.submittedAt,
      score:row.score, total:100, questions:source.questions, calibrationEligible:true,
      freshnessConfirmedAt:row.freshnessConfirmedAt, strokes:'ext-strokes', token:'ext-token', email:'ext@example.com',
    });
    const evidence = async (runs, rows, baseline = 1000) => {
      S.learningBaselineResetAt = baseline; S.paperRuns = runs; S.extMocks = rows; S.mocks = [];
      return capabilityGoalEvidence(9999);
    };

    const empty = await evidence([], []);
    const practiceRun = makeRun('practice-run', practice, 100, 1200, 1100, '2026-08-01');
    const practiceOnly = await evidence([practiceRun], [extFor(practiceRun, practice)]);
    const unseenMissing = makeRun('freshness-missing', formal[0], 100, 1200, null, '2026-08-02');
    const noFreshness = await evidence([unseenMissing], [extFor(unseenMissing, formal[0])]);
    const oldRuns = formal.slice(0, 3).map((source, index) => makeRun('old-' + index, source, 80, 1200 + index * 100, 1100 + index * 100, '2026-08-0' + (3 + index)));
    const beforeReset = await evidence(oldRuns, oldRuns.map((row, index) => extFor(row, formal[index])), 2000);
    const lowRuns = formal.slice(0, 3).map((source, index) => makeRun('low-' + index, source, [75, 70, 80][index], 2200 + index * 100, 2100 + index * 100, '2026-08-1' + index));
    const belowGoal = await evidence(lowRuns, lowRuns.map((row, index) => extFor(row, formal[index])));
    const duplicateRuns = [
      makeRun('duplicate-a', formal[0], 75, 3200, 3100, '2026-08-20'),
      makeRun('duplicate-b', formal[0], 80, 3300, 3200, '2026-08-21'),
      makeRun('duplicate-c', formal[1], 85, 3400, 3300, '2026-08-22'),
    ];
    const duplicateSource = await evidence(duplicateRuns, duplicateRuns.map((row, index) => extFor(row, index < 2 ? formal[0] : formal[1])));
    const goodRuns = formal.slice(0, 3).map((source, index) => makeRun('good-' + index, source, [75, 80, 85][index], 4200 + index * 100, 4100 + index * 100, '2026-08-2' + (3 + index)));
    const stable = await evidence(goodRuns, goodRuns.map((row, index) => extFor(row, formal[index])));
    const originalNow = Date.now; Date.now = () => 9999;
    const stableCard = learnerModelCard(); Date.now = originalNow;
    const unansweredRuns = formal.slice(0, 3).map((source, index) => {
      const row = makeRun('unanswered-' + index, source, 100, 5200 + index * 100, 5100 + index * 100, '2026-08-2' + (6 + index));
      row.aiGrade.questions.forEach((question) => { question.status = 'unanswered'; });
      return row;
    });
    const unansweredWithPoints = await evidence(unansweredRuns, unansweredRuns.map((row, index) => extFor(row, formal[index])));
    const recomputed = [];
    for (const row of stable.runs) {
      const { canonicalDigest, ...digestInput } = row;
      recomputed.push({ expected:canonicalDigest, actual:await capabilityCanonicalDigest(digestInput) });
    }
    S.paperRuns = []; S.extMocks = [];
    S.mocks = [1, 2, 3].map((index) => ({ n:20, acc:.8, mt:6000 + index, d:'2026-08-2' + index }));
    const looseCard = learnerModelCard();
    return { empty, practiceOnly, noFreshness, beforeReset, belowGoal, duplicateSource,
      unansweredWithPoints, stable, recomputed, stableCard, looseCard };
  })()`));

  for (const blocked of [result.empty, result.practiceOnly, result.noFreshness, result.beforeReset,
    result.belowGoal, result.duplicateSource, result.unansweredWithPoints]) {
    assert.equal(blocked.kind, 'matha-capability-goal-evidence-v1');
    assert.equal(blocked.stable, false);
    assert.equal(blocked.status, 'blocked');
  }
  assert.match(result.belowGoal.blockers.join(','), /below-72|cross-check/);
  assert.match(result.duplicateSource.blockers.join(','), /eligible-distinct-formal-runs:2\/3/);
  assert.equal(result.stable.stable, true);
  assert.equal(result.stable.status, 'stable');
  assert.deepEqual(result.stable.runs.map((row) => row.score), [75, 80, 85]);
  assert.equal(new Set(result.stable.runs.map((row) => row.runId)).size, 3);
  assert.equal(new Set(result.stable.runs.map((row) => row.sourceId)).size, 3);
  assert.equal(result.stable.runs.every((row) => row.total === 100 && row.gradeSummary.questionCount === 20
    && row.gradeSummary.maxPoints === 100 && row.gradeSummary.awardedPoints === row.score), true);
  assert.equal(result.recomputed.every((row) => row.expected === row.actual), true);
  const serialized = JSON.stringify(result.stable).toLowerCase();
  assert.doesNotMatch(serialized, /private-read|private-answer|strokes|token|@example\.com/);
  assert.match(result.stableCard, /下載能力目標證據/);
  assert.match(result.stableCard, /三回不同來源的正式新鮮卷/);
  assert.match(result.looseCard, /目前不宣稱穩定 13 級分/);
});

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
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'num');
    const source = PAPER_SOURCES[0];
    S.attempts = [{ qid:q.id, ok:true, mode:'mixed', d:today(), ts:50 }];
    S.mocks = [{ d:today(), ts:50, score:75, total:100, ok:75, n:100, acc:.75 }];
    S.corrections = [{ id:'old-batch', name:'舊制系統模考', d:today(), due:today(), mockTs:50, mt:200,
      entries:[{ qid:q.id, done:false, attempts:0, logs:[] }] }];
    S.paperRuns = [{ id:'old-paper', sourceId:source.id, name:source.title, status:'awaiting-correction', due:today(),
      createdAt:30, submittedAt:50, mt:200, score:75, wrongNos:[2], aiGrade:{ gradedAt:50, adjustedAt:200, score:75, wrongNos:[2],
        questions:[{ no:2, topic:'num', status:'incorrect', points:0, maxPoints:5 }] },
      review:{ 2:{ done:false, attempts:1, logs:[{ ts:200, kind:'retry', topic:'num', direction:'歷史卷的新訂正不得復活舊基準' }] } } }];
    S.learningBaselineResetAt = 100;
    paperSourceUpdateExtMock(source, S.paperRuns[0]);
    const merged = mergeState({ learningBaselineResetAt:100, attempts:S.attempts }, { learningBaselineResetAt:80, attempts:[] });
    __app.innerHTML = '';
    renderCorrections();
    const correctionHtml = __app.innerHTML;
    startPaperAnswerReview('old-paper');
    const blockedDirectStart = !paperReview;
    let archivedStart = null;
    startPaperAnswerReview = (id, allowArchived) => { archivedStart = { id, allowArchived }; };
    startArchivedPaperAnswerReview('old-paper', true);
    return { evidence:learningEvidenceLedger().length, cal:mockCalibration().count, action:nextBestAction().kind,
      attempts:S.attempts.length, papers:S.paperRuns.length, history:paperRunHistoryHTML(), corrections:correctionHtml,
      pending:pendingCorrections().length, signals:Object.keys(diagnosticTopicSignals()).length,
      blockedDirectStart, archivedStart, mergedCut:merged.learningBaselineResetAt };
  })()`));
  assert.equal(result.evidence, 0);
  assert.equal(result.cal, 0);
  assert.equal(result.action, 'mock');
  assert.equal(result.attempts, 1);
  assert.equal(result.papers, 1);
  assert.match(result.history, /基準重置前，僅保留卷面/);
  assert.match(result.history, /歷史卷驗收訂正/);
  assert.doesNotMatch(result.history, /75\/100/);
  assert.doesNotMatch(result.corrections, /75\/100|第一次模考|舊制系統模考/);
  assert.equal(result.pending, 0, '舊批次後續同步時間變新，也不能復活成待訂正');
  assert.equal(result.signals, 0, '舊批次後續同步時間變新，也不能污染弱項模型');
  assert.equal(result.blockedDirectStart, true);
  assert.deepEqual(result.archivedStart, { id:'old-paper', allowArchived:true });
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

test('解題流程分類涵蓋辨認、方向、建式、執行、計算、表達與保留', () => {
  const { run } = loadApp();
  const result = plain(run(`({
    recognition:learningProcessStage('審題時看錯條件'),
    direction:learningProcessStage('找不到破題方向'),
    setup:learningProcessStage('設元後列式錯誤'),
    execution:learningProcessStage('分類討論遺漏邊界'),
    calculation:learningProcessStage('移項時正負號計算錯'),
    expression:learningProcessStage('最後答案格式與單位錯'),
    retention:learningProcessStage('兩天後記憶未保留'),
  })`));
  assert.deepEqual(result, {
    recognition:'recognition', direction:'direction', setup:'setup', execution:'execution',
    calculation:'calculation', expression:'expression', retention:'retention',
  });
});

test('新作答明確保存六段流程欄位與證據來源，不再只靠之後重猜文字', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'num');
    S.attempts = [];
    recordAttempt(q, false, 120000, '設元後建式錯誤', 'mixed', null, null);
    const attempt = S.attempts[0];
    const row = learningEvidenceLedger().find((item) => item.id.startsWith('attempt:'));
    return {
      keys:Object.keys(attempt.processEvidence).sort(),
      setup:attempt.processEvidence.setup,
      stage:row.processStage,
      source:row.processEvidenceSource,
    };
  })()`));
  for (const key of ['recognition', 'direction', 'setup', 'execution', 'calculation', 'expression']) assert.ok(result.keys.includes(key), key);
  assert.equal(result.setup.length, 1);
  assert.equal(result.setup[0].status, 'blocked');
  assert.equal(result.stage, 'setup');
  assert.equal(result.source, 'answer-result');
});

test('只有有逐字卷面證據的 AI 詳批能寫入結構化流程斷點', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const state = {};
    processEvidenceRecordEffort(state, { topic:'num', concept:'等式性質', direction:'先設 x 再列方程式' }, { ts:10, source:'learner' });
    const rejected = processEvidenceRecordAiDetail(state, {
      generatedAt:11, confidence:'low', firstErrorEvidence:null, firstError:null, errorKind:null,
    });
    const accepted = processEvidenceRecordAiDetail(state, {
      generatedAt:12, confidence:'high', firstErrorEvidence:'2x=10', firstError:'移項時漏掉負號', errorKind:'正負號計算錯誤',
    });
    return { evidence:state.processEvidence, rejected, accepted };
  })()`));
  assert.equal(result.rejected, null);
  assert.equal(result.evidence.recognition.length, 1);
  assert.equal(result.evidence.direction.length, 1);
  assert.equal(result.evidence.calculation.length, 1);
  assert.equal(result.evidence.calculation[0].source, 'trusted-ai-detail');
  assert.equal(result.evidence.calculation[0].evidence, '2x=10');
});

test('學習證據優先採持久化結構欄位，保留舊文字只作相容備援', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((item) => item.topic === 'num');
    const attempt = { qid:q.id, ok:false, err:'方法選錯', d:today(), mode:'mixed', ts:20 };
    processEvidenceEnsure(attempt);
    processEvidenceAppend(attempt, 'calculation', {
      ts:20, status:'blocked', source:'trusted-ai-detail', confidence:'high', note:'正負號計算錯誤', evidence:'2x=10',
    });
    S.attempts = [attempt];
    return learningEvidenceLedger()[0];
  })()`));
  assert.equal(result.processStage, 'calculation');
  assert.equal(result.processEvidenceSource, 'trusted-ai-detail');
  assert.equal(result.processEvidenceStatus, 'blocked');
});

test('老師具名修正保留 AI 原判與每次歷史，最新逐欄修正進入學習模型', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const state = { topic:'num', aiErrorKind:'找不到破題方向', processEvidence:processEvidenceBlank() };
    const first = paperTeacherOverrideAppend(state, {
      at:100, reviewer:'王老師', source:'老師面談', reason:'卷面顯示是符號運算先出錯', topic:'prob', processStage:'calculation',
    }, { topic:'num', errorKind:'找不到破題方向' });
    const second = paperTeacherOverrideAppend(state, {
      at:200, reviewer:'王老師', source:'老師卷面批註', reason:'重新核對題目應歸在數列', topic:'seq',
    }, { topic:'num', errorKind:'找不到破題方向' });
    S.paperRuns = [{ id:'teacher-run', sourceId:source.id, d:today(), submittedAt:10, status:'completed',
      aiGrade:{ gradedAt:10, questions:[{ no:1, status:'incorrect', points:0, maxPoints:5, topic:'num' }] },
      review:{ 1:state } }];
    const evidence = learningEvidenceLedger().filter((row) => row.qid === 'teacher-run:1');
    return {
      history:state.teacherOverrideHistory,
      first, second,
      topic:paperReviewEffectiveTopic(state, 'num'),
      process:paperReviewEffectiveProcess(state, 'direction'),
      teacherEvidence:evidence.find((row) => row.processEvidenceSource === 'teacher-override'),
    };
  })()`));
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].previous.aiTopic, 'num');
  assert.equal(result.history[1].previous.priorOverrideId, result.first.id);
  assert.equal(result.topic, 'seq');
  assert.equal(result.process, 'calculation', '後一筆只改單元，不應抹掉前一筆流程修正');
  assert.equal(result.teacherEvidence.topic, 'seq');
  assert.equal(result.teacherEvidence.processStage, 'calculation');
});

test('跨裝置合併逐筆聯集老師修正與流程證據，不讓較新整題覆蓋另一台歷史', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const left = { mt:100, logs:[], processEvidence:processEvidenceBlank(), teacherOverrideHistory:[] };
    const right = { mt:200, logs:[], processEvidence:processEvidenceBlank(), teacherOverrideHistory:[] };
    paperTeacherOverrideAppend(left, { at:100, reviewer:'王老師', source:'面談', reason:'單元應改為機率', topic:'prob' }, { topic:'num' });
    paperTeacherOverrideAppend(right, { at:200, reviewer:'王老師', source:'卷面', reason:'第一錯步是建式', processStage:'setup' }, { topic:'num' });
    processEvidenceAppend(left, 'direction', { ts:90, status:'attempted', source:'learner', confidence:'verified', note:'先列出事件' });
    const merged = mergePaperReviewState(left, right);
    return {
      history:merged.teacherOverrideHistory,
      topic:paperReviewEffectiveTopic(merged, 'num'),
      process:paperReviewEffectiveProcess(merged, 'direction'),
      direction:merged.processEvidence.direction,
      setup:merged.processEvidence.setup,
    };
  })()`));
  assert.equal(result.history.length, 2);
  assert.equal(result.topic, 'prob');
  assert.equal(result.process, 'setup');
  assert.equal(result.direction.length, 1);
  assert.equal(result.setup.length, 1);
});

test('流程斷點至少跨兩題才進個人化提示，不被同一題重複紀錄灌大', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const rows = BANK.filter((item) => item.topic === 'num').slice(0, 2);
    S.attempts = [
      { qid:rows[0].id, ok:false, err:'設元後建式錯誤', d:today(), mode:'mixed', ts:1 },
      { qid:rows[0].id, ok:false, err:'列式時漏掉常數', d:today(), mode:'mixed', ts:2 },
    ];
    const oneQuestion = learnerModel();
    S.attempts.push({ qid:rows[1].id, ok:false, err:'方程式建式錯誤', d:today(), mode:'mixed', ts:3 });
    const twoQuestions = learnerModel();
    return {
      firstTop:oneQuestion.topProcess,
      secondTop:twoQuestions.topProcess,
      topicTop:twoQuestions.topics.num.topProcess,
      prompt:learnerContextForAi('num'),
      card:learnerModelCard(),
    };
  })()`));
  assert.equal(result.firstTop, null);
  assert.equal(result.secondTop.stage, 'setup');
  assert.equal(result.secondTop.questionCount, 2);
  assert.equal(result.topicTop.stage, 'setup');
  assert.match(result.prompt, /跨題流程斷點：建式（2 題）/);
  assert.match(result.card, /解題流程斷點/);
  assert.match(result.card, /建式 <b>2 題<\/b>/);
});

test('老師單頁只把跨兩題以上的流程錯誤列為反覆斷點', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const base = { id:'process-paper', sourceId:source.id, d:today(), score:60, submittedAt:3, remainingMs:0, review:{} };
    const grade = { questions:[
      { no:1, status:'incorrect', points:0, maxPoints:5, topic:'num' },
      { no:2, status:'incorrect', points:0, maxPoints:5, topic:'num' },
    ] };
    base.review = { 1:{ errorKind:'設元後建式錯誤' } };
    const once = paperTeacherSummaryHTML(base, source, grade, { l1:0, l2:0, l3:0, open:2 });
    base.review[2] = { errorKind:'列方程式時建式錯誤' };
    const repeated = paperTeacherSummaryHTML(base, source, grade, { l1:0, l2:0, l3:0, open:2 });
    return { once, repeated };
  })()`));
  assert.doesNotMatch(result.once, /建式 1 題/);
  assert.match(result.repeated, /跨題流程斷點：<\/b>建式 2 題/);
});
