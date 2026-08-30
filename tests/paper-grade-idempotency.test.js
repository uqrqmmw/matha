'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./helpers/load-app');

function directRun(sourceExpr, extra = '') {
  return `(async () => {
    save = () => {};
    const source = ${sourceExpr};
    const submittedAt = 1700000001000;
    const attempt = { schema:PAPER_SUBMIT_ATTEMPT_SCHEMA,
      attemptId:'paper-submit-1234567890abcdef', runId:'paper-run-1700000000000',
      sourceId:source.id, status:'accepted', remainingMs:5000000,
      inkSnapshotSha256:'a'.repeat(64), submittedAt, acceptedAt:submittedAt + 1,
      canceledAt:null, runCreatedAppVersion:APP_VER,
      runCreatedAt:1700000000000, paperLayoutVersion:PAPER_LAYOUT_VERSION,
      sourcePageCount:source.scans.length,
      decisionReason:'accepted-first-for-run', winnerAttemptId:'', winner:null,
      pageManifest:source.scans.map((_, page) => ({ page,
        qid:'paper:paper-run-1700000000000:v2:' + page, clientId:'accepted-client-' + page,
        revision:page + 1, cloudSha256:'a'.repeat(64), updatedAt:'2026-08-30T00:00:00.000Z' })) };
    const paperRun = { id:attempt.runId, sourceId:source.id, status:'grading',
      createdAt:1700000000000, submittedAt, runCreatedAppVersion:APP_VER,
      paperLayoutVersion:PAPER_LAYOUT_VERSION, submitAttempt:attempt };
    ${extra}
  })()`;
}

test('first pass generation 0 pending is fail-closed and does not issue/reinvoke another generation', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    const calls = [];
    openAiInvoke = async (payload) => {
      calls.push(payload);
      return { message:'already dispatched', gradeJob:{ status:'dispatched', generation:0,
        modelInputBindingSha256:'b'.repeat(64), dispatchedAt:'2026-08-30T00:00:00Z' } };
    };
    let error = null;
    try { await paperAiGradeCall(source, paperRun, source.key); }
    catch (caught) { error = { message:caught.message, pending:caught.gradeJobPending, generation:caught.gradeGeneration }; }
    return { types:calls.map((row) => row.responseType), sentGeneration:calls[0].context.gradeGeneration,
      pendingGeneration:paperRun.pendingGradeGeneration, error };
  `)));
  assert.deepEqual(result.types, ['paper_grade']);
  assert.equal(result.sentGeneration, 0);
  assert.equal(result.pendingGeneration, 0);
  assert.deepEqual(result.error, { message:'already dispatched', pending:true, generation:0 });
});

test('explicit regrade obtains one server generation and sends exactly that generation', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { score:75, questions:[] };
    paperRun.gradeGeneration = 3;
    paperRun.gradePreviousGeneration = 3;
    paperRun.gradeGenerationRequestId = 'paper-grade-generation-1234567890abcdef';
    const calls = [];
    openAiInvoke = async (payload) => {
      calls.push(payload);
      if (payload.responseType === 'paper_grade_generation') return { gradeJob:{ status:'reserved', generation:4,
        modelInputBindingSha256:'c'.repeat(64) } };
      return { model:'gpt-5.5', requestId:'resp_idempotent_test', json:{ questions:[] },
        serverGradeReceipt:{ gradeGeneration:4 }, gradeJob:{ status:'completed', generation:4,
          modelInputBindingSha256:'c'.repeat(64), completedAt:'2026-08-30T00:00:01Z' },
        gradeJobContentDigests:{ normalized_model_json_sha256:'d'.repeat(64),
          model_metadata_sha256:'e'.repeat(64), receipt_envelope_sha256:'f'.repeat(64) } };
    };
    const response = await paperAiGradeCall(source, paperRun, source.key);
    return { types:calls.map((row) => row.responseType),
      issueRequest:calls[0].context.gradeGenerationRequestId,
      previousGeneration:calls[0].context.gradePreviousGeneration,
      sentGeneration:calls[1].context.gradeGeneration,
      storedPending:paperRun.pendingGradeGeneration, responseGeneration:response.gradeGeneration };
  `)));
  assert.deepEqual(result.types, ['paper_grade_generation', 'paper_grade']);
  assert.equal(result.issueRequest, 'paper-grade-generation-1234567890abcdef');
  assert.equal(result.previousGeneration, 3);
  assert.equal(result.sentGeneration, 4);
  assert.equal(result.storedPending, 4);
  assert.equal(result.responseGeneration, 4);
});

