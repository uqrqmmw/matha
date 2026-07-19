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
    Request: class { constructor(url, init) { this.url = url; Object.assign(this, init); } },
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

function swContext({ fetchImpl, cacheEntries }) {
  const handlers = {};
  const puts = [];
  const store = new Map(Object.entries(cacheEntries || {}));
  const cache = {
    addAll: async () => {},
    put: async (key, value) => { puts.push([String(key), value]); store.set(String(key), value); },
    match: async (key) => store.get(String(new URL(String(key), 'https://example.test/'))) || store.get(String(key)),
  };
  const context = {
    console, setTimeout, clearTimeout, URL,
    Request: class { constructor(url, init) { this.url = url; Object.assign(this, init); } },
    Response: { error: () => ({ __swError: true, ok: false }) },
    fetch: fetchImpl,
    self: {
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting() { return Promise.resolve(); },
      clients: { claim() { return Promise.resolve(); } },
      location: { origin: 'https://example.test' },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });
  const dispatch = (request) => new Promise((resolve) => {
    handlers.fetch({ request, respondWith: (p) => resolve(p) });
  }).then((p) => p);
  return { handlers, dispatch, puts, store };
}

test('fetch：部署中的 404/5xx 不得蓋掉手上的好快取', async () => {
  const cachedResponse = { ok: true, cachedShell: true };
  const { dispatch, puts } = swContext({
    // 404 也要有 clone：否則「誤 put 非 OK 回應」的迴歸會在 clone() 丟錯時被吞掉，puts 斷言就測不到
    fetchImpl: async () => ({ ok: false, status: 404, clone: () => ({ poisoned: true }) }),
    cacheEntries: { 'https://example.test/app.js': cachedResponse },
  });
  const result = await dispatch({ url: 'https://example.test/app.js?v=0718l', method: 'GET', mode: 'no-cors' });
  assert.equal(result, cachedResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 0, '404 不只是不能回給頁面，也絕不能寫進快取（毒化後下次離線就開壞）');
});

test('fetch：斷網退回快取；網路正常則回網路並以無 query 的 key 更新快取', async () => {
  const cachedResponse = { ok: true, cachedShell: true };
  const offline = await swContext({
    fetchImpl: async () => { throw new Error('offline'); },
    cacheEntries: { 'https://example.test/app.js': cachedResponse },
  }).dispatch({ url: 'https://example.test/app.js?v=0718l', method: 'GET', mode: 'no-cors' });
  assert.equal(offline, cachedResponse);

  const fresh = { ok: true, status: 200, clone: () => ({ cloned: true }) };
  const online = swContext({
    fetchImpl: async () => fresh,
    cacheEntries: { 'https://example.test/app.js': cachedResponse },
  });
  const result = await online.dispatch({ url: 'https://example.test/app.js?v=0718l', method: 'GET', mode: 'no-cors' });
  assert.equal(result, fresh);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(online.puts.map(([key]) => key), ['https://example.test/app.js']);
});

test('fetch：首載無快取時，導覽失敗退回 index.html 外殼', async () => {
  const shell = { ok: true, shell: true };
  const { dispatch } = swContext({
    fetchImpl: async () => ({ ok: false, status: 404 }),
    cacheEntries: { 'https://example.test/index.html': shell },
  });
  const result = await dispatch({ url: 'https://example.test/', method: 'GET', mode: 'navigate' });
  assert.equal(result, shell);
});
