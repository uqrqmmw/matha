const assert = require('node:assert/strict');
const fs = require('node:fs');

const target = 'https://uqrqmmw.github.io/matha/';
const html = fs.readFileSync('index.html', 'utf8');
const worker = fs.readFileSync('sw.js', 'utf8');

assert.match(html, new RegExp(`<link rel="canonical" href="${target.replaceAll('/', '\\/')}"`));
assert.match(html, /location\.replace\(target\)/);
assert.match(html, /registration\.unregister\(\)/);
assert.match(html, /name\.startsWith\('matha-v'\)/);
assert.match(worker, /Response\.redirect\(TARGET, 302\)/);
assert.match(worker, /registration\.unregister\(\)/);
assert.equal(/\p{Extended_Pictographic}/u.test(html), false);

console.log('redirect target, cache cleanup, and no-emoji checks passed');