test('retry of an issued generation only queries that generation and never allocates another', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { score:75, questions:[] };
    paperRun.gradeGenerationRequestId = 'paper-grade-generation-1234567890abcdef';
    paperRun.pendingGradeGeneration = 4;
    const calls = [];
    openAiInvoke = async (payload) => { calls.push(payload); return { message:'still pending',
      gradeJob:{ status:'dispatched', generation:4, modelInputBindingSha256:'c'.repeat(64) } }; };
    let pending = false;
    try { await paperAiGradeCall(source, paperRun, source.key); }
    catch (error) { pending = error.gradeJobPending === true; }
    return { types:calls.map((row) => row.responseType), generation:calls[0].context.gradeGeneration, pending };
  `)));
  assert.deepEqual(result, { types:['paper_grade'], generation:4, pending:true });
});

test('merge never splices generations and keeps a newer pending generation in grading', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const receipt = { authority:'supabase-service-role-storage-readback', canonicalDigest:'a'.repeat(64), gradeGeneration:1 };
    const grade = { gradeGeneration:1, gradedAt:100, score:5, wrongNos:[2], uncertainNos:[],
      serverGradeReceipt:receipt, questions:[{ no:1, status:'correct', points:5 }, { no:2, status:'incorrect', points:0 }] };
    const base = { id:'paper-run-1700000000000', sourceId:'paper-mock-1', createdAt:1,
      submittedAt:2, status:'awaiting-correction', mt:100, aiGrade:grade };
    const pending = { ...base, status:'grading', mt:200, pendingGradeGeneration:2,
      gradePreviousGeneration:1,
      gradeGenerationRequestId:'paper-grade-generation-merge-1234567890abcdef',
      gradeJob:{ status:'dispatched', generation:2, modelInputBindingSha256:'b'.repeat(64) } };
    const mergedPending = mergePaperRunRecord(base, pending);
    const grade2 = { ...grade, gradeGeneration:2, gradedAt:300, score:0,
      serverGradeReceipt:{ ...receipt, canonicalDigest:'c'.repeat(64), gradeGeneration:2 },
      questions:[{ no:1, status:'incorrect', points:0 }, { no:2, status:'incorrect', points:0 }] };
    const mergedComplete = mergePaperGrade(grade, grade2);
    return { pendingStatus:mergedPending.status, pendingGeneration:mergedPending.pendingGradeGeneration,
      pendingRequest:mergedPending.gradeGenerationRequestId, completedGeneration:mergedComplete.gradeGeneration,
      completedScore:mergedComplete.score, completedReceipt:mergedComplete.serverGradeReceipt.canonicalDigest };
  })()`));
  assert.equal(result.pendingStatus, 'grading');
  assert.equal(result.pendingGeneration, 2);
  assert.equal(result.pendingRequest, 'paper-grade-generation-merge-1234567890abcdef');
  assert.equal(result.completedGeneration, 2);
  assert.equal(result.completedScore, 0);
  assert.equal(result.completedReceipt, 'c'.repeat(64));
});

