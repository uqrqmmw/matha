'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('級分校準只採完整模擬，三場皆過 72% 才標穩定', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = Array.from({length: 40}, (_, i) => ({ qid: BANK[i].id, ok: true, ms: 1000, d: today(), mode: 'mixed', ts: i + 1 }));
    const before = mockCalibration();
    S.mocks = [
      { d: addDays(today(), -2), ok: 9, n: 12, acc: .75 },
      { d: addDays(today(), -1), ok: 10, n: 12, acc: 10 / 12 },
      { d: today(), ok: 9, n: 12, acc: .75 },
    ];
    const after = mockCalibration();
    return { before, after };
  })()`));
  assert.equal(result.before.count, 0, '全對的弱項練習也不得冒充模擬校準');
  assert.equal(result.after.count, 3);
  assert.equal(result.after.stable, true);
  assert.equal(result.after.passes, 3);
  assert.equal(result.after.grade, '13 級分');
});

test('下一步先處理隔日任務；沒有可信成績時先建全真基準，再排大綱、弱點與觀念', () => {
  const { run } = loadApp();
  const states = plain(run(`(() => {
    S.attempts = []; S.mocks = []; S.wrong = {}; S.corrections = []; S.outlineAttempts = []; S.paperRuns = [];
    const outline = nextBestAction();
    const source = PAPER_SOURCES[0];
    S.paperRuns = [{ id:'paper-due', sourceId:source.id, status:'awaiting-correction', due:today(), submittedAt:1,
      wrongNos:[3, 11], aiGrade:{ wrongNos:[3, 11], questions:[] }, review:{ 3:{ done:true } } }];
    const paperDue = nextBestAction();
    const paperPending = paperPendingReviewNos(S.paperRuns[0]);
    S.paperRuns = [];
    S.corrections = [{ id:'c1', due:today(), entries:[{ qid:BANK[0].id, done:false }] }];
    const due = nextBestAction();
    S.corrections = [];
    S.outlineAttempts = OUTLINE_DEFAULTS.map((unit, i) => ({ id:'o' + i, unitId:unit.id, ts:i + 1, due:addDays(today(), 2) }));
    const noData = nextBestAction();
    S.mocks = [{ d: today(), score:68, total:100, ok:68, n:100, acc:.68 }];
    for (let i = 0; i < 4; i++) S.attempts.push({ qid:BANK.find((q) => q.topic === 'num').id, ok:false, ms:180000, d:today(), mode:'mixed', ts:i + 1 });
    const weak = nextBestAction();
    S.attempts = [];
    const normal = nextBestAction();
    S.conceptAttempts = [{ conceptId:CONCEPT_CARDS[0].id, d:today(), ts:Date.now(), understood:true }];
    const adaptive = nextBestAction();
    return { outline:outline.kind, paperDue:paperDue.kind, paperAction:paperDue.onclick, paperPending, noData:noData.kind, due:due.kind, weak:weak.kind, normal:normal.kind, adaptive:adaptive.kind };
  })()`));
  assert.equal(states.paperDue, 'paper-correction');
  assert.match(states.paperAction, /startPaperAnswerReview\('paper-due'\)/);
  assert.deepEqual(states.paperPending, [11]);
  assert.deepEqual({ outline:states.outline, noData:states.noData, due:states.due, weak:states.weak, normal:states.normal },
    { outline:'mock', noData:'mock', due:'correction', weak:'topic', normal:'concept' });
  assert.equal(states.adaptive, 'adaptive-textbook');
});

test('首頁直接續寫保留中的原卷；沒有新基準時一步開啟未用且有完整官方詳解的卷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = []; S.mocks = []; S.wrong = {}; S.corrections = []; S.outlineAttempts = [];
    S.conceptAttempts = []; S.visionQueue = []; S.paperRuns = [];
    const source = nextCalibrationPaperSource();
    const fresh = nextBestAction();
    S.paperRuns = [{ id:'resume-paper', sourceId:source.id, status:'paused', remainingMs:37 * 60000,
      createdAt:Date.now(), mt:Date.now(), wrongNos:[] }];
    const resume = nextBestAction();
    S.paperRuns[0].status = 'grading';
    const grading = nextBestAction();
    return { sourceId:source.id, solution:source.officialSolutionCoverage, fresh, resume, grading };
  })()`));
  assert.equal(result.sourceId, 'paper-regional-ra4109');
  assert.equal(result.solution, 'full');
  assert.equal(result.fresh.kind, 'mock');
  assert.match(result.fresh.onclick, /startPaperSource\('paper-regional-ra4109'\)/);
  assert.match(result.fresh.button, /檢查並開啟/);
  assert.equal(result.resume.kind, 'paper-resume');
  assert.match(result.resume.time, /37:00/);
  assert.match(result.resume.onclick, /startPaperSource\('paper-regional-ra4109'\)/);
  assert.equal(result.grading.kind, 'paper-resume');
  assert.match(result.grading.button, /繼續批改/);
});

test('十一單元先守兩天重測，再允許同日開一個新單元，不會卡死在前幾章', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.mocks = [{ d:today(), ts:Date.now(), score:72, total:100, ok:72, n:100, acc:.72 }];
    S.outlineAttempts = [{ id:'old-1', unitId:OUTLINE_DEFAULTS[0].id, d:addDays(today(), -2), due:today(), ts:1 }];
    const first = nextBestAction();
    S.outlineAttempts.push({ id:'retest-1', unitId:OUTLINE_DEFAULTS[0].id, d:today(), due:addDays(today(), 2), ts:Date.now() });
    const second = nextBestAction();
    S.outlineAttempts.push({ id:'new-2', unitId:OUTLINE_DEFAULTS[1].id, d:today(), due:addDays(today(), 2), ts:Date.now() + 1 });
    const third = nextBestAction();
    return { first:first.title, second:second.title, third:third.kind };
  })()`));
  assert.match(result.first, /兩天後重測/);
  assert.match(result.second, /本週新單元/);
  assert.notEqual(result.third, 'outline');
});

test('大綱與定義只占每週最低頻率，兩天重測仍優先且不被週上限吞掉', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.outlineAttempts = [
      { id:'new-1', unitId:OUTLINE_DEFAULTS[0].id, d:addDays(today(), -6), due:addDays(today(), 2), ts:1 },
      { id:'new-2', unitId:OUTLINE_DEFAULTS[1].id, d:addDays(today(), -1), due:addDays(today(), 2), ts:2 },
    ];
    S.conceptAttempts = [
      { id:'c1', conceptId:CONCEPT_CARDS[0].id, d:addDays(today(), -3), due:addDays(today(), 4), ts:3 },
      { id:'c2', conceptId:CONCEPT_CARDS[1].id, d:addDays(today(), -1), due:addDays(today(), 6), ts:4 },
    ];
    const capped = { weekly:learningWeeklyMinimums(), outline:nextOutlineTask(), concept:nextConceptTask() };
    S.outlineAttempts[0].due = today();
    const retest = nextOutlineTask();
    S.conceptAttempts[0].d = addDays(today(), -8);
    S.conceptAttempts[0].due = today();
    const conceptAfterWindow = nextConceptTask();
    return { capped, retest, conceptAfterWindow };
  })()`));
  assert.deepEqual(result.capped.weekly, { outlineDone:2, outlineTarget:2, conceptDone:2, conceptTarget:2 });
  assert.equal(result.capped.outline, null);
  assert.equal(result.capped.concept, null);
  assert.equal(result.retest.retest, true);
  assert.equal(result.retest.unit.id, 'outline-1');
  assert.equal(result.conceptAfterWindow.id, 'concept-function');
});

test('開考前檢查採 fail-closed：必要項未通過就阻擋，題庫庫存注意不冒充故障', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const now = Date.now();
    const pass = systemReadinessSummary({ version:APP_VER, ts:now, results:[
      ...SYSTEM_READINESS_REQUIRED_IDS.map((id) => ({ id, status:'pass', required:true })),
      { id:'bank', status:'warn', required:false },
    ] }, now);
    const blocked = systemReadinessSummary({ version:APP_VER, ts:now, results:[
      ...SYSTEM_READINESS_REQUIRED_IDS.map((id) => ({ id, status:id === 'answer-gate' ? 'fail' : 'pass', required:true })),
      { id:'inventory', status:'warn', required:false },
    ] }, now);
    const oldVersion = systemReadinessSummary({ version:'old', ts:now, results:[
      ...SYSTEM_READINESS_REQUIRED_IDS.map((id) => ({ id, status:'pass', required:true })),
    ] }, now);
    const missing = systemReadinessSummary({ version:APP_VER, ts:now, results:[
      { id:'bank', status:'warn', required:false },
    ] }, now);
    S.systemReadiness = { version:APP_VER, ts:now, results:[
      ...SYSTEM_READINESS_REQUIRED_IDS.map((id) => ({ id, label:id, status:'pass', detail:'正常', required:true })),
      { id:'bank', label:'私有題庫', status:'warn', detail:'待真人發布', required:false },
    ] };
    return { pass, blocked, oldVersion, missing, html:systemReadinessCard() };
  })()`));
  assert.equal(result.pass.ready, true);
  assert.equal(result.pass.warnings, 1);
  assert.equal(result.blocked.ready, false);
  assert.equal(result.blocked.requiredFailures, 1);
  assert.equal(result.oldVersion.ready, false);
  assert.equal(result.oldVersion.fresh, false);
  assert.equal(result.missing.ready, false);
  assert.equal(result.missing.requiredFailures, 7);
  assert.match(result.html, /可以開始原版模考/);
  assert.match(result.html, /待真人發布/);
});

test('分章補洞只由混合證據觸發，分章練習本身不製造或稀釋診斷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((row) => row.topic === 'num');
    S.visionHistory = []; S.corrections = []; S.paperRuns = [];
    S.attempts = Array.from({length:8}, (_, i) => ({ qid:q.id, ok:false, mode:'practice', d:today(), ts:i + 1 }));
    const chapterOnly = severeWeakTopics().some((row) => row.k === 'num');
    S.attempts = [
      ...Array.from({length:6}, (_, i) => ({ qid:q.id, ok:false, mode:'adaptive-textbook', d:today(), ts:i + 1 })),
      ...Array.from({length:30}, (_, i) => ({ qid:q.id, ok:true, mode:'practice', d:today(), ts:100 + i })),
    ];
    const mixedWeak = severeWeakTopics().find((row) => row.k === 'num');
    return { chapterOnly, mixedWeak };
  })()`));
  assert.equal(result.chapterOnly, false);
  assert.deepEqual(result.mixedWeak, { k:'num', n:6, ok:0, acc:0 });
});

test('個人化選題會把到期錯題、沒有方向與第三級單元排在剛答對的題目前面', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const pair = BANK.filter((q) => q.topic === 'num' && q.type === 'fill').slice(0, 2);
    const due = pair[0], recent = pair[1];
    S.attempts = [{ qid:recent.id, ok:true, ms:60000, d:today(), mode:'mixed', ts:Date.now() }];
    S.wrong = { [due.id]:{ fails:1, wins:0, due:today(), err:'沒有方向' } };
    S.visionHistory = [{ qid:due.id, outcome:'fails', days:2, d:today(), ts:1 }];
    S.paperRuns = [{ id:'signal', sourceId:PAPER_SOURCES[0].id, status:'completed', aiGrade:{ questions:[{ no:1, status:'incorrect', topic:'num' }] }, review:{ 1:{ done:true, level:3 } } }];
    const signals = learningSignalIndex();
    const ranked = rankAdaptiveQuestions(pair);
    return { due:due.id, recent:recent.id, first:ranked[0].id, dueScore:questionLearningValue(due, signals), recentScore:questionLearningValue(recent, signals), reason:questionSelectionReason(due, signals) };
  })()`));
  assert.equal(result.first, result.due);
  assert.ok(result.dueScore > result.recentScore);
  assert.match(result.reason, /間隔重測|破題方向/);
});

test('教材選題理由會引用跨題流程斷點，但同一題重複錯不會觸發', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const rows = BANK.filter((q) => q.topic === 'num').slice(0, 3);
    S.attempts = [
      { qid:rows[0].id, ok:false, err:'列式建式錯誤', d:today(), mode:'mixed', ts:1 },
      { qid:rows[0].id, ok:false, err:'設元後建式錯誤', d:today(), mode:'mixed', ts:2 },
    ];
    const once = questionSelectionReason(rows[2], learningSignalIndex());
    S.attempts.push({ qid:rows[1].id, ok:false, err:'方程式建式錯誤', d:today(), mode:'mixed', ts:3 });
    const repeated = questionSelectionReason(rows[2], learningSignalIndex());
    return { once, repeated };
  })()`));
  assert.doesNotMatch(result.once, /較常卡在建式/);
  assert.match(result.repeated, /較常卡在建式/);
});

