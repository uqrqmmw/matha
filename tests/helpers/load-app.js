'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function createStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); },
  };
}

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function loadApp() {
  const listeners = {};
  const document = {
    readyState: 'loading',
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return {}; },
  };
  const context = {
    console,
    document,
    navigator: { storage: {} },
    localStorage: createStorage(),
    location: { hash: '', origin: 'http://localhost', pathname: '/', search: '', protocol: 'http:' },
    history: { replaceState() {} },
    alert() {},
    confirm() { return true; },
    prompt() {},
    addEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URL,
    Blob,
    Map,
    Set,
    Promise,
    innerHeight: 900,
    devicePixelRatio: 1,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'bank.js'), 'utf8'), context, { filename: 'bank.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'practice-bank.js'), 'utf8'), context, { filename: 'practice-bank.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  return {
    context,
    listeners,
    run(source) { return vm.runInContext(source, context); },
  };
}

module.exports = { ROOT, createStorage, loadApp, plain };
