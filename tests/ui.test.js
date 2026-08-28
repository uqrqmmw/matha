'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, loadApp } = require('./helpers/load-app');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('UI 使用專案內建 SVG 圖示，不依賴外部圖示庫', () => {
  const html = read('index.html');
  assert.match(html, /<symbol id="ui-brand"/);
  assert.match(html, /<symbol id="ui-target"/);
  assert.match(html, /<symbol id="ui-tutor"/);
  assert.doesNotMatch(html, /fontawesome|material-icons|unpkg\.com|cdnjs\.cloudflare\.com/i);
});

test('導覽名稱為純文字且搭配 SVG 圖示', () => {
  const source = read('app.js');
  const viewsBlock = source.match(/const VIEWS = \{([\s\S]*?)\n\};/);
  assert.ok(viewsBlock, '找不到 VIEWS 設定');
  assert.doesNotMatch(viewsBlock[1], /[\u{1F000}-\u{1FAFF}\uFE0F\u200D]/u);
  assert.match(viewsBlock[1], /icon:\s*'clipboard'/);
  assert.match(source, /uiIcon\(VIEWS\[v\]\.icon\)/);
});

test('介面文字清理會移除 emoji 並保留多行訊息', () => {
  const { context, run } = loadApp();
  context.__uiText = '🎯 主題刷題 ✅\n  下一行  內容';
  assert.equal(run('uiTextOnly(__uiText)'), '主題刷題\n下一行 內容');
});