test('教材精選只有跨兩題正式卷失分才啟用配分／時間排序，單題失誤仍不宣布單元弱點', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES.find((item) => item.questions === 20 && item.calibrationEligible !== false && Array.isArray(item.key));
    const q = BANK.find((item) => item.topic === 'num');
    const grade = source.key.map((key, index) => ({
      no:index + 1, topic:index < 2 ? 'num' : 'prob',
      status:index === 0 ? 'incorrect' : 'correct', points:index === 0 ? 0 : key.points,
      maxPoints:key.points, marks:[],
    }));
    S.paperRuns = [{ id:'value-paper', sourceId:source.id, submittedAt:1, status:'completed', aiGrade:{ score:95, questions:grade }, review:{} }];
    const oneSignals = learningSignalIndex();
    const one = questionRecoveryOpportunity(q, oneSignals);
    const oneScore = questionLearningValue(q, oneSignals);
    grade[1].status = 'incorrect'; grade[1].points = 0;
    const twoSignals = learningSignalIndex();
    const two = questionRecoveryOpportunity(q, twoSignals);
    return { one, oneScore, two, twoScore:questionLearningValue(q, twoSignals), reason:questionSelectionReason(q, twoSignals) };
  })()`));
  assert.equal(result.one, null);
  assert.equal(result.two.points, 10);
  assert.equal(result.two.questionCount, 2);
  assert.ok(result.twoScore > result.oneScore);
  assert.match(result.reason, /10 分失分證據（跨 2 題）/);
  assert.match(result.reason, /約 \d+ 分鐘驗證/);
});

test('教材混合精選不被正式卷題型比例限制，並排除眼刷留到明天與一眼就會的題', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = '114班·實數與數線';
    const topics = Object.keys(TOPICS).slice(0, 6);
    const added = Array.from({length:18}, (_, i) => ({
      id:'adaptive-test-' + i, topic:topics[i % topics.length], type:'fill', diff:i % 3 + 1,
      q:'自適應教材測試題 ' + i, ans:[String(i)], sol:'解', src:source, role:i % 4 === 0 ? 'example' : 'unclassified'
    }));
    BANK.push(...added); BANK_MAP = null;
    S.visionQueue = [{ qid:added[0].id, stage:'waiting', done:false, due:addDays(today(), 1) }];
    S.visionHistory = [{ qid:added[1].id, outcome:'obvious', d:today(), ts:1 }];
    const queue = adaptiveTextbookQueue(10);
    const use = {}; queue.forEach((q) => { use[q.topic] = (use[q.topic] || 0) + 1; });
    return {
      n:queue.length, types:[...new Set(queue.map((q) => q.type))],
      held:queue.some((q) => q.id === added[0].id), obvious:queue.some((q) => q.id === added[1].id),
      maxTopic:Math.max(...Object.values(use))
    };
  })()`));
  assert.equal(result.n, 10);
  assert.ok(result.types.includes('fill'), '教材填答題不會被正式卷題型配額排除');
  assert.equal(result.held, false);
  assert.equal(result.obvious, false);
  assert.ok(result.maxTopic <= 2);
});

test('私人教材尚未匯入的單元仍由核心題補位，不因十本題量大而形成範圍盲區', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const fallback = BANK.find((q) => questionIsCoreFallback(q) && q.topic === 'seq');
    S.wrong = { [fallback.id]:{ fails:2, wins:0, due:today(), mt:Date.now(), err:'還不熟' } };
    const queue = adaptiveTextbookQueue(10);
    return {
      fallbackId:fallback.id,
      selected:queue.some((q) => q.id === fallback.id),
      reason:questionSelectionReason(fallback, adaptiveTextbookQueue.lastSignals),
      allSafe:queue.every((q) => questionIsCoreFallback(q) || q.bookId || q.src),
    };
  })()`));
  assert.equal(result.selected, true);
  assert.equal(result.allSafe, true);
  assert.match(result.reason, /間隔重測|核心題補齊範圍/);
});

test('已匯入的人工核准教材題會取代同單元核心補位題', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const core = BANK.find((q) => questionIsCoreFallback(q) && q.topic === 'line');
    BANK.length = 0;
    BANK.push(core, {
      id:'line-inequality-p067-q3',
      topic:'line', type:'single', diff:1,
      q:'點 P(3,4) 到直線 L: 12x - 5y + 10 = 0 的距離為多少？',
      opts:['1', '26/17', '20/13', '2', '26/7'], ans:[3],
      bookId:'matha-114-line-inequality', page:69, printedPage:67,
      src:'matha-114-line-inequality p67', role:'chapter-end-easy'
    });
    BANK_MAP = null;
    const queue = adaptiveTextbookQueue(2);
    return {
      ids:queue.map((q) => q.id),
      hasCore:queue.some((q) => questionIsCoreFallback(q)),
      reason:questionSelectionReason(queue[0], adaptiveTextbookQueue.lastSignals),
    };
  })()`));
  assert.deepEqual(result.ids, ['line-inequality-p067-q3']);
  assert.equal(result.hasCore, false);
  assert.match(result.reason, /教材章末基礎題/);
});

test('教材角色依目前掌握度走打底、銜接、伸展階梯，不會對斷裂單元硬塞難題', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const example = { role:'example', diff:2 };
    const bridge = { role:'unclassified', diff:2 };
    const hard = { role:'chapter-end-hard', diff:3 };
    return {
      weak:[questionRoleFitWeight(example, .3, { l3:1 }), questionRoleFitWeight(hard, .3, { l3:1 })],
      middle:[questionRoleFitWeight(bridge, .55, {}), questionRoleFitWeight(example, .55, {})],
      strong:[questionRoleFitWeight(hard, .85, {}), questionRoleFitWeight(example, .85, {})],
      bands:[questionTrainingBand(example), questionTrainingBand(bridge), questionTrainingBand(hard)],
    };
  })()`));
  assert.ok(result.weak[0] > result.weak[1], '卡在第三級時應先用例題建立路線');
  assert.ok(result.middle[0] > result.middle[1], '已有基本方向時應以銜接題為主');
  assert.ok(result.strong[0] > result.strong[1], '掌握穩定後才提高章末進階題');
  assert.deepEqual(result.bands, ['foundation', 'bridge', 'stretch']);
});

test('教材精選冷啟動與能力變化都有明確三帶配額，不再整輪只出同一類題', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const cold = adaptiveBandTargets(10, { topics:{} });
    const weak = adaptiveBandTargets(10, { topics:{ num:{ n:10, ok:3 } } });
    const strong = adaptiveBandTargets(10, { topics:{ num:{ n:10, ok:8 } } });
    const topics = Object.keys(TOPICS).slice(0, 6);
    BANK.push(...Array.from({length:36}, (_, i) => ({
      id:'band-quota-' + i, topic:topics[i % topics.length], type:'fill',
      diff:(i % 3) + 1, q:'訓練帶配額題 ' + i, ans:[String(i)], sol:'解',
      src:'114班·實數與數線', role:i % 3 === 0 ? 'example' : i % 3 === 2 ? 'chapter-end-hard' : 'unclassified'
    })));
    BANK_MAP = null;
    const queue = adaptiveTextbookQueue(10);
    const actual = queue.reduce((out, q) => { out[questionTrainingBand(q)]++; return out; }, { foundation:0, bridge:0, stretch:0 });
    const sources = queue.reduce((out, q) => { const key = questionSourceBucket(q); out[key] = (out[key] || 0) + 1; return out; }, {});
    const hard = queue.find((q) => questionTrainingBand(q) === 'stretch');
    return { cold, weak, strong, actual, target:adaptiveTextbookQueue.lastBandTargets, sources,
      hardReason:hard ? questionSelectionReason(hard, adaptiveTextbookQueue.lastSignals) : '' };
  })()`));
  assert.deepEqual(result.cold, { foundation:3, bridge:5, stretch:2, evidenceN:0, acc:null });
  assert.deepEqual(result.weak, { foundation:4, bridge:5, stretch:1, evidenceN:10, acc:.3 });
  assert.deepEqual(result.strong, { foundation:2, bridge:4, stretch:4, evidenceN:10, acc:.8 });
  assert.deepEqual(result.actual, { foundation:3, bridge:5, stretch:2 });
  assert.deepEqual(result.target, result.cold);
  assert.ok(Object.keys(result.sources).length >= 5, '10 題正常情況至少跨 5 個教材／核心單元來源');
  assert.ok(Math.max(...Object.values(result.sources)) <= 2, '同一本教材正常情況最多 2 題');
  assert.doesNotMatch(result.hardReason, /目前掌握度已適合/, '沒有作答證據時不可假稱已適合進階');
});

test('看過詳解的訂正不冒充獨立答對，猜中與一眼會寫分開處理', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const q = BANK.find((row) => row.topic === 'num');
    S.attempts = [
      { qid:q.id, ok:true, mode:'correction', d:today(), ts:1 },
      { qid:q.id, ok:true, mode:'mixed', confidence:'guess', err:'用猜的', d:addDays(today(), -3), ts:2 },
    ];
    S.corrections = [{ entries:[{ qid:q.id, done:true, level:3 }] }];
    S.visionHistory = [{ qid:q.id, outcome:'obvious', d:today(), ts:3 }];
    const row = learningSignalIndex().questions.get(q.id);
    return { n:row.n, ok:row.ok, guess:row.guess, l3:row.l3, obvious:row.obvious };
  })()`));
  assert.deepEqual(result, { n:1, ok:.15, guess:1, l3:1, obvious:1 });
});

test('全真多選採部分計分，模考錯題排到隔天且當天不開放', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    mock = { judge:{} };
    const q = { id:'x', type:'multi', opts:['a','b','c','d','e'], ans:[0,2], points:5 };
    const oneError = mockAnswerResult(q, { type:'multi', v:[0] });
    const detail = [{ q:{ id:BANK[0].id, examNo:1, examSection:'single', points:5 }, ok:false, yourAns:'(2)', answered:true }];
    S.corrections = [];
    const batch = queueMockCorrection(detail, 123);
    return { points:oneError.points, due:batch.due, today:today(), dueNow:dueCorrections().length };
  })()`));
  assert.equal(result.points, 3);
  assert.notEqual(result.due, result.today);
  assert.equal(result.dueNow, 0);
});

test('主要導覽只留下新版五條路，章節與速度工具不再佔主入口', () => {
  const { run } = loadApp();
  const views = plain(run('Object.entries(VIEWS).map(([key, value]) => [key, value.label])'));
  assert.deepEqual(views, [
    ['home', '今日'],
    ['outline', '大綱默寫'],
    ['mock', '模考與破題'],
    ['correct', '隔日訂正'],
    ['concept', '觀念理解'],
  ]);
  assert.equal(run("Object.values(VIEWS).some((v) => /章節|速度|番茄/.test(v.label))"), false);
  assert.deepEqual(plain(run('Object.keys(LEGACY_VIEWS)')), ['stats']);
});

test('十一單元固定保留空白頁，完成後固定兩天再測', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.outlineAttempts = [];
    S.extoutlines = OUTLINE_DEFAULTS.map((x, i) => ({ ...x, title:'單元' + (i + 1), reference:'重點' + (i + 1) }));
    const first = outlineDueUnits().length;
    S.outlineAttempts.push({ id:'oa1', unitId:'outline-1', d:today(), ts:1, due:addDays(today(), 2), coverage:70 });
    return { count:outlineUnits().length, first, dueNow:outlineDueUnits().length, dueDate:outlineLast('outline-1').due };
  })()`));
  assert.equal(result.count, 11);
  assert.equal(result.first, 11);
  assert.equal(result.dueNow, 10);
  assert.notEqual(result.dueDate, run('today()'));
});

test('十一單元未到兩天不能提前重寫並順延原定重測', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    renderOutlineSheet = () => {};
    let alerts = 0; alert = () => { alerts++; };
    const unit = OUTLINE_DEFAULTS[0];
    const due = addDays(today(), 2);
    S.outlineAttempts = [{ id:'locked-outline', unitId:unit.id, d:today(), ts:1, due, coverage:70 }];
    outlineSess = null; sessionActive = false;
    startOutlineRecall(unit.id);
    const locked = { alerts, started:!!outlineSess, active:sessionActive, due:outlineLast(unit.id).due };
    S.outlineAttempts[0].due = today();
    startOutlineRecall(unit.id);
    return { locked, opened:!!outlineSess, originalDue:due };
  })()`));
  assert.deepEqual(result.locked, { alerts:1, started:false, active:false, due:result.originalDue });
  assert.equal(result.opened, true);
});

test('十一單元大綱來源已完整建立語意核對基準', () => {
  const { run } = loadApp();
  const result = plain(run(`OUTLINE_DEFAULTS.map((unit) => ({ id:unit.id, title:unit.title, n:unit.reference.length }))`));
  assert.deepEqual(result.map((x) => x.title), [
    '集合、邏輯與實數系', '直角坐標系中直線、半平面與圓', '函數與多項式函數', '三角比與三角函數',
    '有限數列與有限級數', '數據分析', '排列組合與機率', '指數與對數',
    '平面向量、線性組合與二階行列式', '空間中的向量與直線、平面方程式', '矩陣與線性變換及其應用',
  ]);
  assert.equal(result.every((x, i) => x.id === `outline-${i + 1}` && x.n >= 150), true);
  assert.equal(run("OUTLINE_DEFAULTS[9].reference.includes('高斯消去')"), true);
  assert.equal(run("OUTLINE_DEFAULTS[10].reference.includes('線性變換')"), true);
});

