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

test('首次安裝即預先快取全部 KaTeX woff2 字型，單檔失敗不破壞安裝', async () => {
  const handlers = {};
  const fetched = [];
  const cached = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => { fetched.push(url); return { ok: true }; },
    self: {
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting() { return Promise.resolve(); },
      clients: { claim() { return Promise.resolve(); } },
      location: { origin: 'https://example.test' },
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async (url) => { cached.push(url); } }),
      keys: async () => [], delete: async () => true, match: async () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });
  let installation;
  handlers.install({ waitUntil(promise) { installation = promise; } });
  await installation;
  assert.equal(fetched.length, 20);
  assert.equal(cached.length, 20);
  assert.equal(fetched.every((url) => /vendor\/katex\/fonts\/KaTeX_.+\.woff2$/.test(url)), true);
});