test('pre-issuance regrade survives merge and same-base device request ids converge deterministically', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const receipt = { authority:'supabase-service-role-storage-readback', canonicalDigest:'a'.repeat(64), gradeGeneration:1 };
    const grade = { gradeGeneration:1, gradedAt:100, score:5, wrongNos:[], uncertainNos:[],
      serverGradeReceipt:receipt, questions:[{ no:1, status:'correct', points:5 }] };
    const done = { id:'paper-run-1700000000000', sourceId:'paper-mock-1', createdAt:1,
      submittedAt:2, status:'awaiting-correction', mt:100, aiGrade:grade };
    const issuingA = { ...done, status:'grading', mt:200, gradePreviousGeneration:1,
      gradeGenerationRequestId:'paper-grade-generation-z-1234567890abcdef' };
    const issuingB = { ...done, status:'grading', mt:201, gradePreviousGeneration:1,
      gradeGenerationRequestId:'paper-grade-generation-a-1234567890abcdef' };
    const one = mergePaperRunRecord(done, issuingA);
    const converged = mergePaperRunRecord(issuingA, issuingB);
    return { oneStatus:one.status, oneRequest:one.gradeGenerationRequestId,
      status:converged.status, request:converged.gradeGenerationRequestId,
      conflict:!!converged.gradeGenerationRequestConflict,
      previous:converged.gradePreviousGeneration };
  })()`));
  assert.deepEqual(result, {
    oneStatus:'grading', oneRequest:'paper-grade-generation-z-1234567890abcdef',
    status:'grading', request:'paper-grade-generation-a-1234567890abcdef',
    conflict:false, previous:1,
  });
});

test('mismatched pre-issuance generation chains merge fail-closed', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const base = { id:'paper-run-1700000000000', sourceId:'paper-mock-1', createdAt:1,
      submittedAt:2, status:'grading', mt:100,
      gradeGenerationRequestId:'paper-grade-generation-a-1234567890abcdef', gradePreviousGeneration:1 };
    const other = { ...base, mt:200,
      gradeGenerationRequestId:'paper-grade-generation-b-1234567890abcdef', gradePreviousGeneration:2 };
    const merged = mergePaperRunRecord(base, other);
    return { status:merged.status, request:merged.gradeGenerationRequestId || null,
      conflict:merged.gradeGenerationRequestConflict };
  })()`));
  assert.equal(result.status, 'grading');
  assert.equal(result.request, null);
  assert.deepEqual(result.conflict.requestIds, [
    'paper-grade-generation-a-1234567890abcdef',
    'paper-grade-generation-b-1234567890abcdef',
  ]);
  assert.deepEqual(result.conflict.requests, [
    { requestId:'paper-grade-generation-a-1234567890abcdef', previousGeneration:1 },
    { requestId:'paper-grade-generation-b-1234567890abcdef', previousGeneration:2 },
  ]);
});