test('重要定義卡覆蓋數 A 十四單元，要求以自己的話解釋而非背字句', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => ({
    topics:Object.keys(TOPICS),
    covered:[...new Set(CONCEPT_CARDS.map((card) => card.unit))],
    cards:CONCEPT_CARDS.map((card) => ({ prompt:card.prompt, reference:card.reference }))
  }))()`));
  assert.deepEqual(result.topics.filter((topic) => !result.covered.includes(topic)), []);
  assert.ok(result.cards.length >= 18);
  assert.equal(result.cards.every((card) => card.prompt.length >= 20 && card.reference.length >= 35), true);
});

test('私有原版模考保留三回舊卷，並加入十四回完整單頁卷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const scans = PAPER_SOURCES.flatMap((source) => source.scans.map((scan) => scan.file));
    return { bucket:PAPER_SOURCE_BUCKET, papers:PAPER_SOURCES.map((source) => ({ q:source.questions, min:source.minutes, pages:source.pages, scans:source.scans.length, sides:source.scans.map((scan) => scan.side) })), scans, unique:new Set(scans).size };
  })()`));
  assert.equal(result.bucket, 'matha-papers');
  assert.deepEqual(result.papers.slice(0, 3), [
    { q:20, min:100, pages:6, scans:6, sides:['left','right','left','right','left','right'] },
    { q:19, min:100, pages:6, scans:6, sides:['left','right','left','right','left','right'] },
    { q:20, min:100, pages:4, scans:4, sides:['left','right','left','right'] },
  ]);
  assert.equal(result.papers.length, 17);
  assert.equal(result.papers.slice(3).every((paper) => paper.q === 20 && paper.min === 100 && paper.pages === paper.scans && [3,4,8].includes(paper.pages) && paper.sides.every((side) => side === 'full')), true);
  assert.equal(result.scans.length, 89);
  assert.equal(result.unique, 81);
  assert.equal(result.scans.slice(16).every((name) => /^(?:official-(?:11[1-5]|110-trial)|regional-ra(?:4109|4110|3101|3102|1104|2100|2101|1103))-matha\/page-0[1-8]-[a-f0-9]{12}\.png$/.test(name)), true);
});

test('十四回完整卷的 20 題都綁到明示題本頁且不混入答案頁', () => {
  const { run } = loadApp();
  const result = plain(run(`PAPER_SOURCES.filter((source) => source.fullPaperSource).map((source) => ({
    id:source.id,
    pages:source.pages,
    map:Array.from({length:source.questions}, (_, index) => paperQuestionScanIndex(source, index + 1) + 1),
    configured:source.questionPageMap,
    freshnessRequired:source.freshnessRequired,
  }))`));
  assert.deepEqual(result.map((paper) => paper.id), [
    'paper-regional-ra4109', 'paper-regional-ra4110', 'paper-regional-ra3101', 'paper-regional-ra3102',
    'paper-regional-ra1104', 'paper-regional-ra2100', 'paper-regional-ra2101', 'paper-regional-ra1103',
    'paper-official-115', 'paper-official-114', 'paper-official-113', 'paper-official-112', 'paper-official-111', 'paper-official-110-trial',
  ]);
  assert.equal(result.every((paper) => paper.map.length === 20 && paper.map.every((page) => page >= 1 && page <= paper.pages)), true);
  assert.equal(result.every((paper) => JSON.stringify(paper.map) === JSON.stringify(paper.configured)), true);
  assert.equal(result.every((paper) => paper.freshnessRequired === true), true);
});

test('原卷卡明示九回有逐題官方詳解，其餘卷不會冒充有完整出版者解答', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const sources = PAPER_SOURCES.filter((source) => source.questions === 20);
    const full = sources.filter((source) => source.officialSolutionCoverage === 'full');
    return {
      ids:full.map((source) => source.id),
      fullHtml:paperSourceCardHTML(full[0]),
      limitedHtml:paperSourceCardHTML(sources.find((source) => source.fullPaperSource && source.officialSolutionCoverage !== 'full')),
    };
  })()`));
  assert.equal(result.ids.length, 9);
  assert.deepEqual(result.ids.slice(0, 2), ['paper-regional-ra4109', 'paper-regional-ra4110']);
  assert.equal(result.ids.includes('paper-official-110-trial'), true);
  assert.match(result.fullHtml, /有逐題官方詳解|出版者完整詳解原圖/);
  assert.match(result.limitedHtml, /沒有全題出版者詳解原圖/);
});

test('官方卷只有本人確認未看過才會進正式級分校準', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const sourceId = 'paper-official-115';
    const base = { id:'external-r1', paperRunId:'r1', sourceId, questions:20 };
    S.paperRuns = [{ id:'r1', sourceId }];
    const withoutConfirmation = extMockCalibrationEligible(base);
    S.paperRuns[0].freshnessConfirmedAt = 123;
    const confirmedOnRun = extMockCalibrationEligible(base);
    delete S.paperRuns[0].freshnessConfirmedAt;
    const confirmedOnRecord = extMockCalibrationEligible({ ...base, freshnessConfirmedAt:456 });
    return { withoutConfirmation, confirmedOnRun, confirmedOnRecord };
  })()`));
  assert.deepEqual(result, {
    withoutConfirmation:false,
    confirmedOnRun:true,
    confirmedOnRecord:true,
  });
});

test('模考與破題把原版模考置頂，並依每回自動日期保留可回看的批改歷史', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    S.paperRuns = [{
      id:'history-run-1', sourceId:source.id, name:source.title, d:'2026-07-18',
      createdAt:100, submittedAt:200, status:'awaiting-correction', due:'2026-07-19',
      score:75, wrongNos:[2, 5, 12], aiGrade:{ score:75, wrongNos:[2, 5, 12], questions:[] },
    }];
    S.mocks = []; S.visionQueue = [];
    renderMockIntro();
    const html = __app.innerHTML;
    return {
      html,
      paperAt:html.indexOf('原版模考'),
      systemAt:html.indexOf('全真模考'),
      date:paperRunDisplayDate(S.paperRuns[0]),
      fallbackDate:paperRunDisplayDate({ submittedAt:Date.parse('2026-07-17T16:30:00Z') }),
    };
  })()`));
  assert.ok(result.paperAt >= 0 && result.paperAt < result.systemAt);
  assert.equal(result.date, '2026-07-18');
  assert.equal(result.fallbackDate, '2026-07-18');
  assert.match(result.html, /原卷作答歷史/);
  assert.match(result.html, /2026-07-18/);
  assert.match(result.html, /75\/100/);
  assert.match(result.html, /查看紅筆卷/);
  assert.match(result.html, /逐題紀錄/);
});

test('原版工作台把筆跡畫布直接覆蓋在題目與右側留白，不再壓縮成左右分割', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const html = run(`(() => {
    sessionChrome = () => {}; paperInkAttach = () => {}; startTicker = () => {};
    const source = PAPER_SOURCES[0], row = { id:'write-1', status:'active', remainingMs:6000000, resumeAt:Date.now(), answers:{} };
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:0, zoom:1, inkMode:'pen' };
    renderPaperSource();
    return __app.innerHTML;
  })()`);
  assert.match(html, /paper-write-sheet/);
  assert.match(html, /paper-question-crop/);
  assert.match(html, /paper-note-margin/);
  assert.match(html, /整個畫面皆可直接書寫並左右滑動翻頁/);
  assert.match(html, /id="paper-ai-canvas"/);
  assert.match(html, /id="paper-pen-width" type="range" min="35" max="200" step="5"/);
  assert.match(html, /id="paper-color-black"/);
  assert.match(html, /id="paper-color-blue"/);
  assert.match(html, /id="paper-color-green"/);
  assert.match(html, /id="paper-ui-toggle"/);
  assert.match(html, /aria-label="收起工具"/);
  assert.match(html, /交卷並第一次批改/);
  assert.match(html, /調整畫筆粗細/);
  assert.doesNotMatch(html, /paper-pane-caption|paper-write-hint|paper-spread-preview/);
  assert.doesNotMatch(html, /paperAnswerOpen|paper-answer-button|答案卡已填/);
  assert.doesNotMatch(html, /paper-color-red|紅色筆/);
  assert.doesNotMatch(html, /paper-draft-pane|paper-view-switch/);
});

test('原版題本預設使用 cover 尺寸，直向滿高、橫向滿寬且不受 1180px 上限', () => {
  const { context, run } = loadApp();
  const result = plain(run(`(() => {
    const pane = { clientWidth:924, clientHeight:1480 };
    const sheet = { style:{} };
    document.querySelector = (selector) => selector === '.paper-page-viewport' ? pane : selector === '#paper-write-sheet' ? sheet : null;
    paperSourceSession = { zoom:1, inkPages:{ 0:{ s:[], loaded:true } }, page:0 };
    paperWorkspaceFit();
    const portrait = { fit:paperSourceSession.fitWidth, width:sheet.style.width, max:sheet.style.maxWidth };
    pane.clientWidth = 1707; pane.clientHeight = 791; sheet.style = {};
    paperWorkspaceFit();
    const landscape = { fit:paperSourceSession.fitWidth, width:sheet.style.width, max:sheet.style.maxWidth };
    return { portrait, landscape };
  })()`));
  assert.equal(Math.round(result.portrait.fit), 1233);
  assert.equal(result.portrait.width, `${result.portrait.fit}px`);
  assert.equal(result.portrait.max, 'none');
  assert.equal(result.landscape.fit, 1707);
  assert.equal(result.landscape.width, '1707px');
  assert.equal(result.landscape.max, 'none');
  context.document.querySelector = () => null;
});

test('原版模考每一筆保存當下粗細，調整後不會改變既有筆跡', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const widths = [];
    const ctx = { lineWidth:0, set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){ widths.push(this.lineWidth); } };
    const pts = [[.1,.1,.5],[.2,.2,.5]];
    paperInkLine(ctx, { pts, w:.4 }, 100, 100);
    paperInkLine(ctx, { pts, w:1.6 }, 100, 100);
    paperInkLine(ctx, { pts }, 100, 100);
    const label = { textContent:'' };
    document.querySelector = (selector) => selector === '#paper-pen-width-label' ? label : null;
    paperSourceSession = { inkWidth:1, run:{ mt:0 } };
    paperInkWidthSet(45); clearTimeout(paperStateSaveTimer);
    return { widths, selected:paperSourceSession.inkWidth, saved:paperSourceSession.run.paperInkWidth, label:label.textContent };
  })()`));
  assert.deepEqual(result.widths.map((n) => Math.round(n * 100) / 100), [.84, 3.36, 2.1]);
  assert.equal(result.selected, .45);
  assert.equal(result.saved, .45);
  assert.equal(result.label, '45%');
});

test('原版模考只提供黑藍綠三種學生筆色，且每一筆保存自己的顏色', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const colors = [];
    const ctx = { lineWidth:0, set strokeStyle(v){ colors.push(v); }, set lineCap(v){}, set lineJoin(v){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} };
    const pts = [[.1,.1,.5],[.2,.2,.5]];
    paperInkLine(ctx, { pts, c:'black' }, 100, 100);
    paperInkLine(ctx, { pts, c:'blue' }, 100, 100);
    paperInkLine(ctx, { pts, c:'green' }, 100, 100);
    paperInkLine(ctx, { pts, c:'red' }, 100, 100);
    paperSourceSession = { inkColor:'black', inkMode:'pen', run:{ mt:0 } };
    paperInkColorSet('blue'); clearTimeout(paperStateSaveTimer);
    paperInkColorSet('red'); clearTimeout(paperStateSaveTimer);
    return { keys:Object.keys(PAPER_INK_COLORS), colors, selected:paperSourceSession.inkColor, saved:paperSourceSession.run.paperInkColor, ai:PAPER_AI_RED };
  })()`));
  assert.deepEqual(result.keys, ['black', 'blue', 'green']);
  assert.deepEqual(result.colors, ['#343a36', '#315f78', '#4f7158', '#343a36']);
  assert.equal(result.selected, 'blue');
  assert.equal(result.saved, 'blue');
  assert.equal(result.ai, '#b43b32');
});

test('S Pen 側鍵暫時切換橡皮擦，懸停不誤刪且放開恢復原工具', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const active = { pen:false, erase:false }, status = { textContent:'' };
    const button = (key) => ({ classList:{ toggle(name, value){ if (name === 'active') active[key] = value; } } });
    const ctx = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, set strokeStyle(v){}, set lineCap(v){}, set lineJoin(v){}, set lineWidth(v){} };
    const canvas = {
      clientWidth:1000, clientHeight:1000, width:1000, height:1000, dataset:{},
      setPointerCapture(){}, closest(){ return null; }, getContext(){ return ctx; },
      getBoundingClientRect(){ return { left:0, top:0, width:1000, height:1000 }; },
    };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas
      : selector === '#paper-tool-pen' ? button('pen')
      : selector === '#paper-tool-erase' ? button('erase')
      : selector === '#paper-ink-status' ? status : null;
    const stroke = { pts:[[.4,.5,.5],[.6,.5,.5]] };
    paperSourceSession = { inkMode:'pen', inkWidth:1, inkPages:{ 0:{ s:[stroke], loaded:true } }, page:0, run:{ id:'spen', createdAt:1 } };
    const pen = (type, buttons, pressure) => ({ type, pointerType:'pen', pointerId:7, button:type === 'pointerdown' ? 2 : -1, buttons, pressure, clientX:500, clientY:500, currentTarget:canvas, preventDefault(){} });
    const mapping = {
      barrel:paperInkPenErasePressed({ pointerType:'pen', buttons:2 }),
      barrelWithTip:paperInkPenErasePressed({ pointerType:'pen', buttons:3 }),
      samsungBarrel:paperInkPenErasePressed({ pointerType:'pen', buttons:4 }),
      samsungWithTip:paperInkPenErasePressed({ pointerType:'pen', buttons:5 }),
      tail:paperInkPenErasePressed({ pointerType:'pen', buttons:32 }),
      androidSecondary:paperInkPenErasePressed({ pointerType:'pen', buttons:64 }),
      samsungDown:paperInkPenErasePressed({ type:'pointerdown', pointerType:'pen', button:1, buttons:0 }),
      fallback:paperInkPenErasePressed({ type:'pointerdown', pointerType:'pen', button:2, buttons:0 }),
      released:paperInkPenErasePressed({ type:'pointermove', pointerType:'pen', button:2, buttons:1 }),
      mouse:paperInkPenErasePressed({ pointerType:'mouse', buttons:2 }),
    };
    paperInkDown(pen('pointerdown', 2, 0));
    const hover = { deleted:!!stroke.dead, mode:canvas.dataset.mode, status:status.textContent };
    paperInkMove(pen('pointermove', 3, .6));
    const contact = { deleted:!!stroke.dead, mode:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkUp(pen('pointerup', 0, 0));
    const restored = { mode:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkSaveTimersClearAll(); clearTimeout(paperInkCloudTimer);
    return { mapping, hover, contact, restored };
  })()`));
  assert.deepEqual(result.mapping, { barrel:true, barrelWithTip:true, samsungBarrel:true, samsungWithTip:true, tail:true, androidSecondary:true, samsungDown:true, fallback:true, released:false, mouse:false });
  assert.deepEqual(result.hover, { deleted:false, mode:'erase', status:'S Pen 側鍵按住：暫時橡皮擦' });
  assert.deepEqual(result.contact, { deleted:true, mode:'erase', status:'S Pen 側鍵按住：暫時橡皮擦', active:{ pen:false, erase:true } });
  assert.deepEqual(result.restored, { mode:'pen', status:'筆跡自動保存', active:{ pen:true, erase:false } });
});

