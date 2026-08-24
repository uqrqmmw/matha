'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertPrivateOutput,
  exerciseGroupId,
  groupPendingItems,
  parseArgs,
  parsePdfInfo,
  pngDimensions,
} = require('../scripts/prepare-figure-review');

test('exercise subparts share one review asset without merging separate exercises', () => {
  assert.equal(exerciseGroupId('v-trig-p035-ex43-a'), 'v-trig-p035-ex43');
  assert.equal(exerciseGroupId('v-trig-p122-calc4b'), 'v-trig-p122-calc4');
  assert.equal(exerciseGroupId('v-poly-p138-f6-3'), 'v-poly-p138-f6');
  assert.equal(exerciseGroupId('v-trig-p155-adv-s2'), 'v-trig-p155-adv-s2');
  const grouped = groupPendingItems([
    { id: 'v-trig-p035-ex43-a', bookId: 'book-1', page: 35 },
    { id: 'v-trig-p035-ex43-b', bookId: 'book-1', page: 35 },
    { id: 'v-trig-p036-ex43-a', bookId: 'book-1', page: 36 },
  ]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((group) => group.questions.length).sort(), [1, 2]);
});

test('pdfinfo parser and required CLI arguments fail closed', () => {
  assert.deepEqual(parsePdfInfo('Title: x\nPages:          304\n'), { pages: 304 });
  assert.throws(() => parsePdfInfo('Title: x\n'), /page count/);
  assert.throws(() => parseArgs(['--pending', 'x']), /Usage/);
  assert.deepEqual(parseArgs(['--pending', 'a', '--pdf-root', 'b', '--output', 'c', '--dpi', '96']).dpi, 96);
});

test('private review output cannot be written into the Git repository', () => {
  assert.throws(() => assertPrivateOutput(path.join(__dirname, '..', 'tmp-review')), /outside the Git repository/);
  assert.doesNotThrow(() => assertPrivateOutput(path.join(os.tmpdir(), 'matha-private-review-test')));
});

test('PNG dimensions are read from a verified PNG header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matha-png-'));
  const file = path.join(dir, 'sample.png');
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(640, 16);
  header.writeUInt32BE(480, 20);
  fs.writeFileSync(file, header);
  assert.deepEqual(pngDimensions(file), { width: 640, height: 480 });
});