test('cross-device issuance conflict asks server latest generation, then issues only the matching intent', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { gradeGeneration:1, score:75, questions:[],
      serverGradeReceipt:{ gradeGeneration:1, canonicalDigest:'a'.repeat(64) } };
    paperRun.gradeGenerationRequestConflict = {
      kind:'concurrent-paper-grade-generation-issuance',
      requestIds:['paper-grade-generation-a-1234567890abcdef', 'paper-grade-generation-b-1234567890abcdef'],
      requests:[
        { requestId:'paper-grade-generation-a-1234567890abcdef', previousGeneration:1 },
        { requestId:'paper-grade-generation-b-1234567890abcdef', previousGeneration:2 },
      ], previousGeneration:2,
    };
    const calls = [];
    openAiInvoke = async (payload) => {
      calls.push(payload);
      if (payload.responseType === 'paper_grade_latest_status') return {
        gradeJob:{ status:'completed', generation:1, modelInputBindingSha256:'b'.repeat(64) } };
      if (payload.responseType === 'paper_grade_generation') return {
        gradeJob:{ status:'reserved', generation:2, issuanceRequestId:payload.context.gradeGenerationRequestId,
          modelInputBindingSha256:'c'.repeat(64) } };
      return { model:'gpt-5.5', requestId:'resp_cross_device_reconcile', json:{ questions:[] },
        serverGradeReceipt:{ gradeGeneration:2 }, gradeJob:{ status:'completed', generation:2,
          modelInputBindingSha256:'c'.repeat(64) } };
    };
    const response = await paperAiGradeCall(source, paperRun, source.key);
    return { types:calls.map((row) => row.responseType),
      request:calls[1].context.gradeGenerationRequestId,
      previous:calls[1].context.gradePreviousGeneration,
      sent:calls[2].context.gradeGeneration, response:response.gradeGeneration,
      conflict:paperRun.gradeGenerationRequestConflict || null };
  `)));
  assert.deepEqual(result, {
    types:['paper_grade_latest_status', 'paper_grade_generation', 'paper_grade'],
    request:'paper-grade-generation-a-1234567890abcdef', previous:1,
    sent:2, response:2, conflict:null,
  });
});

test('cross-device conflict adopts an in-flight server generation without invoking or issuing another', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { gradeGeneration:1, score:75, questions:[],
      serverGradeReceipt:{ gradeGeneration:1, canonicalDigest:'a'.repeat(64) } };
    paperRun.gradeGenerationRequestConflict = { requests:[
      { requestId:'paper-grade-generation-a-1234567890abcdef', previousGeneration:1 },
      { requestId:'paper-grade-generation-b-1234567890abcdef', previousGeneration:2 },
    ] };
    const calls = [];
    openAiInvoke = async (payload) => { calls.push(payload); return {
      message:'generation 2 is already dispatched',
      gradeJob:{ status:'dispatched', generation:2, modelInputBindingSha256:'b'.repeat(64) } } };
    let error = null;
    try { await paperAiGradeCall(source, paperRun, source.key); }
    catch (caught) { error = { pending:caught.gradeJobPending === true, message:caught.message }; }
    return { types:calls.map((row) => row.responseType), pending:paperRun.pendingGradeGeneration,
      status:paperRun.gradeJob.status, conflict:paperRun.gradeGenerationRequestConflict || null, error };
  `)));
  assert.deepEqual(result.types, ['paper_grade_latest_status']);
  assert.equal(result.pending, 2);
  assert.equal(result.status, 'dispatched');
  assert.equal(result.conflict, null);
  assert.equal(result.error.pending, true);
  assert.equal(result.error.message, 'generation 2 is already dispatched');
});

test('server generation newer than every merged request is read back instead of creating a duplicate', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { gradeGeneration:1, score:75, questions:[],
      serverGradeReceipt:{ gradeGeneration:1, canonicalDigest:'a'.repeat(64) } };
    paperRun.gradeGenerationRequestConflict = { requests:[
      { requestId:'paper-grade-generation-a-1234567890abcdef', previousGeneration:1 },
      { requestId:'paper-grade-generation-b-1234567890abcdef', previousGeneration:2 },
    ] };
    const calls = [];
    openAiInvoke = async (payload) => { calls.push(payload); return {
      model:'gpt-5.5', requestId:'resp_latest_generation', json:{ questions:[] },
      serverGradeReceipt:{ gradeGeneration:3 },
      gradeJob:{ status:'completed', generation:3, modelInputBindingSha256:'c'.repeat(64) } } };
    const response = await paperAiGradeCall(source, paperRun, source.key);
    return { types:calls.map((row) => row.responseType), generation:response.gradeGeneration,
      conflict:paperRun.gradeGenerationRequestConflict || null };
  `)));
  assert.deepEqual(result, { types:['paper_grade_latest_status'], generation:3, conflict:null });
});

test('an unanswered issuance request can only continue its same request id', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.aiGrade = { score:75, questions:[] };
    paperRun.gradeGenerationRequestId = 'paper-grade-generation-existing-1234567890abcdef';
    paperSourceSession = { source, run:paperRun };
    let reason = '';
    paperSourceGrade = (value) => { reason = value; };
    const started = paperSourceBeginExplicitRegrade();
    return { started, reason, request:paperRun.gradeGenerationRequestId };
  `)));
  assert.deepEqual(result, { started:true, reason:'繼續核發同一代批改',
    request:'paper-grade-generation-existing-1234567890abcdef' });
});