test('逐題模考與十一單元共用的整頁畫布支援 S Pen 按住擦、放開恢復筆', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const status = { hidden:true, textContent:'' };
    const ctx = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, set strokeStyle(v){}, set lineWidth(v){}, set lineCap(v){}, set lineJoin(v){} };
    const canvas = {
      dataset:{}, style:{}, classList:{ contains(){ return true; } }, parentElement:{ clientWidth:800, clientHeight:900 }, clientWidth:800, clientHeight:900, width:800, height:900,
      getContext(){ return ctx; }, setPointerCapture(){}, getBoundingClientRect(){ return { left:0, top:0, width:800, height:900 }; }, closest(){ return null; },
    };
    document.querySelector = (selector) => selector === '#ink-s-pen-status' ? status : selector === '#ink-cv' ? canvas : null;
    const stroke = { t0:10, c:'k', pts:[[100,100],[200,100]] };
    sessionInk.shared = { s:[stroke], e:[] };
    ink = { qid:'shared', t0:1, clientId:'shared-client', penAt:0, sur:{} };
    const sur = inkSurface('calc', canvas, 900); ink.sur.calc = sur;
    const pen = (type, buttons, x, y) => ({ type, pointerType:'pen', pointerId:12, button:type === 'pointerdown' ? 1 : -1, buttons, pressure:type === 'pointerup' ? 0 : .6, clientX:x, clientY:y, currentTarget:canvas, preventDefault(){} });
    inkDown(pen('pointerdown', 5, 150, 100), sur);
    const pressed = { dead:!!stroke.dead, mode:canvas.dataset.mode, hidden:status.hidden, status:status.textContent };
    inkMove(pen('pointermove', 1, 300, 300), sur);
    const released = { mode:canvas.dataset.mode, hidden:status.hidden, status:status.textContent, drawing:!!sur.cur };
    inkUp(pen('pointerup', 0, 300, 300), sur);
    clearTimeout(inkCheckpointTimer);
    return { pressed, released, direct:sPenErasePressed({ type:'pointerdown', pointerType:'pen', button:1, buttons:0 }) };
  })()`));
  assert.deepEqual(result.pressed, { dead:true, mode:'erase', hidden:false, status:'側鍵按住：橡皮擦' });
  assert.deepEqual(result.released, { mode:'pen', hidden:true, status:'', drawing:true });
  assert.equal(result.direct, true);
});

test('三星 Chrome 的懸停 button=1 只在按住期間暫時使用橡皮擦', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const active = { pen:false, erase:false }, status = { textContent:'' };
    const button = (key) => ({ classList:{ toggle(name, value){ if (name === 'active') active[key] = value; } } });
    const canvas = { dataset:{} };
    document.querySelector = (selector) => selector === '#paper-ink-canvas' ? canvas
      : selector === '#paper-tool-pen' ? button('pen')
      : selector === '#paper-tool-erase' ? button('erase')
      : selector === '#paper-ink-status' ? status : null;
    paperSourceSession = { inkMode:'pen', inkPointer:null };
    const hover = (buttonValue) => ({ type:'pointermove', pointerType:'pen', pointerId:9, button:buttonValue, buttons:buttonValue === 1 ? 4 : 0, pressure:0, currentTarget:canvas, preventDefault(){} });
    paperInkMove(hover(1));
    const pressed = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkMove(hover(1));
    const stillHeld = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode };
    paperInkMove(hover(-1));
    const released = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, active:{ ...active } };
    paperInkMove(hover(1));
    let prevented = false;
    paperInkContextMenu({ preventDefault(){ prevented = true; } });
    const menu = { held:paperSourceSession.sPenButtonHeld, mode:paperSourceSession.inkMode, shown:canvas.dataset.mode, status:status.textContent, prevented };
    return { pressed, stillHeld, released, menu };
  })()`));
  assert.deepEqual(result.pressed, { held:true, mode:'pen', shown:'erase', status:'S Pen 側鍵按住：暫時橡皮擦', active:{ pen:false, erase:true } });
  assert.deepEqual(result.stillHeld, { held:true, mode:'pen' });
  assert.deepEqual(result.released, { held:false, mode:'pen', shown:'pen', status:'筆跡自動保存', active:{ pen:true, erase:false } });
  assert.deepEqual(result.menu, { held:false, mode:'pen', shown:'pen', status:'筆跡自動保存', prevented:true });
});

test('原版模考支援雙指以手勢中心縮放，放開一指後恢復單指拖曳', () => {
  const { context, run } = loadApp();
  const result = plain(run(`(() => {
    const pane = { scrollLeft:0, scrollTop:0 };
    const label = { textContent:'' };
    const inkContext = { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){} };
    const canvas = {
      clientWidth:1000, clientHeight:1200, width:1000, height:1200, dataset:{},
      setPointerCapture(){}, closest(){ return pane; }, getContext(){ return inkContext; },
      getBoundingClientRect(){ return { left:100 - pane.scrollLeft, top:100 - pane.scrollTop, width:1000 * paperSourceSession.zoom, height:1200 * paperSourceSession.zoom }; },
    };
    const sheet = {
      style:{},
      getBoundingClientRect(){ return { left:100 - pane.scrollLeft, top:100 - pane.scrollTop, width:1000 * paperSourceSession.zoom, height:1200 * paperSourceSession.zoom }; },
    };
    document.querySelector = (selector) => selector === '#paper-write-sheet' ? sheet : selector === '#paper-zoom-label' ? label : selector === '#paper-ink-canvas' ? canvas : null;
    paperSourceSession = { zoom:1, inkMode:'pen', inkPages:{ 0:{ s:[], loaded:true } }, page:0 };
    const touch = (pointerId, clientX, clientY) => ({ pointerType:'touch', pointerId, clientX, clientY, currentTarget:canvas, preventDefault(){} });
    paperInkAttach();
    paperInkDown(touch(1, 200, 200));
    paperInkDown(touch(2, 400, 200));
    paperInkMove(touch(2, 600, 200));
    const pinch = { zoom:paperSourceSession.zoom, label:label.textContent, left:pane.scrollLeft, top:pane.scrollTop, strokes:paperInkPage().s.length };
    paperInkUp(touch(2, 600, 200));
    const release = { pinching:!!paperSourceSession.inkPinch, touchId:paperSourceSession.inkTouch && paperSourceSession.inkTouch.id, touches:paperSourceSession.inkTouches.size };
    paperWorkspaceSetZoom(9); const max = paperSourceSession.zoom;
    paperWorkspaceSetZoom(.1); const min = paperSourceSession.zoom;
    return { pinch, release, max, min };
  })()`));
  assert.deepEqual(result.pinch, { zoom:2, label:'200%', left:100, top:100, strokes:0 });
  assert.deepEqual(result.release, { pinching:false, touchId:1, touches:1 });
  assert.equal(result.max, 4);
  assert.equal(result.min, .75);
  context.document.querySelector = () => null;
});

test('原版模考單指水平滑動翻頁；題本放大或尚未移到邊界時只平移不誤翻', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => ({
    next:paperTouchPageDelta({ startX:400, startY:200, x:285, y:208 }),
    prev:paperTouchPageDelta({ startX:200, startY:200, x:310, y:190 }),
    short:paperTouchPageDelta({ startX:200, startY:200, x:145, y:203 }),
    vertical:paperTouchPageDelta({ startX:200, startY:200, x:105, y:320 }),
    pinched:paperTouchPageDelta({ startX:400, startY:200, x:285, y:208, swipeBlocked:true }),
    coverCenter:paperTouchPanBlocksPage({ startX:300, x:170, startScrollLeft:120, maxScrollLeft:309 }, 1),
    coverLeftPrev:paperTouchPanBlocksPage({ startX:200, x:310, startScrollLeft:0, maxScrollLeft:309 }, 1),
    coverRightNext:paperTouchPanBlocksPage({ startX:400, x:285, startScrollLeft:309, maxScrollLeft:309 }, 1),
    zoomed:paperTouchPanBlocksPage({ startX:400, x:285, startScrollLeft:309, maxScrollLeft:309 }, 1.25),
  }))()`));
  assert.deepEqual(result, {
    next:1, prev:-1, short:0, vertical:0, pinched:0,
    coverCenter:true, coverLeftPrev:false, coverRightNext:false, zoomed:true,
  });
});

test('原版隔日訂正會定位到每題真正所在的清晰單頁，新舊筆跡版面不混用', () => {
  const { run } = loadApp();
  const result = plain(run(`({
    maps:PAPER_SOURCES.map((source) => Array.from({length:source.questions}, (_, i) => paperQuestionScanIndex(source, i + 1))),
    qid:paperInkQid({id:'run-1'}, 3), version:PAPER_LAYOUT_VERSION,
  })`));
  assert.deepEqual(result.maps[0], [0,0,0,0,0,1,1,1,2,2,2,3,3,3,4,4,4,5,5,5]);
  assert.deepEqual(result.maps[1], [0,0,0,0,1,1,1,2,2,2,3,3,3,4,4,4,4,5,5]);
  assert.deepEqual(result.maps[2], [0,0,0,0,0,1,1,1,2,2,2,2,2,3,3,3,3,3,3,3]);
  assert.equal(result.version, 2);
  assert.equal(result.qid, 'paper:run-1:v2:3');
});

test('GPT-5.5 第一次整卷批改保存對錯、分數與正式答案，但不保存詳解或步驟診斷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:i === 1 ? '手寫 99' : '作答',
      status:i === 1 ? 'incorrect' : 'correct', points:i === 1 ? 0 : q.points,
      hasFinalAnswer:true, finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : i === 1 ? [1] : q.ans.map((option) => option + 1),
      marks:[{ kind:i === 1 ? 'cross' : 'check', option:0, box:[.1,.1,.2,.2], label:i === 1 ? '正解是機密答案' : '洩漏詳解' }],
    })), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    const row = { id:'paper-run-1', sourceId:source.id, name:source.title, d:today(), createdAt:1, mt:1, status:'grading', remainingMs:600000, wrongNos:[] };
    S.paperRuns = [row]; S.extMocks = [];
    paperSourceRecordGrade(source, row, grade);
    return {
      status:row.status, due:row.due, today:today(), score:row.score, wrong:row.wrongNos,
      ext:S.extMocks[0], labels:grade.questions.flatMap((q) => q.marks.map((m) => m.label)),
      kinds:grade.questions.flatMap((q) => q.marks.map((m) => m.kind)),
      answers:grade.questions.map((q) => q.answer), model:grade.model,
      hasDetailedFields:grade.questions.some((q) => 'firstError' in q || 'explanation' in q || 'solution' in q),
    };
  })()`));
  assert.equal(result.status, 'awaiting-correction');
  assert.notEqual(result.due, result.today);
  assert.equal(result.score, 95);
  assert.deepEqual(result.wrong, [2]);
  assert.equal(result.ext.paperRunId, 'paper-run-1');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.labels.every((label) => /^(✓ \+\d+(?:\.\d+)?|△ \+\d+(?:\.\d+)?|✕ 0|未作答|看不清楚)$/.test(label)), true);
  assert.equal(result.labels.some((label) => /正解|答案|詳解/.test(label)), false);
  assert.equal(result.kinds.includes('cross'), true);
  assert.equal(result.kinds.includes('check'), true);
  assert.equal(result.answers.length, 20);
  assert.equal(result.answers.every(Boolean), true);
  assert.equal(result.hasDetailedFields, false);
});

