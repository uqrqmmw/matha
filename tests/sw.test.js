'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ROOT } = require('./helpers/load-app');

test('service worker 只刪除本 app prefix 的舊快取', async () => {
  const handlers = {};
  const deleted = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    self: {
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting() { return Promise.resolve(); },
      clients: { claim() { return Promise.resolve(); } },
      location: { origin: 'https://example.test' },
    },
    caches: {
      keys: async () => ['matha-v25', 'matha-v26', 'matha-v27', 'matha-v28', 'matha13-v25', 'other-pwa-v4'],
      delete: async (key) => { deleted.push(key); return true; },
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      match: async () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });
  let activation;
  handlers.activate({ waitUntil(promise) { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ['matha-v25', 'matha-v26', 'matha-v27', 'matha-v28']);
});
