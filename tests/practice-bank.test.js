'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

test('核心變式題庫把 14 單元補到可大量輪替的 362 題', () => {
  const { run } = loadApp();
  const summary = plain(run(`(() => {
    const generated = BANK.filter((q) => q.src === '核心變式題庫');
    return {
      total: BANK.length,
      generated: generated.length,
      uniqueIds: new Set(BANK.map((q) => q.id)).size,
      uniqueGeneratedStems: new Set(generated.map((q) => q.q)).size,
      byTopic: Object.fromEntries(Object.keys(TOPICS).map((k) => [k, generated.filter((q) => q.topic === k).length])),
    };
  })()`));
  assert.equal(summary.total, 362);
  assert.equal(summary.generated, 280);
  assert.equal(summary.uniqueIds, summary.total);
  assert.equal(summary.uniqueGeneratedStems, summary.generated);
  assert.deepEqual(Object.values(summary.byTopic), Array(14).fill(20));
});

test('核心變式都有可追溯模板、答案與解題提示', () => {
  const { run } = loadApp();
  const invalid = plain(run(`BANK.filter((q) => q.src === '核心變式題庫').filter((q) =>
    !q.grp || q.type !== 'fill' || !Array.isArray(q.ans) || !q.ans.length || !q.sol || !q.tip
  ).map((q) => q.id)`));
  assert.deepEqual(invalid, []);
});

test('跨單元抽查固定模板答案，避免題目與答案生成脫鉤', () => {
  const { run } = loadApp();
  const answers = plain(run(`Object.fromEntries([
    'core-num-symmetric-1', 'core-line-distance-1', 'core-poly-vertex-1',
    'core-seq-geometric-sum-1', 'core-comb-perm-three-1', 'core-prob-without-replace-1',
    'core-data-z-score-1', 'core-trig1-area-1', 'core-trig2-maximum-1',
    'core-exp-growth-1', 'core-vec-perpendicular-1', 'core-svec-norm-square-1',
    'core-splane-line-plane-1', 'core-mat-product-1'
  ].map((id) => [id, BANK.find((q) => q.id === id).ans[0]]))`));
  assert.deepEqual(answers, {
    'core-num-symmetric-1': '18',
    'core-line-distance-1': '1',
    'core-poly-vertex-1': '-4',
    'core-seq-geometric-sum-1': '7',
    'core-comb-perm-three-1': '60',
    'core-prob-without-replace-1': '3/10',
    'core-data-z-score-1': '-2',
    'core-trig1-area-1': '6',
    'core-trig2-maximum-1': '-1',
    'core-exp-growth-1': '8',
    'core-vec-perpendicular-1': '-1',
    'core-svec-norm-square-1': '14',
    'core-splane-line-plane-1': '1',
    'core-mat-product-1': '0',
  });
});