test('AI 沒有回傳可信座標時不在卷面假猜紅筆位置', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0], q = source.key[0];
    const raw = { questions:source.key.map((row, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, topic:'num', read:'',
      status:i ? 'correct' : 'incorrect', hasFinalAnswer:true, finalAnswer:'',
      selectedOptions:row.type === 'fill' ? [] : [i ? row.ans[0] + 1 : ((row.ans[0] + 1) % 5) + 1], points:0, marks:[]
    })), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return grade.questions[0].marks[0];
  })()`));
  assert.deepEqual(result.box, []);
  assert.equal(result.unlocalized, true);
});

test('交卷會合成全部單頁、呼叫一次整卷批改並直接進入紅筆唯讀結果', async () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(await run(`(async () => {
    save = () => {}; sessionChrome = () => {}; stopTicker = () => {};
    paperInkPersist = async () => true;
    const composed = [];
    paperPageComposite = async (page) => { composed.push(page); return 'page-' + page; };
    paperAiGradeCall = async (source, pages) => ({ model:'gpt-5.5', json:{ questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:'作答', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1), points:q.points, marks:[],
    })), note:'' } });
    let rendered = 0; renderPaperGradeResult = () => { rendered++; };
    const source = PAPER_SOURCES[0], row = { id:'grade-flow', sourceId:source.id, name:source.title, d:today(), createdAt:1, mt:1, status:'active', remainingMs:6000000, resumeAt:Date.now(), wrongNos:[] };
    S.paperRuns = [row]; S.extMocks = [];
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:3, zoom:2, inkMode:'pen', inkWidth:1, inkColor:'black' };
    sessionActive = true; sessionMode = 'paper-source';
    await paperSourceGrade('主動交卷');
    return { composed, status:row.status, score:row.score, due:row.due, today:today(), readOnly:paperSourceSession.readOnly, page:paperSourceSession.page, zoom:paperSourceSession.zoom, mode:sessionMode, active:sessionActive, rendered, ext:S.extMocks.length };
  })()`));
  assert.deepEqual(result.composed, [0, 1, 2, 3, 4, 5]);
  assert.equal(result.status, 'awaiting-correction');
  assert.equal(result.score, 100);
  assert.notEqual(result.due, result.today);
  assert.equal(result.readOnly, true);
  assert.equal(result.page, 0);
  assert.equal(result.zoom, 1);
  assert.equal(result.mode, 'paper-result');
  assert.equal(result.active, false);
  assert.equal(result.rendered, 1);
  assert.equal(result.ext, 1);
});

test('第一次整卷結果直接疊加對錯、分數與正確答案，不再出現答案卡或人工分數欄位', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const html = run(`(() => {
    sessionChrome = () => {}; paperInkAttach = () => {};
    const source = PAPER_SOURCES[0], row = {
      id:'red-result', name:source.title, due:addDays(today(), 1),
      aiGrade:{ score:95, wrongNos:[2], uncertainNos:[], questions:[], model:'gpt-5.5' },
    };
    paperSourceSession = { source, run:row, urls:source.scans.map((_, i) => 'blob:' + i), inkPages:{}, page:0, zoom:1, readOnly:true };
    renderPaperGradeResult();
    return __app.innerHTML;
  })()`);
  assert.match(html, /第一次批改｜對錯、分數、正確答案/);
  assert.match(html, /你的原筆跡＋AI 紅筆標記/);
  assert.match(html, /id="paper-ink-canvas"/);
  assert.match(html, /id="paper-ai-canvas" aria-label="AI 紅筆批改標記"/);
  assert.match(html, /95 \/ 100/);
  assert.match(html, /錯題：2/);
  assert.match(html, /逐題詳解於/);
  assert.doesNotMatch(html, /paper-score|paper-wrong|paperAnswer|答案卡/);
});

test('既有兩回答案維持歷史相容，其餘十五回答案不打包進公開前端', () => {
  const { run } = loadApp();
  const result = plain(run(`PAPER_SOURCES.map((source) => ({
    questions:source.questions, key:Array.isArray(source.key) ? source.key.length : 0,
    total:Array.isArray(source.key) ? source.key.reduce((sum, q) => sum + q.points, 0) : 0,
    prompt:Array.isArray(source.key) ? paperGradePromptKey(source, source.key) : [],
    answerAccess:source.answerAccess || 'legacy-public',
  }))`));
  assert.deepEqual(result.slice(0, 3).map((x) => [x.questions, x.key, x.total, x.prompt.length, x.answerAccess]), [
    [20, 20, 100, 20, 'legacy-public'],
    [19, 19, 100, 19, 'legacy-public'],
    [20, 0, 0, 0, 'post-submit-server'],
  ]);
  assert.equal(result.length, 17);
  assert.equal(result.slice(2).every((x) => x.questions === 20 && x.key === 0 && x.total === 0 && x.prompt.length === 0 && x.answerAccess === 'post-submit-server'), true);
  assert.equal(result.slice(0, 2).every((x) => x.prompt.every((q) => q.answer && q.page >= 1 && q.page <= 6)), true);
  assert.equal(result.slice(0, 2).every((x) => x.prompt.every((q) => Array.isArray(q.correctOptions))), true);
});

test('第三回只有在交卷狀態成立時才向後端取正式答案', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const source = PAPER_SOURCES[2], calls = [];
    const key = Array.from({length:source.questions}, () => ({type:'single', ans:[0], points:5}));
    openAiInvoke = async (payload) => { calls.push(payload); return {paperKey:key}; };
    let locked = '';
    try { await paperAnswerKeyAfterSubmit(source, {id:'r3', sourceId:source.id, status:'active'}); }
    catch (error) { locked = error.message; }
    const unlocked = await paperAnswerKeyAfterSubmit(source, {id:'r3', sourceId:source.id, status:'grading', submittedAt:123});
    return {locked, calls, length:unlocked.length};
  })()`));
  assert.match(result.locked, /答案仍保持鎖定/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].responseType, 'paper_key');
  assert.deepEqual(result.calls[0].context, {paperRunId:'r3', sourceId:'paper-mock-3'});
  assert.equal(result.length, 20);
});

test('GPT-5.5 多選批分會強制收斂到正式的 5、3、1、0 分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0], multiNos = source.key.map((q, i) => q.type === 'multi' ? i + 1 : 0).filter(Boolean);
    const raw = { questions:source.key.map((q, i) => ({ no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1, read:'', status:'correct', points:q.points, marks:[] })), note:'' };
    const candidates = [2.9, 1.1, .1];
    multiNos.slice(0, 3).forEach((no, i) => { raw.questions[no - 1].status = 'incorrect'; raw.questions[no - 1].points = candidates[i]; });
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return [source.key[multiNos[3] - 1].points, ...multiNos.slice(0, 3).map((no) => grade.questions[no - 1].points)];
  })()`));
  assert.deepEqual(result, [5, 3, 1, 0]);
});

test('官方非選題依公開評分原則給整數部分分，不捏造固定步驟配分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = { id:'paper-test-constructed', questions:1, scans:Array.from({length:8}, () => ({})), questionPageMap:[7] };
    const key = [{ type:'constructed', ans:['體積 10；距離 √94'], display:'體積 10；距離 √94', points:8,
      rubric:[{label:'求出體積'},{label:'比較各頂點距離'}] }];
    const make = (points, finalAnswer, hasFinalAnswer=true) => paperNormalizeAiGrade(source, { questions:[{
      no:1, page:7, topic:'space', read:finalAnswer, status:'incorrect', hasFinalAnswer,
      finalAnswer, selectedOptions:[], points, marks:[],
    }] }, 'gpt-5.5', key).questions[0];
    const prompt = paperGradePromptKey(source, key)[0];
    return { partial:make(3.6, '體積 10'), full:make(8, '體積 10；距離 √94'), blank:make(8, '', false), prompt };
  })()`));
  assert.deepEqual([result.partial.status, result.partial.points], ['incorrect', 4]);
  assert.deepEqual([result.full.status, result.full.points], ['correct', 8]);
  assert.deepEqual([result.blank.status, result.blank.points], ['unanswered', 0]);
  assert.equal(result.prompt.page, 7);
  assert.deepEqual(result.prompt.rubric, [{label:'求出體積'},{label:'比較各頂點距離'}]);
});

test('第一次簡批的單選與填答由正式答案重新核分，不採信模型自稱答對', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:'模型辨識', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })), note:'' };
    raw.questions[0].selectedOptions = [1];
    raw.questions[0].status = 'correct';
    raw.questions[13].finalAnswer = '999';
    raw.questions[13].status = 'correct';
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return {
      score:grade.score,
      q1:{ status:grade.questions[0].status, points:grade.questions[0].points },
      q14:{ status:grade.questions[13].status, points:grade.questions[13].points },
      wrong:grade.wrongNos,
    };
  })()`));
  assert.deepEqual(result, {
    score:90,
    q1:{ status:'incorrect', points:0 },
    q14:{ status:'incorrect', points:0 },
    wrong:[1,14],
  });
});

test('出版社勘誤若允許兩個單選答案，選其中任一個都給滿分但選兩個仍為錯', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = { questions:1, scans:[{}], questionPageMap:[0] };
    const key = [{ type:'single', ans:[0,3], points:5 }];
    const grade = (selectedOptions) => paperNormalizeAiGrade(source, { questions:[{
      no:1, page:1, status:'correct', hasFinalAnswer:true,
      selectedOptions, finalAnswer:'', points:5, marks:[], topic:'functions',
    }] }, 'gpt-5.5', key).questions[0].points;
    return [grade([1]), grade([4]), grade([1,4])];
  })()`));
  assert.deepEqual(result, [5, 5, 0]);
});

test('模型 status 與結構化答案衝突時，以實際辨識答案確定性核分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:'模型辨識', status:'correct', hasFinalAnswer:true,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })) };
    raw.questions[0].status = 'unanswered';
    raw.questions[13].status = 'unanswered';
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return {
      score:grade.score,
      q1:[grade.questions[0].status, grade.questions[0].points],
      q14:[grade.questions[13].status, grade.questions[13].points],
      wrong:grade.wrongNos,
    };
  })()`));
  assert.deepEqual(result, {
    score:100,
    q1:['correct', 5],
    q14:['correct', 5],
    wrong:[],
  });
});

test('重新 AI 批改保留前版稽核快照，且不延後原本隔日訂正日期', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const source = PAPER_SOURCES[0], due = '2026-07-19';
    const oldGrade = { model:'gpt-5.5', gradedAt:1, score:75, wrongNos:[3], uncertainNos:[], questions:[{ no:3, status:'incorrect', points:0, read:'x', marks:[] }] };
    const newGrade = { model:'gpt-5.5', gradedAt:2, score:70, wrongNos:[3,4], uncertainNos:[], questions:[{ no:3, status:'incorrect', points:0, read:'x', marks:[] },{ no:4, status:'incorrect', points:0, read:'y', marks:[] }] };
    const row = { id:'audit-run', sourceId:source.id, name:source.title, d:'2026-07-18', submittedAt:10, due, aiGrade:oldGrade, score:75, remainingMs:1, mt:1 };
    S.extMocks = [{ id:'external-audit-run', paperRunId:'audit-run', score:75, total:100 }];
    paperSourceRecordGrade(source, row, newGrade);
    return {
      due:row.due, submittedAt:row.submittedAt, audits:row.gradeAudit.length,
      previous:row.gradeAudit[0].score, current:row.score,
      ext:S.extMocks.filter((x) => x.paperRunId === 'audit-run').map((x) => x.score),
    };
  })()`));
  assert.deepEqual(result, {
    due:'2026-07-19', submittedAt:10, audits:1, previous:75, current:70, ext:[70],
  });
});

test('第一次簡批依正式答案逐項重算複選，錯選劃掉、漏選補上且不信任模型亂給分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const chosen = {
      8:[1,4],
      11:[3,4],
      12:[1,2,4,5],
      13:[1,3,5],
    };
    const raw = { questions:source.key.map((q, i) => {
      const no = i + 1;
      const selectedOptions = q.type === 'fill' ? []
        : q.type === 'multi' ? (chosen[no] || q.ans.map((option) => option + 1))
        : q.ans.map((option) => option + 1);
      return {
        no, page:paperQuestionScanIndex(source, no) + 1, read:selectedOptions.join('、'),
        status:'correct', hasFinalAnswer:true, finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
        selectedOptions, points:99,
        marks:selectedOptions.map((option, markIndex) => ({
          kind:'check', option, box:[.1 + markIndex * .03,.2,.12 + markIndex * .03,.23], label:'模型亂判',
        })),
      };
    }), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    return [8,11,12,13].map((no) => ({
      no,
      points:grade.questions[no - 1].points,
      status:grade.questions[no - 1].status,
      edits:grade.questions[no - 1].marks.map((mark) => [mark.kind, mark.option]),
      answer:grade.questions[no - 1].answer,
    }));
  })()`));
  assert.deepEqual(result, [
    { no:8, points:5, status:'correct', edits:[['check',1],['check',4]], answer:'(1)(4)' },
    { no:11, points:1, status:'incorrect', edits:[['strike',3],['check',4],['add',5]], answer:'(4)(5)' },
    { no:12, points:3, status:'incorrect', edits:[['check',1],['strike',2],['check',4],['check',5]], answer:'(1)(4)(5)' },
    { no:13, points:1, status:'incorrect', edits:[['strike',1],['check',3],['check',5],['add',4]], answer:'(3)(4)(5)' },
  ]);
});

test('圈住印刷題號並寫不會必須視為未答，不能誤當成同號選項', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const raw = { questions:source.key.map((q, i) => ({
      no:i + 1, page:paperQuestionScanIndex(source, i + 1) + 1,
      read:i === 3 ? '圈住印刷題號 4，寫不會' : '有最終答案',
      status:'correct', hasFinalAnswer:i !== 3,
      finalAnswer:q.type === 'fill' ? String(q.ans[0]) : '',
      selectedOptions:q.type === 'fill' ? [] : q.ans.map((option) => option + 1),
      points:q.points, marks:[],
    })), note:'' };
    const grade = paperNormalizeAiGrade(source, raw, 'gpt-5.5');
    const q4 = grade.questions[3];
    return { status:q4.status, points:q4.points, kind:q4.marks[0].kind, answer:q4.answer, score:grade.score };
  })()`));
  assert.deepEqual(result, { status:'unanswered', points:0, kind:'unanswered', answer:'(4)', score:95 });
});

test('整卷視覺提示明定圈題號不是答案、逐項複選與第一次禁止詳解', async () => {
  const { run } = loadApp();
  const prompt = await run(`(async () => {
    let request = null;
    openAiInvoke = async (payload) => { request = payload; return { model:'gpt-5.5', json:{} }; };
    await paperAiGradeCall(PAPER_SOURCES[0], []);
    return request.messages[0].content[0].text;
  })()`);
  assert.match(prompt, /圈住「印刷的題號」[\s\S]*絕對不是選了同號選項/);
  assert.match(prompt, /kind=strike/);
  assert.match(prompt, /kind=add/);
  assert.match(prompt, /系統會在紅叉或部分得分旁強制寫出完整正解/);
  assert.match(prompt, /禁止輸出詳解、提示、破題方向、錯誤類型/);
});