test('低彩度設計 token 與 PWA 主題色一致', () => {
  const css = read('style.css');
  const html = read('index.html');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.match(css, /--bg:\s*#f3f1ec/);
  assert.match(css, /--accent:\s*#75675c/);
  assert.match(html, /name="theme-color" content="#75675c"/);
  assert.equal(manifest.theme_color, '#75675c');
});

test('所有學生手寫畫布只提供黑藍綠，紅色保留給 AI 批改', () => {
  const { run } = loadApp();
  const html = run('inkToolsHTML()');
  assert.match(html, />黑<\/button>/);
  assert.match(html, />藍<\/button>/);
  assert.match(html, />綠<\/button>/);
  assert.doesNotMatch(html, /ink-c-r|inkColorSet\('r'\)|>紅<\/button>/);
  assert.equal(run('INK_COLORS.r'), '#b43b32');
});

test('Galaxy Tab S10 Ultra 橫直向版面使用大平板斷點與至少 48px 主觸控區', () => {
  const css = read('style.css');
  const source = read('app.js');
  assert.match(css, /Galaxy Tab S10 Ultra/);
  assert.match(css, /@media \(min-width: 800px\) and \(min-height: 700px\)/);
  assert.match(css, /--tablet-page-max:\s*1560px/);
  assert.match(css, /\.btn\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(css, /\.paper-icon-btn,\s*\.paper-ink-tools button\s*\{\s*min-width:\s*48px;\s*min-height:\s*48px/);
  assert.match(css, /\.btn\.sm\s*\{\s*min-height:\s*44px/);
  assert.doesNotMatch(source, /document\.createElement\('div'\); dc\.id = 'day-counter'/);
  assert.doesNotMatch(css, /#day-counter|\.dayctr|\.dc-toggle/);
  assert.match(css, /orientation: portrait[\s\S]*?\.recall-grid,\s*\.concept-grid\s*\{\s*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /orientation: portrait[\s\S]*?\.paper-source-grid\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(source, /document\.body\.dataset\.view = view/);
});

test('Ultra 首頁與作答流程善用寬畫面，原卷控制不再切走上下空間', () => {
  const css = read('style.css');
  const source = read('app.js');
  assert.match(css, /body\[data-view="home"\] #app\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.qcard\.booklet\.sheet\s*\{[\s\S]*?grid-template-columns:\s*minmax\(520px/);
  assert.match(css, /\.vision-workspace\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.paper-session-shell > \.paper-workbar\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.paper-session-shell \.paper-page-viewport\s*\{[\s\S]*?padding:\s*0/);
  assert.match(css, /\.paper-session-shell > \.paper-finish-bar\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.paper-ui-hidden > \.paper-workbar/);
  assert.match(source, /class="mock-paper-nav"/);
  assert.match(source, /class="vision-paper-map"/);
  assert.match(source, /function paperWorkspaceFit\(\)/);
  assert.match(source, /class="paper-ui-toggle"/);
  assert.doesNotMatch(source, /class="paper-spread-preview"/);
  assert.match(source, /function homeSecondaryTasks\(primary\)/);
  assert.match(source, /\.slice\(0, 2\)/);
  assert.match(source, /<details class="card training-rules"><summary>/);
  assert.doesNotMatch(source, /<details class="card training-rules" open/);
});

test('首頁只列最多兩個真的到期閉環，且不重複主要任務', () => {
  const { run } = loadApp();
  const tasks = run(`(() => {
    outlineUnits = () => [{ reference:true }];
    outlineDueUnits = () => [{ id:'outline' }];
    visionDueEntries = () => [{ id:'vision' }];
    visionActivePaperEntries = () => [];
    conceptDueCards = () => [{ id:'concept' }];
    hasRecentConceptWork = () => false;
    learningSignalIndex = () => ({ questions:new Map([['retention', { retentionDue:true }]]) });
    mockCalibration = () => ({ count:1, staleDays:9 });
    return homeSecondaryTasks({ kind:'mock' });
  })()`);
  assert.equal(tasks.length, 2);
  assert.deepEqual(Array.from(tasks, (task) => task.view), ['practice', 'outline']);
  assert.equal(tasks.some((task) => task.view === 'mock'), false);
});

test('隔日訂正沿用全頁原卷工作台，新筆跡與第一次紅筆分層且詳解不壓縮卷面', () => {
  const css = read('style.css');
  const source = read('app.js');
  assert.match(source, /class='paper-session-shell paper-review-session'/);
  assert.match(source, /id='paper-base-ink-canvas'/);
  assert.match(source, /id='paper-ink-canvas'/);
  assert.match(source, /id='paper-ai-canvas'/);
  assert.match(source, /id='paper-detail-shortcut'/);
  assert.match(source, /看第 \$\{no\} 題詳解/);
  assert.match(css, /\.paper-review-session #paper-ink-canvas\s*\{\s*z-index:\s*3/);
  assert.match(css, /\.paper-review-session #paper-ai-canvas\s*\{\s*z-index:\s*4/);
  assert.match(css, /\.paper-detail-shortcut\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.paper-detail-drawer\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(source, /class='paper-review-effort'/,
    '沒有完整算式時仍要能在同一全頁工作台留下方向、單元與卡點');
  assert.match(css, /\.paper-review-effort\s*\{[\s\S]*?min-width:\s*min\(330px, 100%\)/);
  assert.doesNotMatch(source, /paper-review-layout|paper-review-ink-canvas/);
});

test('AI 回饋欄位統一經數學字串修復後再渲染', () => {
  const source = read('app.js');
  const unsafeAiEscapes = [
    'escH(v.firstError)',
    'escH(v.praise)',
    'escH(v.nextTime)',
    'escH(s.what)',
    'escH(s.fix)',
  ];
  unsafeAiEscapes.forEach((pattern) => assert.equal(source.includes(pattern), false, pattern));
  assert.match(source, /rtAi\(v\.firstError\)/);
  assert.match(source, /rtAi\(s\.what/);
});

test('OpenAI 金鑰只存在 Edge Function secret，不進瀏覽器程式', () => {
  const source = read('app.js');
  const proxy = read('supabase/functions/openai-proxy/index.ts') + read('supabase/functions/openai-proxy/lib.ts');
  assert.doesNotMatch(source, /api\.openai\.com|Authorization:\s*[`'"]Bearer\s+\$\{?apiKey/i);
  assert.doesNotMatch(source, /id="aikey"|aiKeySave\(/);
  assert.match(source, /const AI_FUNCTION_URL = 'https:\/\/rrihysbxhsbxjteqmtdu\.supabase\.co\/functions\/v1\/' \+ AI_FUNCTION/);
  assert.match(proxy, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(proxy, /APP_SUPABASE_URL.*rrihysbxhsbxjteqmtdu/);
  assert.match(proxy, /https:\/\/uqrqmmw\.github\.io/);
  assert.match(proxy, /\/auth\/v1\/user/);
  assert.match(proxy, /Authorization: authorization/);
  assert.match(proxy, /OPENAI_ALLOWED_ORIGINS/);
  assert.match(proxy, /OPENAI_ALLOWED_(EMAILS|USER_IDS)/);
  assert.match(proxy, /!allowedUserIds\.size && !allowedEmails\.size/);
  assert.match(proxy, /safety_identifier/);
  assert.match(proxy, /type: "json_schema"/);
  assert.match(proxy, /outline:\s*\{/);
  assert.match(proxy, /concept:\s*\{/);
  assert.match(proxy, /paper_grade:\s*\{/);
  assert.match(proxy, /hasFinalAnswer:\s*\{\s*type:\s*"boolean"\s*\}/);
  assert.match(proxy, /selectedOptions:\s*\{/);
  assert.match(proxy, /"strike"/);
  assert.match(proxy, /"add"/);
  assert.match(proxy, /paper_detail:\s*\{/);
  assert.match(proxy, /goodWork:\s*\{/);
  assert.match(proxy, /firstErrorEvidence:\s*\{/);
  assert.match(proxy, /confidence:\s*\{/);
  assert.match(proxy, /"paper_grade"/);
  assert.match(proxy, /"paper_detail"/);
  assert.match(proxy, /responseType === "paper_grade"[\s\S]*?12000/);
  assert.match(proxy, /responseType === "paper_grade" \? 110_000 : 80_000/);
  assert.match(proxy, /responseType === "paper_detail"[\s\S]*?4200/);
  assert.match(proxy, /responseType === "paper_detail"[\s\S]*?\? "high"[\s\S]*?: "medium"/);
  assert.match(proxy, /detail: "original"/);
  assert.match(proxy, /store: false/);
  assert.match(proxy, /const model = "gpt-5\.5"/);
  assert.doesNotMatch(proxy, /Deno\.env\.get\("OPENAI_MODEL"\)/);
  assert.doesNotMatch(proxy, /gpt-5\.6(?:-sol|-terra|-luna)?/);
});

test('原卷 AI 誤讀可只修正目前頁，並保留辨識答案與人工覆核歷史', () => {
  const source = read('app.js');
  assert.match(source, /paperGradeAuditOpen\(\$\{page\}\)/);
  assert.match(source, /class="paper-audit-read"/);
  assert.match(source, /保存這頁修正/);
  assert.match(source, /paperGradeAuditPush\(run, '人工覆核前'\)/);
});

test('老師檢視版提供單頁摘要與完整逐題兩種輸出', () => {
  const source = read('app.js');
  const css = read('style.css');
  assert.match(source, /給王老師的單頁摘要/);
  assert.match(source, /teacherReportPrint\(true\)/);
  assert.match(source, /teacherReportPrint\(false\)/);
  assert.match(css, /body\.teacher-summary-print \.teacher-detail-block/);
});

test('推薦題可零成本換題或回報品質，介面明示不列入能力證據', () => {
  const source = read('app.js');
  assert.match(source, /questionFeedbackAction\('obvious'\)/);
  assert.match(source, /questionFeedbackAction\('issue'\)/);
  assert.match(source, /不會算成答錯、未答或能力證據/);
  assert.match(source, /mode:'question-feedback'.*excluded:true/);
  assert.match(source, /prac\.queue\[prac\.i\] = candidate/);
  assert.doesNotMatch(source, /prac\.queue\.push\(candidate\)/, '替題必須取代目前位置，不能把十題練習加長成十一題');
});