test('state sync merge keeps the active run reference canonical for later grade persistence', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const active = { id:'paper-run-1700000000000', sourceId:'paper-mock-1', status:'grading', mt:1,
      obsolete:'remove-me' };
    S.paperRuns = [active];
    paperSourceSession = { run:active };
    const remote = { ...S, paperRuns:[{ id:active.id, sourceId:active.sourceId, status:'grading', mt:2,
      remoteMarker:true }] };
    S = paperStateMergePreservingActiveSession(S, remote);
    paperSourceSession.run.gradeJob = { status:'completed', generation:0 };
    const stored = S.paperRuns.find((row) => row.id === active.id);
    return { same:stored === active && paperSourceSession.run === active,
      marker:stored.remoteMarker, persistedStatus:stored.gradeJob.status };
  })()`));
  assert.deepEqual(result, { same:true, marker:true, persistedStatus:'completed' });
});

test('accepted grading run stays locked when source loading fails', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.paperInkClients = Object.fromEntries(source.scans.map((_, page) => [page, 'client-' + page]));
    S.paperRuns = [paperRun];
    supa = {};
    syncState.user = { id:'user-1' };
    const screen = { innerHTML:'' };
    document.querySelector = (selector) => selector === '#app' ? screen : null;
    paperSourceFiles = async () => { throw new Error('temporary source failure'); };
    await startPaperSource(source.id);
    return { status:S.paperRuns[0].status, resumeAt:S.paperRuns[0].resumeAt,
      screen:screen.innerHTML };
  `)));
  assert.equal(result.status, 'grading');
  assert.equal(result.resumeAt, null);
  assert.match(result.screen, /交卷已接受|卷面仍鎖定/);
});

test('superseded device ink cannot start grading unless its live pages equal the accepted snapshot', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    const rows = [], refs = [], inkPages = {};
    for (let page = 0; page < source.scans.length; page++) {
      const qid = 'paper:' + paperRun.id + ':v2:' + page;
      const clientId = 'winner-client-' + page;
      const live = page === 0 ? [{ id:'winner-stroke', t0:10, t1:11, w:2, c:'black',
        pts:[[0.1,0.2,0.5],[0.2,0.3,0.5]] }] : [];
      const strokes = { paper:true, revision:page + 1, s:live, deleted:[] };
      const sha256 = await capabilityCanonicalDigest(strokes);
      refs.push({ page, qid, clientId, localSha256:sha256, cloudSha256:sha256, matched:true });
      rows.push({ client_id:clientId, qid, t0:paperRun.createdAt + page,
        proc:{ overlay:true, mode:'paper-source', page, revision:page + 1 }, strokes,
        updated_at:'2026-08-30T00:00:00.000Z' });
      inkPages[page] = { s:live.map((stroke) => ({ ...stroke, pts:stroke.pts.map((point) => point.slice()) })),
        deleted:new Set(), revision:page + 1, persistedRevision:page + 1, dirty:false };
    }
    const revisions = rows.map((row, page) => ({ page, revision:page + 1,
      persistedRevision:page + 1, dirty:false }));
    const acceptedDigest = await capabilityCanonicalDigest({ schema:1, runId:paperRun.id,
      sourceId:source.id, paperLayoutVersion:paperRun.paperLayoutVersion,
      submittedAt:paperRun.submittedAt, revisions,
      pages:refs.map((row) => ({ page:row.page, qid:row.qid, clientId:row.clientId,
        sha256:row.localSha256, cloudSha256:row.cloudSha256 })) });
    paperRun.submitAttempt.inkSnapshotSha256 = acceptedDigest;
    paperRun.submitAttempt.pageManifest = refs.map((row, page) => ({
      page, qid:row.qid, clientId:row.clientId, revision:page + 1,
      cloudSha256:row.cloudSha256, updatedAt:'2026-08-30T00:00:00.000Z' }));
    const session = { source, run:paperRun, inkPages, page:0, readOnly:true, submitLocked:true };
    paperInkCloudRows = async () => rows;
    const honest = await paperAcceptedGradeSnapshotPreflight(session);
    inkPages[0].s.push({ id:'loser-device-stroke', t0:20, t1:21, w:2, c:'blue',
      pts:[[0.5,0.5,0.5],[0.6,0.6,0.5]] });
    const superseded = await paperAcceptedGradeSnapshotPreflight(session);
    return { honest:!!honest, superseded:!!superseded };
  `)));
  assert.deepEqual(result, { honest:true, superseded:false });
});

test('status-only recovery returns an exact completed result without a local composite', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    paperRun.pendingGradeGeneration = 0;
    const calls = [];
    openAiInvoke = async (payload) => { calls.push(payload); return {
      model:'gpt-5.5', requestId:'resp_status_recovery', json:{ questions:[] },
      serverGradeReceipt:{ gradeGeneration:0 }, gradeJob:{ status:'completed', generation:0,
        modelInputBindingSha256:'b'.repeat(64) }, gradeJobContentDigests:{
          normalized_model_json_sha256:'c'.repeat(64), model_metadata_sha256:'d'.repeat(64),
          receipt_envelope_sha256:'e'.repeat(64) } } };
    const response = await paperAiGradeStatusCall(source, paperRun);
    return { type:calls[0].responseType, generation:calls[0].context.gradeGeneration,
      responseGeneration:response.gradeGeneration };
  `)));
  assert.deepEqual(result, { type:'paper_grade_status', generation:0, responseGeneration:0 });
});