test('真人式紅筆會在錯答旁畫叉並直接寫正解，不再用整框標籤', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const calls = { line:0, rect:0, text:[] };
    const ctx = {
      setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){ calls.line++; },
      closePath(){}, strokeRect(){ calls.rect++; }, fillRect(){}, save(){}, restore(){},
      measureText(text){ return { width:String(text).length * 11 }; },
      strokeText(){}, fillText(text, x, y){ calls.text.push({ text:String(text), x, y }); },
    };
    const cv = { clientWidth:1000, clientHeight:1400, width:0, height:0, getContext(){ return ctx; } };
    paperAiPaintCanvas(cv, [{
      no:4, status:'incorrect', points:0, answer:'(4)',
      marks:[{ kind:'cross', option:0, box:[.2,.3,.25,.33], label:'✕ 0' }],
    }], true);
    return calls;
  })()`));
  assert.equal(result.rect, 0);
  assert.equal(result.line > 0, true);
  assert.equal(result.text.some((row) => /第 4 題.*✕ 0/.test(row.text)), true);
  assert.equal(result.text.some((row) => /正解 \(4\)/.test(row.text)), true);
  assert.equal(result.text.every((row) => row.x >= 765), true, '批改文字必須留在右側筆記欄，不得壓住題目');
  assert.equal(result.text.some((row) => /詳解|提示|錯誤步驟/.test(row.text)), false);
});

test('舊版部分得分的大三角不再畫在題幹，分數與正解改排到右側留白', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const calls = { line:0, text:[] };
    const ctx = {
      setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){ calls.line++; }, stroke(){},
      closePath(){}, strokeRect(){}, fillRect(){}, save(){}, restore(){},
      measureText(text){ return { width:String(text).length * 10 }; },
      strokeText(){}, fillText(text, x, y){ calls.text.push({ text:String(text), x, y }); },
    };
    const cv = { clientWidth:1000, clientHeight:1400, width:0, height:0, getContext(){ return ctx; } };
    paperAiPaintCanvas(cv, [{
      no:11, status:'incorrect', points:1, answer:'(4)(5)',
      marks:[{ kind:'partial', option:0, box:[.12,.55,.22,.59], label:'△ +1' }],
    }], true);
    return calls;
  })()`));
  assert.equal(result.line, 0, '舊版 partial 標記不得再以大三角蓋住題幹');
  assert.deepEqual(result.text.map((row) => row.text), ['第 11 題　△ +1', '正解 (4)(5)']);
  assert.equal(result.text.every((row) => row.x >= 765), true);
});

test('批改卷與隔日訂正都能一鍵隱藏或顯示紅筆，不必忍受標記遮住閱讀', () => {
  const { context, run } = loadApp();
  context.__redButton = { textContent:'', attrs:{}, setAttribute(name, value){ this.attrs[name] = value; } };
  context.document.querySelector = (selector) => selector === '#paper-ai-toggle' ? context.__redButton : null;
  const result = plain(run(`(() => {
    paperSourceSession = { aiMarksHidden:false };
    let paints = 0; paperAiPaint = () => { paints++; };
    const before = paperAiToggleButtonHTML();
    paperAiMarksToggle();
    const hidden = { value:paperSourceSession.aiMarksHidden, text:__redButton.textContent, pressed:__redButton.attrs['aria-pressed'] };
    paperAiMarksToggle();
    return { before, hidden, shown:paperSourceSession.aiMarksHidden, text:__redButton.textContent, paints };
  })()`));
  assert.match(result.before, /id='paper-ai-toggle'/);
  assert.match(result.before, /隱藏紅筆/);
  assert.deepEqual(result.hidden, { value:true, text:'顯示紅筆', pressed:'true' });
  assert.equal(result.shown, false);
  assert.equal(result.text, '隱藏紅筆');
  assert.equal(result.paints, 2);
});

test('原版隔日每題先保存一次真實重想才可查看詳解，內容會快取且仍須重算再批改', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {}; paperInkCommitCurrent = () => false;
    paperInkJournalDrain = async () => true; paperInkPersist = async () => true;
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'detail-flow', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    paperReview = { source, run:row, urls:[], inkPages:{}, nos:[no], i:0, detailLoading:false, detailError:'' };
    let calls = 0, officialCalls = 0;
    paperReviewPageComposite = async () => 'composite';
    paperReviewQuestionFocusImage = async () => 'focus';
    paperAiDetailCall = async (givenSource, givenNo, image, logs) => {
      calls++;
      return { model:'gpt-5.5', json:{
        readable:true, confidence:'high', read:'先寫「令 x 為常數」，再繼續代入',
        goodWork:['先正確整理已知條件'], firstErrorEvidence:'令 x 為常數', firstError:'把變數 x 當成常數',
        errorKind:'條件誤讀', whyWrong:'x 會隨條件改變。', repair:'保留 x 為變數再代入。', explanation:'變數角色判斷錯誤。',
        solution:['先整理條件', '代回並化簡'], answer:'模型亂填答案',
        nextTime:'先標出變數與常數', marks:[{box:[.1,.2,.3,.4],label:'模型洩漏文字'}],
      } };
    };
    paperOfficialSolutionCall = async () => { officialCalls++; return ['https://rrihysbxhsbxjteqmtdu.supabase.co/storage/v1/object/sign/matha-solutions/paper-mock-1/q02.png?token=test']; };
    await paperReviewDetailed();
    const lockedCalls = calls, lockedOfficialCalls = officialCalls, lockedError = paperReview.detailError;
    state.attempts = 1; state.logs.push({ ts:Date.now(), kind:'retry', direction:'先把條件改寫成內積再建式' });
    paperReview.detailError = '';
    await paperReviewDetailed();
    const firstCalls = calls;
    await paperReviewDetailed();
    const cachedCalls = calls;
    paperReview.officialSolutionLoadedAt[no] -= 13 * 60 * 1000;
    await paperReviewDetailed();
    const refreshedOfficialCalls = officialCalls;
    const detail = state.aiDetail;
    let verifyLevel = 0; paperReviewGrade = (level) => { verifyLevel = level; };
    paperReviewFinishDetailed();
    return {
      lockedCalls, lockedOfficialCalls, lockedError, firstCalls, cachedCalls, done:state.done, verifyLevel,
      firstError:detail.firstError, solution:detail.solution,
      answer:detail.answer, official:paperFinalAnswerText(source.key[no - 1]),
      mark:detail.marks[0].label, unlocked:!!state.solutionUnlockedAt,
      detailViewCount:state.detailViewCount, firstOpened:!!state.detailFirstOpenedAt, officialCalls, refreshedOfficialCalls,
    };
  })()`));
  assert.equal(result.lockedCalls, 0, '沒有重想紀錄時不得呼叫詳解 API');
  assert.equal(result.lockedOfficialCalls, 0, '沒有重想紀錄時也不得請求官方詳解像素');
  assert.match(result.lockedError, /先在卷面留下新的重算|真實重想/);
  assert.equal(result.firstCalls, 1, '保存一次真實重想後才產生本題詳解');
  assert.equal(result.cachedCalls, 1, '再次打開沿用已保存詳解，不重複花 API');
  assert.equal(result.officialCalls, 2, '短效網址到期前沿用，接近到期後安全刷新');
  assert.equal(result.refreshedOfficialCalls, 2, '15 分鐘簽名網址不會在平板長時間訂正時永久卡死');
  assert.equal(result.done, false, '看完詳解不能直接算完成，仍要把重算寫回原卷');
  assert.equal(result.verifyLevel, 3, '第三級也必須再經一次卷面 AI 驗證');
  assert.equal(result.firstError, '把變數 x 當成常數');
  assert.deepEqual(result.solution, ['先整理條件', '代回並化簡']);
  assert.equal(result.answer, result.official, '正式答案必須以本地答案鍵覆蓋模型文字');
  assert.equal(result.mark, '第一個錯誤');
  assert.equal(result.unlocked, true);
  assert.equal(result.detailViewCount, 3);
  assert.equal(result.firstOpened, true);
});

test('後端拒絕詳解時不再製造假的 detail-gate 繞過老師流程', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {}; paperInkCommitCurrent = () => false;
    paperInkJournalDrain = async () => true; paperInkPersist = async () => true;
    let syncCalls = 0; syncPush = async () => { syncCalls++; };
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:1, logs:[{ ts:Date.now(), kind:'retry', direction:'先把條件拆成兩段再建式' }] };
    const row = { id:'legacy-detail-gate', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    paperReview = { source, run:row, urls:[], inkPages:{}, nos:[no], i:0, detailLoading:false, detailError:'' };
    paperReviewPageComposite = async () => 'composite';
    paperReviewQuestionFocusImage = async () => 'focus';
    const receivedLogs = []; let calls = 0;
    paperAiDetailCall = async (givenSource, givenNo, image, logs) => {
      calls++; receivedLogs.push(logs.length);
      throw new Error('本題詳解尚未開放：必須先保存一次重想。');
    };
    await paperReviewDetailed();
    return {
      calls, syncCalls, receivedLogs, attempts:state.attempts,
      gateLogs:state.logs.filter((log) => log.kind === 'detail-gate').length,
      retryCount:paperReviewRetryLogCount(state.logs, state, state),
      hasDetail:!!state.aiDetail, error:paperReview.detailError,
    };
  })()`));
  assert.equal(result.calls, 1, '後端拒絕後不得塞假紀錄再試');
  assert.equal(result.syncCalls, 1);
  assert.deepEqual(result.receivedLogs, [1], '只送出真正的重想紀錄');
  assert.equal(result.attempts, 1);
  assert.equal(result.gateLogs, 0);
  assert.equal(result.retryCount, 1);
  assert.equal(result.hasDetail, false);
  assert.match(result.error, /尚未開放/);
});

test('原版隔日訂正使用全頁可寫工作台，每題保留詳解入口但先鎖到真實重想後', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    save = () => {}; sessionChrome = () => {}; paperInkAttach = () => {}; paperInkStatusRender = () => {}; startTicker = () => {}; paperInkCommitCurrent = () => false; rtAi = (value) => escH(String(value || ''));
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'detail-ui', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    const urls = source.scans.map((_, i) => 'blob:' + i), inkRun = paperReviewInkRun(row);
    paperReview = { source, run:row, urls, baseInkPages:{}, inkPages:{}, inkRun, nos:[no], i:0, renderedNo:null, detailLoading:false, detailError:'', detailOpen:true };
    paperSourceSession = { source, run:row, inkRun, urls, baseInkPages:{}, inkPages:{}, page:0, zoom:1, inkMode:'pen', inkWidth:1, inkColor:'blue', reviewMode:true, durability:{pendingClientIds:new Set()} };
    renderPaperAnswerReview(); const locked = __app.innerHTML;
    state.aiDetail = { confidence:'high', goodWork:['第一行正確代入'], firstErrorEvidence:'2x+3=7', firstError:'第二行符號寫反', errorKind:'符號', whyWrong:'移項後正號應變負號', repair:'改寫為 2x=7−3', read:'', explanation:'移項時變號錯誤', solution:['正確移項'], answer:'(2)', nextTime:'先圈負號', marks:[] };
    paperReview.officialSolutions = { [no]:['https://rrihysbxhsbxjteqmtdu.supabase.co/storage/v1/object/sign/matha-solutions/paper-mock-1/q02.png?token=test'] };
    renderPaperAnswerReview(); const detailed = __app.innerHTML;
    return { locked, detailed };
  })()`));
  assert.match(result.locked, /paper-session-shell paper-review-session/);
  assert.match(result.locked, /id='paper-base-ink-canvas'/);
  assert.match(result.locked, /id='paper-ink-canvas'/);
  assert.match(result.locked, /id='paper-ai-toggle'/);
  assert.match(result.locked, /隱藏紅筆/);
  assert.match(result.locked, /id='paper-detail-shortcut'/);
  assert.match(result.locked, /先留下一次重想/);
  assert.match(result.locked, /paper-detail-shortcut[^>]*disabled/);
  assert.match(result.locked, /id='paper-review-direction'/);
  assert.match(result.locked, /id='paper-review-topic'/);
  assert.match(result.locked, /寫完了，AI 再批改/);
  assert.doesNotMatch(result.locked, /paper-review-layout/);
  assert.match(result.detailed, /做到哪裡、從哪裡開始錯/);
  assert.match(result.detailed, /第一行正確代入/);
  assert.match(result.detailed, /2x\+3=7/);
  assert.match(result.detailed, /第二行符號寫反/);
  assert.match(result.detailed, /先只修這一步/);
  assert.match(result.detailed, /AI 看錯我的手寫/);
  assert.match(result.detailed, /重新分析這一題/);
  assert.match(result.detailed, /看完並回卷面重算/);
  assert.match(result.detailed, /官方詳解原圖/);
  assert.match(result.detailed, /不經 OCR 重打/);
  assert.match(result.detailed, /AI 拆解與補充/);
  assert.doesNotMatch(result.detailed, /paper-review-direction/);
});

test('逐題詳批同時送整頁與本題焦點，並強制列出正確前綴與可驗證第一錯步', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    const source = PAPER_SOURCES[0], no = 3;
    paperReview = { run:{ id:'quality', aiGrade:{ questions:[{ no, topic:'comb', answer:'(2)', answerType:'single', maxPoints:5 }] }, review:{ [no]:{ topic:'comb' } } } };
    let request = null;
    openAiInvoke = async (payload) => { request = payload; return { json:{}, model:'gpt-5.5' }; };
    await paperAiDetailCall(source, no, 'full-page', [{ direction:'先分組' }], 'focus-crop', '分母其實寫 3!');
    const parts = request.messages[0].content;
    return {
      images:parts.filter((part) => part.type === 'image').map((part) => part.source.data),
      text:parts.filter((part) => part.type === 'text').map((part) => part.text).join('\\n'),
    };
  })()`));
  assert.deepEqual(result.images, ['full-page', 'focus-crop']);
  assert.match(result.text, /最長的正確前綴/);
  assert.match(result.text, /firstErrorEvidence/);
  assert.match(result.text, /不可編造/);
  assert.match(result.text, /分母其實寫 3!/);
});

