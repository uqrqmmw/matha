'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain } = require('../tests/helpers/load-app');

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function main() {
  const output = value('--out');
  const imagePaths = process.argv.slice(process.argv.indexOf('--images') + 1);
  if (!output || !process.argv.includes('--images') || imagePaths.length !== 6) {
    throw new Error('Usage: node scripts/build-paper-grade-eval-request.js --out <request.json> --images <six JPEG pages>');
  }
  const pages = imagePaths.map((file) => fs.readFileSync(path.resolve(file)).toString('base64'));
  const { context, run } = loadApp();
  context.__evalPages = pages;
  const captured = await run(`(async () => {
    let request = null;
    openAiInvoke = async (payload) => {
      request = payload;
      return { json:{}, model:'gpt-5.5', requestId:'capture-only' };
    };
    await paperAiGradeCall(PAPER_SOURCES[0], __evalPages);
    return request;
  })()`);
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(plain(captured))}\n`, 'utf8');
  const bytes = fs.statSync(path.resolve(output)).size;
  if (bytes > 14_000_000) throw new Error(`request 超過 Edge 上限：${bytes} bytes`);
  process.stdout.write(JSON.stringify({ output: path.resolve(output), bytes, pages: imagePaths.length }));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