test('accepted or grading runs cannot be discarded and accepted completion outranks a stale discard', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const attempt = { attemptId:'paper-submit-discard-1234567890abcdef', runId:'paper-run-1700000000000',
      sourceId:'paper-mock-1', status:'accepted', decisionReason:'accepted-first-for-run',
      remainingMs:1, inkSnapshotSha256:'a'.repeat(64), submittedAt:2, acceptedAt:3,
      runCreatedAppVersion:APP_VER };
    const locked = { id:attempt.runId, sourceId:attempt.sourceId, status:'grading', mt:1,
      createdAt:1, submittedAt:2, submitAttempt:attempt };
    S.paperRuns = [locked];
    const discarded = paperSourceDiscard(locked.id);
    const receipt = { authority:'supabase-service-role-storage-readback', canonicalDigest:'b'.repeat(64), gradeGeneration:0 };
    const completed = { ...locked, mt:3, status:'awaiting-correction', aiGrade:{ gradeGeneration:0,
      gradedAt:3, score:5, wrongNos:[], uncertainNos:[], questions:[{ no:1, status:'correct', points:5 }],
      serverGradeReceipt:receipt } };
    const staleDiscard = { ...locked, mt:4, status:'discarded', discardedAt:4 };
    const merged = mergePaperRunRecord(staleDiscard, completed);
    return { discarded, lockedStatus:locked.status, mergedStatus:merged.status,
      mergedGeneration:merged.aiGrade.gradeGeneration };
  })()`));
  assert.deepEqual(result, { discarded:false, lockedStatus:'grading',
    mergedStatus:'awaiting-correction', mergedGeneration:0 });
});

test('legacy paper-mock-1 without accepted submit receipt is visibly not regradeable', () => {
  const { run } = loadApp();
  const result = plain(run(`(() => {
    const source = paperSourceById('paper-mock-1');
    const legacy = { id:'paper-run-1784325851508', sourceId:source.id, submittedAt:1,
      paperLayoutVersion:2, aiGrade:{ score:75 } };
    const modern = { ...legacy, createdAt:1, runCreatedAppVersion:APP_VER,
      submitAttempt:{ schema:PAPER_SUBMIT_ATTEMPT_SCHEMA,
        attemptId:'paper-submit-modern-1234567890abcdef', runId:legacy.id, sourceId:source.id,
        status:'accepted', remainingMs:1, inkSnapshotSha256:'a'.repeat(64), submittedAt:1,
        acceptedAt:2, canceledAt:null, runCreatedAppVersion:APP_VER,
        runCreatedAt:1, paperLayoutVersion:PAPER_LAYOUT_VERSION,
        sourcePageCount:source.scans.length,
        decisionReason:'accepted-first-for-run', winnerAttemptId:'', winner:null,
        pageManifest:source.scans.map((_, page) => ({ page,
          qid:'paper:' + legacy.id + ':v2:' + page, clientId:'accepted-client-' + page,
          revision:page + 1, cloudSha256:'a'.repeat(64), updatedAt:'2026-08-30T00:00:00.000Z' })) } };
    return { legacy:paperSourceRegradeAvailable(legacy, source), modern:paperSourceRegradeAvailable(modern, source) };
  })()`));
  assert.deepEqual(result, { legacy:false, modern:true });
});

test('correction receipt timeout recovers the committed receipt even after local manifest drift', async () => {
  const { run } = loadApp();
  const result = plain(await run(directRun("paperSourceById('paper-mock-1')", `
    syncState.user = { id:'user-1' };
    const receiptId = 'paper-correction-retry-timeout-1234567890abcdef';
    const state = { correctionRetryReceiptRequestId:receiptId };
    const review = { run:paperRun, source };
    const strokeGeometry = { pts:[[.1,.2,.5],[.2,.3,.6]], c:'blue', w:1.25 };
    const strokeDigest = await capabilityCanonicalDigest(strokeGeometry);
    const committedCore = { authority:'supabase-immutable-paper-correction-retry-v1',
      receiptId, runId:paperRun.id, sourceId:source.id, questionNo:3,
      acceptedAttemptId:attempt.attemptId,
      acceptedInkSnapshotSha256:attempt.inkSnapshotSha256,
      acceptedPageManifestSha256:'b'.repeat(64), correctionPageManifest:[{
        page:0, qid:'paper:' + paperRun.id + '-correction:v2:0', clientId:'old-client',
        revision:4, cloudSha256:'c'.repeat(64), updatedAt:'2026-08-30T00:00:00.000Z' }],
      correctionLiveStrokeIds:['receipt-stroke-1'], correctionNewStrokeIds:['receipt-stroke-1'],
      correctionLiveStrokeDigests:[strokeDigest], correctionNewStrokeDigests:[strokeDigest],
      correctionLiveStrokes:[{ id:'receipt-stroke-1', qno:3, ...strokeGeometry,
        t0:1788048000000, t1:1788048001000, geometryDigest:strokeDigest }],
      correctionNewStrokes:[{ id:'receipt-stroke-1', qno:3, ...strokeGeometry,
        t0:1788048000000, t1:1788048001000, geometryDigest:strokeDigest }],
      issuedAt:'2026-08-30T00:00:01.000Z' };
    const committed = { ...committedCore, canonicalDigest:await capabilityCanonicalDigest(committedCore) };
    paperCorrectionCloudManifest = async () => [{ page:0,
      qid:'paper:' + paperRun.id + '-correction:v2:0', clientId:'new-client',
      revision:5, cloudSha256:'e'.repeat(64), updatedAt:'2026-08-30T00:01:00.000Z' }];
    let rpcCalls = 0, readCalls = 0;
    const query = {
      select() { return this; }, eq() { return this; },
      async limit() { readCalls++; return { data:[{ receipt:committed,
        canonical_digest:committed.canonicalDigest }], error:null }; },
    };
    supa = { rpc:async () => { rpcCalls++; return { error:new Error('payload changed after timeout') }; },
      from:() => query };
    const ref = await paperCorrectionRetryReceiptAcquire(review, 3, state);
    return { ref, rpcCalls, readCalls, pending:state.correctionRetryReceiptRequestId || null,
      stored:state.correctionRetryReceipt };
  `)));
  assert.equal(result.ref.receiptId, 'paper-correction-retry-timeout-1234567890abcdef');
  assert.match(result.ref.canonicalDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.ref.correctionLiveStrokes.length, 1);
  assert.equal(result.ref.correctionNewStrokes.length, 1);
  assert.deepEqual(result.stored, {
    receiptId:'paper-correction-retry-timeout-1234567890abcdef',
    canonicalDigest:result.ref.canonicalDigest,
  });
  assert.deepEqual({ rpcCalls:result.rpcCalls, readCalls:result.readCalls, pending:result.pending },
    { rpcCalls:1, readCalls:1, pending:null });
});