test('低信心詳批可顯示不確定說明，但不得寫入錯因或在卷面猜位置', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    return paperNormalizeAiDetail(source, 2, {
      readable:true, confidence:'low', read:'可能寫了 2x+3', goodWork:['可能有代入'],
      firstErrorEvidence:'可能是 2x+3', firstError:'可能移項錯誤', errorKind:'符號',
      whyWrong:'影像不清楚', repair:'重新抄清楚', explanation:'無法確認', solution:['正確解法'],
      answer:'任意', nextTime:'寫大一點', marks:[{ box:[.1,.2,.3,.4], label:'第一個錯誤' }],
    }, 'gpt-5.5');
  })()`));
  assert.equal(result.confidence, 'low');
  assert.equal(result.errorKind, null);
  assert.deepEqual(result.marks, []);
  assert.equal(result.firstError, null);
  assert.equal(result.firstErrorEvidence, null);
});

test('模型自稱高信心但沒有卷面逐字證據時，一律降級且不得建立第一錯步標籤', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => paperNormalizeAiDetail(PAPER_SOURCES[0], 2, {
    readable:true, confidence:'high', read:'看得到若干算式', goodWork:['第一行代入可能正確'],
    firstErrorEvidence:null, firstError:'模型推測第二行符號錯誤', errorKind:'符號', whyWrong:'推測說明',
    repair:'改符號', explanation:'完整解法仍可提供', solution:['重新計算'], nextTime:'檢查正負號',
    marks:[{ box:[.1,.2,.3,.4], label:'第一個錯誤' }],
  }, 'gpt-5.5'))()`));
  assert.equal(result.confidence, 'low');
  assert.equal(result.firstErrorEvidence, null);
  assert.equal(result.firstError, null);
  assert.equal(result.errorKind, null);
  assert.deepEqual(result.marks, []);
});

test('隔日訂正入口明確說明在紅筆卷上作答，不再沿用唯讀盲訂正文案', () => {
  const { run } = loadApp();
  const source = run('String(renderCorrections)');
  assert.match(source, /在紅筆卷上開始訂正/);
  assert.match(source, /每題都保留詳解入口，但先完成一次真實重想/);
  assert.match(source, /留下單元與卡點後，才可一按打開本題詳解/);
  assert.doesNotMatch(source, /開始原卷盲訂正/);
});

test('空白訂正不能灌水解鎖詳解，單元與具體卡點可保存成一次真實重想', async () => {
  const { context, run } = loadApp();
  context.__reviewDirection = { value:'' };
  context.__reviewTopic = { value:'' };
  context.__reviewConcept = { value:'' };
  context.document.querySelector = (selector) => ({
    '#paper-review-direction':context.__reviewDirection,
    '#paper-review-topic':context.__reviewTopic,
    '#paper-review-concept':context.__reviewConcept,
  })[selector] || null;
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {}; paperSourceUpdateExtMock = () => {};
    paperInkCommitCurrent = () => false; paperInkJournalDrain = async () => true; paperInkPersist = async () => true;
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'effort-gate', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    const inkRun = paperReviewInkRun(row);
    paperReview = { source, run:row, urls:[], baseInkPages:{}, inkPages:{0:{s:[],deleted:new Set(),dirty:false}}, inkRun, nos:[no], i:0, grading:false, gradeError:'', effortBaseline:new Set() };
    paperSourceSession = { source, run:row, inkRun, inkPages:paperReview.inkPages, page:0, reviewMode:true };
    await paperReviewStuckWorkspace();
    const blank = { attempts:state.attempts, logs:state.logs.length, error:paperReview.gradeError };
    __reviewTopic.value = 'prob'; __reviewConcept.value = '不知道如何判斷事件是否獨立';
    await paperReviewStuckWorkspace();
    return { blank, saved:{ attempts:state.attempts, log:state.logs[0], error:paperReview.gradeError } };
  })()`));
  assert.deepEqual(result.blank.attempts, 0);
  assert.deepEqual(result.blank.logs, 0);
  assert.match(result.blank.error, /真實重想/);
  assert.equal(result.saved.attempts, 1);
  assert.equal(result.saved.log.kind, 'retry');
  assert.equal(result.saved.log.topic, 'prob');
  assert.match(result.saved.log.concept, /事件是否獨立/);
  assert.equal(result.saved.error, '');
});

test('隔日訂正筆跡使用獨立 namespace，不會覆蓋考試原稿', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const exam = { id:'run-original', createdAt:100, sourceId:'paper-mock-1' };
    const correction = paperReviewInkRun(exam);
    return { exam:paperInkQid(exam, 2), correction:paperInkQid(correction, 2), correctionId:correction.id };
  })()`));
  assert.equal(result.exam, 'paper:run-original:v2:2');
  assert.equal(result.correction, 'paper:run-original-correction:v2:2');
  assert.equal(result.correctionId, 'run-original-correction');
  assert.notEqual(result.exam, result.correction);
});

test('隔日卷面重算通過 AI 再批改後，才列為第二級並進下一題', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {}; paperSourceUpdateExtMock = () => {};
    paperInkCommitCurrent = () => false; paperInkJournalDrain = async () => true; paperInkPersist = async () => true;
    paperReviewPageComposite = async () => 'review-page';
    paperAiCorrectionCall = async () => ({ read:'紫色訂正得到正確答案', correct:true, firstError:null, errKind:null, praise:'', nextTime:'', marks:[{box:[.7,.4,.8,.45],label:'ok'}], stuck:[] });
    const source = PAPER_SOURCES[0], no = 2, nextNo = 3;
    const state = { done:false, attempts:0, logs:[] };
    const row = { id:'verify-flow', sourceId:source.id, due:today(), mt:1, review:{ [no]:state, [nextNo]:{done:false,attempts:0,logs:[]} } };
    const inkRun = paperReviewInkRun(row);
    paperReview = { source, run:row, urls:[], baseInkPages:{}, inkPages:{}, inkRun, nos:[no,nextNo], i:0, grading:false, gradeError:'' };
    paperSourceSession = { source, run:row, inkRun, inkPages:{0:{s:[{id:'new-work',t0:2,pts:[[.1,.1,.5],[.2,.2,.5]]}],deleted:new Set(),dirty:false}}, page:0, reviewMode:true };
    await paperReviewGrade(2);
    const before = { done:state.done, pending:state.pendingLevel, correct:state.correctionGrade.correct, i:paperReview.i };
    paperReviewAcceptCorrection();
    return { before, after:{ done:state.done, level:state.level, outcome:state.outcome, i:paperReview.i } };
  })()`));
  assert.deepEqual(result.before, { done:false, pending:2, correct:true, i:0 });
  assert.deepEqual(result.after, { done:true, level:2, outcome:'answer-only-verified', i:1 });
});

test('訂正再批改失敗只顯示對錯，不提前洩漏模型的步驟診斷', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0], no = 2;
    const grade = paperNormalizeCorrectionGrade(source, no, { read:'紫色寫到一半', correct:false, firstError:'秘密：第二行先錯', errKind:'移項', marks:[], stuck:[] });
    paperReview = { grading:false, gradeError:'' };
    return { hidden:grade.hiddenFirstError, html:paperReviewStatusHTML({ correctionGrade:grade }) };
  })()`));
  assert.match(result.hidden, /第二行先錯/);
  assert.match(result.html, /還沒完整成立/);
  assert.doesNotMatch(result.html, /第二行先錯|移項/);
});

test('隔日訂正保存失敗時不呼叫逐題詳解，也不離開可寫卷面', async () => {
  const { run } = loadApp();
  const result = plain(await run(`(async () => {
    save = () => {}; renderPaperAnswerReview = () => {}; paperInkCommitCurrent = () => false;
    paperInkJournalDrain = async () => false; paperInkPersist = async () => false;
    const source = PAPER_SOURCES[0], no = 2;
    const state = { done:false, attempts:1, logs:[{ ts:Date.now(), kind:'retry', direction:'先整理條件再建式' }] };
    const row = { id:'save-failure', sourceId:source.id, due:today(), mt:1, review:{ [no]:state } };
    const inkRun = paperReviewInkRun(row);
    paperReview = { source, run:row, urls:[], baseInkPages:{}, inkPages:{0:{s:[],deleted:new Set(),dirty:true}}, inkRun, nos:[no], i:0, grading:false, gradeError:'' };
    paperSourceSession = { source, run:row, inkRun, inkPages:paperReview.inkPages, page:0, reviewMode:true };
    paperReviewCurrentEffort = () => ({ meaningful:true, strokes:1, direction:'先整理條件再建式', topic:'', concept:'' });
    let detailCalls = 0; paperAiDetailCall = async () => { detailCalls++; return {}; };
    await paperReviewDetailed();
    const detail = { calls:detailCalls, saved:!!state.aiDetail, error:paperReview.detailError };
    await paperReviewStuckWorkspace();
    const stuck = { attempts:state.attempts, error:paperReview.gradeError, stillOpen:!!paperSourceSession };
    const left = await paperReviewBack();
    return { detail, stuck, left, stillOpen:!!paperReview && !!paperSourceSession };
  })()`));
  assert.equal(result.detail.calls, 0);
  assert.equal(result.detail.saved, false);
  assert.match(result.detail.error, /尚未安全保存/);
  assert.equal(result.stuck.attempts, 1, '保存失敗不得新增重想次數');
  assert.match(result.stuck.error, /尚未安全保存/);
  assert.equal(result.stuck.stillOpen, true);
  assert.equal(result.left, false);
  assert.equal(result.stillOpen, true);
});

test('原版模考暫停會凍結剩餘時間並可跨頁面續寫', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const row = { id:'pause-1', status:'active', remainingMs:100000, resumeAt:Date.now() - 2000, mt:1 };
    paperSourceSession = { source:PAPER_SOURCES[0], run:row, urls:[] };
    paperSourcePause();
    const frozen = paperRunLeft(row);
    return { status:row.status, resumeAt:row.resumeAt, remaining:row.remainingMs, frozen };
  })()`));
  assert.equal(result.status, 'paused');
  assert.equal(result.resumeAt, null);
  assert.equal(result.remaining >= 97000 && result.remaining <= 99000, true);
  assert.equal(Math.abs(result.frozen - result.remaining) < 20, true);
});

test('捨棄原版模考會留下同步墓碑並清掉關聯成績', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {};
    const row = { id:'discard-1', sourceId:'paper-mock-1', status:'paused', remainingMs:100000, resumeAt:null, mt:1, createdAt:1 };
    S.paperRuns = [row];
    S.extMocks = [{ id:'external-discard-1', paperRunId:'discard-1', score:0 }];
    paperSourceDiscard('discard-1');
    return { row, active:paperActiveRun('paper-mock-1'), latest:paperLatestRun('paper-mock-1'), ext:S.extMocks };
  })()`));
  assert.equal(result.row.status, 'discarded');
  assert.equal(result.row.resumeAt, null);
  assert.equal(result.row.discardedAt > 1, true);
  assert.equal(result.row.mt, result.row.discardedAt);
  assert.equal(result.active, null);
  assert.equal(result.latest, null);
  assert.deepEqual(result.ext, []);
});

test('眼睛刷題沒有方向時隔天才到期，基本定義卡依語意結果排程', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.visionQueue = [{ id:'v1', qid:BANK[0].id, stage:'waiting', due:addDays(today(),1), done:false }];
    S.conceptAttempts = [{ id:'c1', conceptId:CONCEPT_CARDS[0].id, ts:1, due:addDays(today(),7), understood:true }];
    return { visionToday:visionDueEntries().length, conceptDue:conceptDueCards().length, total:CONCEPT_CARDS.length };
  })()`));
  assert.equal(result.visionToday, 0);
  assert.equal(result.conceptDue, result.total - 1);
});

test('完整模考二十題全部進三級報告，考場答對題直接列第一級', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.corrections = [];
    const detail = buildPaper().map((q, i) => ({ q, ok:i < 12, yourAns:i < 12 ? '正確作答' : '錯誤作答', answered:true }));
    const batch = queueMockCorrection(detail, 999);
    return { total:batch.entries.length, counts:correctionCounts(batch) };
  })()`));
  assert.equal(result.total, 20);
  assert.deepEqual(result.counts, { open: 8, l1: 12, l2: 0, l3: 0, retentionDue:0, retentionPending:0, retentionPassed:0 });
});

