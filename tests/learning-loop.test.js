'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('級分校準只採完整模擬，三場皆過 72% 才標穩定', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    S.attempts = Array.from({length: 40}, (_, i) => ({ qid: BANK[i].id, ok: true, ms: 1000, d: today(), mode: 'practice', ts: i + 1 }));
    const before = mockCalibration();
    S.mocks = [
      { d: addDays(today(), -2), ok: 9, n: 12, acc: .75 },
      { d: addDays(today(), -1), ok: 10, n: 12, acc: 10 / 12 },
      { d: today(), ok: 9, n: 12, acc: .75 },
    ];
    const after = mockCalibration();
    return { before, after, pulse: practicePulse() };
  })()`));
  assert.equal(result.before.count, 0, '全對的弱項練習也不得冒充模擬校準');
  assert.equal(result.after.count, 3);
  assert.equal(result.after.stable, true);
  assert.equal(result.after.passes, 3);
  assert.equal(result.after.grade, '13 級分');
  assert.equal(result.pulse.n, 40);
});

test('下一步優先順序為到期錯題，再校準，再弱項', () => {
  const { run } = loadApp();
  const states = plain(run(`(() => {
    S.attempts = []; S.mocks = []; S.wrong = {};
    const noData = nextBestAction();
    S.wrong[BANK[0].id] = { fails: 1, wins: 0, itv: 1, due: today(), err: '概念不熟' };
    const due = nextBestAction();
    delete S.wrong[BANK[0].id];
    S.mocks = [{ d: today(), ok: 8, n: 12, acc: 8 / 12 }];
    for (let i = 0; i < 4; i++) S.attempts.push({ qid: BANK.find((q) => q.topic === 'num').id, ok: i === 0, ms: 180000, d: today(), mode: 'practice', ts: i + 1 });
    const weak = nextBestAction();
    return { noData: noData.kind, due: due.kind, weak: weak.kind };
  })()`));
  assert.deepEqual(states, { noData: 'mock', due: 'review', weak: 'topic' });
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

test('儀表板明示練習答對率不換算級分，並保存類題遷移欄位', () => {
  const { run } = loadApp();
  const html = run('scoreGoalCard()');
  assert.match(html, /弱項刷題答對率不拿來灌高級分/);
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
    return { source: cal.source, acc: cal.acc, plan: recoveryPlanCard(), card: extMockCard() };
  })()`));
  assert.equal(result.source, 'external');
  assert.equal(result.acc, 0.71);
  assert.match(result.plan, /機率/);
  assert.doesNotMatch(result.card, /<img src=x/);
  assert.doesNotMatch(result.card, /<script>x/);
  assert.match(result.card, /&lt;img/);
  assert.match(result.card, /剩 3 分/);
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