test('第二三級完成後經 2 日與再 7 日兩次獨立答對才算保留', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {}; S.attempts = []; S.wrong = {};
    const q = BANK.find((row) => row.type === 'fill');
    const entry = { qid:q.id, done:true, level:3, completedAt:1, retentionStage:0, retentionDue:today(), retentionPassed:false };
    const batch = { id:'retention', entries:[entry], mt:1 };
    S.corrections = [batch];
    recordAttempt(q, true, 50000, null, 'adaptive-textbook');
    const afterTwoDays = { stage:entry.retentionStage, due:entry.retentionDue, passed:!!entry.retentionPassed };
    entry.retentionDue = today();
    recordAttempt(q, true, 45000, null, 'adaptive-textbook');
    return { afterTwoDays, final:{ stage:entry.retentionStage, due:entry.retentionDue, passed:entry.retentionPassed, logs:entry.retentionLogs.length } };
  })()`));
  assert.equal(result.afterTwoDays.stage, 1);
  assert.equal(result.afterTwoDays.passed, false);
  assert.match(result.afterTwoDays.due, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(result.final, { stage:2, due:null, passed:true, logs:2 });
});

test('模考交卷當天只顯示分數與錯題號，不洩漏答案、章節或詳解', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  run(`sessionChrome = () => {}; save = () => {}; recordAttempt = () => {};
    S.attempts = []; S.mocks = []; S.corrections = [];
    const q = { ...BANK.find((x) => x.id === 'line5'), examNo: 13, examSection: 'fill', points: 100 };
    mock = { graded:[q], answers:{ [q.id]:{ type:'fill', v:'0' } }, times:{}, proc:{}, aiv:{}, partial:false };
    mockFinal();`);
  const html = context.__app.innerHTML;
  assert.match(html, /得分 <b>0 \/ 100/);
  assert.match(html, /今天到此為止，不訂正/);
  assert.doesNotMatch(html, /25\/3/);
  assert.doesNotMatch(html, /直線與圓/);
  assert.doesNotMatch(html, /詳解：|正確答案/);
});

test('隔日訂正至少記下一次重想，才允許解鎖詳解', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    save = () => {}; renderCorrectionWork = () => {};
    const entry = { qid:BANK[0].id, examNo:1, done:false, attempts:0, logs:[] };
    const batch = { id:'c1', d:addDays(today(), -1), due:today(), mt:1, entries:[entry] };
    S.corrections = [batch]; correction = { batch, indexes:[0], i:0, t0:Date.now() };
    correctionUnlock();
    const locked = entry.solutionUnlockedAt == null;
    entry.attempts = 1; correctionUnlock();
    return { locked, unlocked:!!entry.solutionUnlockedAt };
  })()`));
  assert.deepEqual(result, { locked: true, unlocked: true });
});

test('答對但猜中會留下 confidence 並排入隔日重測，不灌成熟練', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = []; S.wrong = {}; S.mocks = []; S.daily = {};
    const q = BANK.find((x) => x.id === 'num1');
    const rec = recordAttempt(q, true, 50000, '用猜的', 'practice');
    return { rec, wrong: S.wrong[q.id] };
  })()`));
  assert.equal(result.rec.ok, true);
  assert.equal(result.rec.confidence, 'guess');
  assert.equal(result.rec.err, '用猜的');
  assert.equal(result.wrong.fails, 0);
  assert.equal(result.wrong.err, '用猜的');
  assert.match(result.wrong.due, /^\d{4}-\d{2}-\d{2}$/);
});

test('改判保存類題遷移欄位', () => {
  const { run } = loadApp();
  const sourceShape = run(`(() => {
    const src = String(qResolve);
    return ['independent-transfer', 'originErr', 'topic: q.topic', 'diff: q.diff'].every((x) => src.includes(x));
  })()`);
  assert.equal(sourceShape, true);
});

test('實體模考優先作為級分證據，失分單元會進入修分建議', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = []; S.mocks = [{ d: today(), ok: 12, n: 12, acc: 1 }]; S.wrong = {};
    S.extMocks = [
      { d: addDays(today(), -1), name: '<img src=x onerror=alert(1)>', score: 68, total: 100, topics: ['prob'], err: '看錯題意', minutesLeft: 0, note: '<script>x</script>', ts: 1 },
      { d: today(), name: '第二次模考', score: 74, total: 100, topics: ['prob', 'comb'], err: '計算失誤', minutesLeft: 3, ts: 2 },
    ];
    const cal = mockCalibration();
    return { source: cal.source, acc: cal.acc };
  })()`));
  assert.equal(result.source, 'external');
  assert.equal(result.acc, 0.71);
});

test('原始 19 題卷保留練習價值，但不污染 20 題正式級分校準', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const practice = PAPER_SOURCES.find((source) => source.questions === 19);
    S.paperRuns = [{ id:'legacy-run', sourceId:practice.id }];
    S.extMocks = [
      { id:'formal', d:'2026-07-17', score:70, total:100, questions:20, calibrationEligible:true, ts:1 },
      { id:'practice', d:'2026-07-18', score:100, total:100, questions:19, calibrationEligible:false, ts:2 },
      { id:'legacy-practice', paperRunId:'legacy-run', sourceId:practice.id, d:'2026-07-16', score:100, total:100, ts:0 },
    ];
    const calibration = mockCalibration();
    return {
      practiceEligible:practice.calibrationEligible,
      reason:practice.practiceReason,
      count:calibration.count,
      acc:calibration.acc,
      card:paperSourceCardHTML(practice),
    };
  })()`));
  assert.equal(result.practiceEligible, false);
  assert.match(result.reason, /19 題/);
  assert.equal(result.count, 1);
  assert.equal(result.acc, 0.7);
  assert.match(result.card, /練習卷，不列入級分校準/);
});

test('原版模考隔日訂正會累積單元、卡點與老師逐題報告', () => {
  const { context, run } = loadApp();
  context.__app = { innerHTML: '' };
  context.document.querySelector = (selector) => selector === '#app' ? context.__app : null;
  const result = plain(run(`(() => {
    typesetIn = () => {}; scrollQuestionTop = () => {}; rtAi = (value) => escH(String(value || ''));
    const source = PAPER_SOURCES[0];
    const questions = source.key.map((key, index) => ({
      no:index + 1, status:index === 0 ? 'incorrect' : 'correct',
      points:index === 0 ? 0 : key.points, read:index === 0 ? '(2)' : '正確', marks:[],
    }));
    const row = {
      id:'teacher-paper', sourceId:source.id, name:source.title, d:'2026-07-18',
      status:'completed', score:95, aiGrade:{ score:95, questions },
      review:{ 1:{ done:true, level:3, topic:'prob', errorKind:'條件翻譯不完整',
        aiErrorKind:'推理缺口', logs:[{ direction:'先縮小樣本空間', topic:'prob', concept:'條件機率', errorKind:'條件翻譯不完整' }],
        aiDetail:{ errorKind:'推理缺口', firstError:'分母仍使用原樣本空間', nextTime:'先重畫樣本空間' } } },
    };
    S.paperRuns = [row];
    const tags = paperRunRefreshLearningTags(row);
    renderPaperTeacherReport(row.id);
    return { tags, html:__app.innerHTML, card:paperLearningSummaryCard(), levels:paperRunLevelCounts(row), recovery:paperRunRecoveryPoints(row) };
  })()`));
  assert.deepEqual(result.tags.topics, ['prob']);
  assert.deepEqual(result.tags.errors.sort(), ['推理缺口', '條件翻譯不完整'].sort());
  assert.deepEqual(result.levels, { l1:19, l2:0, l3:1, open:0 });
  assert.deepEqual(result.recovery, { lost:5, reconstructed:5, answerOnly:0, solution:5, retained:0, open:0 });
  assert.match(result.html, /老師檢視版/);
  assert.match(result.html, /失分回收/);
  assert.match(result.html, /5／5 分/);
  assert.match(result.html, /先縮小樣本空間/);
  assert.match(result.html, /分母仍使用原樣本空間/);
  assert.match(result.card, /較常失分的單元/);
  assert.match(result.card, /看詳解後已重建<\/span><b>5 分/);
  assert.match(result.card, /不冒充下次考試已能拿回/);
  assert.match(result.card, /條件翻譯不完整|推理缺口/);
});

test('老師單頁顯示三回趨勢、明確無方向題，且兩道後續新題才算修正已驗證', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const prob = BANK.filter((q) => q.topic === 'prob').slice(0, 3);
    const grade = { score:70, questions:[
      { no:1, status:'unanswered', points:0, maxPoints:5, topic:'prob' },
      { no:2, status:'incorrect', points:0, maxPoints:5, topic:'prob' },
    ] };
    const state = { done:false, topic:'prob', logs:[] };
    paperTeacherOverrideAppend(state, {
      at:250, reviewer:'王老師', source:'老師面談', reason:'先練條件機率的樣本空間', topic:'prob', processStage:'direction',
    }, { topic:'prob', errorKind:'找不到破題方向' });
    const current = { id:'current-paper', sourceId:source.id, d:'2026-08-20', submittedAt:200, status:'completed', score:70,
      aiGrade:grade, review:{ 1:state, 2:{ done:false, topic:'prob', logs:[{ ts:210, topic:'prob', concept:'條件機率', direction:'' }] } } };
    S.paperRuns = [
      { id:'prior-paper', sourceId:source.id, d:'2026-08-13', submittedAt:100, status:'completed', score:60, aiGrade:{ score:60, questions:[] }, review:{} },
      current,
    ];
    S.attempts = [
      { qid:prob[0].id, ok:true, d:today(), mode:'adaptive-textbook', ts:300 },
      { qid:prob[1].id, ok:true, d:today(), mode:'adaptive-textbook', ts:400 },
    ];
    const cross = paperTeacherCrossRunSummary(current, source, grade);
    const html = paperTeacherSummaryHTML(current, source, grade, { l1:0, l2:0, l3:0, open:2 });
    S.attempts.push({ qid:prob[2].id, ok:false, err:'找不到破題方向', d:today(), mode:'adaptive-textbook', ts:500 });
    const afterFailure = paperTeacherCrossRunSummary(current, source, grade);
    return { cross, html, afterFailure };
  })()`));
  assert.deepEqual(result.cross.scoreTrend, ['2026-08-13 60分', '2026-08-20 70分']);
  assert.deepEqual(result.cross.noDirectionNos, [1, 2]);
  assert.equal(result.cross.verified, 1);
  assert.equal(result.cross.waiting, 0);
  assert.match(result.html, /最近正式卷趨勢/);
  assert.match(result.html, /2026-08-13 60分 → 2026-08-20 70分/);
  assert.match(result.html, /明確仍無方向.*第 1、2 題/);
  assert.match(result.html, /下週只優先討論.*第 1、2 題/);
  assert.equal(result.afterFailure.verified, 0);
  assert.equal(result.afterFailure.stillBlocked, 1);
});

test('失分回收只計官方配分：第二級、第三級與未完成分開，不把訂正冒充穩定得分', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = PAPER_SOURCES[0];
    const questions = source.key.map((key, index) => ({
      no:index + 1,
      status:index < 3 ? 'incorrect' : 'correct',
      points:index === 1 ? 1 : index < 3 ? 0 : key.points,
      maxPoints:key.points,
      marks:[],
    }));
    const row = {
      id:'recovery-paper', sourceId:source.id, score:86,
      aiGrade:{ score:86, questions },
      review:{ 1:{ done:true, level:2 }, 2:{ done:true, level:3 }, 3:{ done:false } },
    };
    return paperRunRecoveryPoints(row);
  })()`));
  assert.deepEqual(result, { lost:14, reconstructed:9, answerOnly:5, solution:4, retained:0, open:5 });
});

test('推薦題換題與品質回報不會污染作答證據，疑問題會停止出題且可恢復', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S = freshState();
    const q = BANK[0];
    questionFeedbackRecord(q, 'obvious');
    const obvious = questionIsTemporarilyObvious(q, learningSignalIndex());
    questionFeedbackRecord(q, 'issue');
    const blocked = questionFeedbackBlocked(q);
    const evidenceAfterReports = learningEvidenceLedger().length;
    questionFeedbackRecord(q, 'restore');
    return { obvious, blocked, restored:!questionFeedbackBlocked(q), attempts:S.attempts.length, evidenceAfterReports, rows:S.questionFeedback.length };
  })()`));
  assert.deepEqual(result, { obvious:true, blocked:true, restored:true, attempts:0, evidenceAfterReports:0, rows:3 });
});

test('題目品質回報跨裝置聯集合併，不會被另一台的舊狀態吃掉', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const a = freshState(), b = freshState();
    a.questionFeedback = [{ id:'feedback-a', qid:BANK[0].id, kind:'issue', ts:1 }];
    b.questionFeedback = [{ id:'feedback-b', qid:BANK[1].id, kind:'wrongTopic', ts:2 }];
    return mergeState(a, b).questionFeedback.map((row) => row.id);
  })()`));
  assert.deepEqual(result, ['feedback-a', 'feedback-b']);
});

test('原版隔日訂正用四步狀態明確顯示目前允許的動作', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => ({
    initial:paperReviewStage({ attempts:0 }),
    tried:paperReviewStage({ attempts:1 }),
    detail:paperReviewStage({ attempts:1, aiDetail:{} }),
    verified:paperReviewStage({ pendingLevel:2 }),
    html:paperReviewStageHTML({ attempts:1 }),
  }))()`));
  assert.deepEqual([result.initial, result.tried, result.detail, result.verified], [1, 2, 3, 4]);
  assert.match(result.html, /只看答案重想/);
  assert.match(result.html, /保存一次真實嘗試/);
  assert.match(result.html, /需要時看詳解並重算/);
  assert.match(result.html, /AI 驗證後完成/);
});

test('未登入時離線開練不再被原生確認框阻擋', () => {
  const { context, run } = loadApp();
  let confirms = 0;
  context.confirm = () => { confirms++; return true; };
  const allowed = run(`(() => { supa = {}; syncState.user = null; syncGateAsked = false; return syncGate(); })()`);
  assert.equal(allowed, true);
  assert.equal(confirms, 0);
  assert.match(run('syncState.msg'), /只存這台/);
});
