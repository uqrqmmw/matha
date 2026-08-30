// openai-proxy 純邏輯層的行為測試（CI 以 `deno test` 執行）。
// 取代原本只用 regex 對原始碼字串斷言的做法：這裡實際執行驗證邏輯。
// 斷言自帶（不拉 jsr/@std）：零遠端依賴，CI 離線也能跑。
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`not equal:\n  actual:   ${a}\n  expected: ${b}`);
  }
}
function assertThrows(fn: () => unknown) {
  let threw = false;
  try {
    fn();
  } catch (_) {
    threw = true;
  }
  if (!threw) throw new Error("expected function to throw");
}
import {
  absoluteStorageSignedUrl,
  canonicalJson,
  canonicalSha256,
  CAPABILITY_FRESH_SOURCE_IDS,
  capabilityGoalServerEvidence,
  inspectPaperPdf,
  MAX_TEXT_CHARS,
  normalizeMessages,
  outputText,
  PAPER_AUDIT_PRIVATE_BUCKET,
  PAPER_RUNTIME_SOURCE_ASSET_VERSIONS,
  PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS,
  paperAcceptedRunReceiptMatches,
  paperCorrectionQuestionPage,
  paperCorrectionRetryReceipt,
  paperDetailGateAllows,
  paperGradeAcceptedSubmitAttempt,
  paperGradeAnswerKey,
  paperGradeServerReceipt,
  paperGradeServerSummary,
  paperGradeSourcePolicy,
  paperGradeSubmissionReadback,
  paperGradeVisualAttestation,
  paperKeyGateAllows,
  paperPdfContentBinding,
  paperPdfStoreGate,
  paperRuntimeAuditEvidence,
  paperRuntimeAuditInkReferences,
  paperRuntimeAuditLegacyReadOnlyEvidence,
  paperRuntimeAuditPdfReference,
  paperRuntimePageCount,
  paperSolutionFiles,
  paperSolutionGateAllows,
  parsePaperAnswerKeys,
  requestWeights,
  responseSchemas,
  safetyIdentifier,
  splitCsv,
  taipeiDate,
  verifyPaperGradeReceiptReadback,
  verifyPaperGradeVisualAttestationReadback,
} from "./lib.ts";

function acceptedPageManifest(
  runId: string,
  sourceId: string,
  hashes?: string[],
) {
  const pageCount = paperRuntimePageCount(sourceId);
  return Array.from({ length: pageCount }, (_, page) => ({
    page,
    qid: `paper:${runId}:v2:${page}`,
    clientId: `ink-${runId}-${page}`,
    revision: page + 1,
    cloudSha256: hashes?.[page] || "a".repeat(64),
    updatedAt: "2026-08-29T05:00:00.000Z",
  }));
}

async function modelInputFixture(
  sourceId: string,
  serverInkPages: Array<Record<string, unknown>>,
) {
  const imageOrder: Array<Record<string, unknown>> = [];
  const pageBindings = serverInkPages.map((ink, index) => {
    const page = index + 1;
    ["source-scan", "source-aligned-ink", "full-workspace-ink"].forEach((
      kind,
    ) =>
      imageOrder.push({
        ordinal: imageOrder.length + 1,
        page,
        kind,
        mediaType: "image/png",
        sha256: "1".repeat(64),
        width: 100,
        height: 100,
        side: "full",
      })
    );
    return {
      page,
      source: {
        bucket: "matha-papers",
        path: `fixture-${page}.png`,
        sha256: "2".repeat(64),
        width: 100,
        height: 100,
        side: "full",
      },
      acceptedInk: {
        revision: ink.revision,
        sha256: ink.sha256,
        liveStrokeIds: ["s1"],
        deletedIds: [],
        totalPoints: 2,
      },
      sourceAlignedOverlaySha256: "3".repeat(64),
      workspaceOverlaySha256: "4".repeat(64),
      transform: {
        sheetAspect: "2112/2535",
        crop: [.03, .025, .8, .94],
        selectedSide: "full",
      },
    };
  });
  const core = {
    promptContractVersion: "paper-grade-server-v2",
    sourceId,
    promptSha256: "f".repeat(64),
    answerKeySha256: "e".repeat(64),
    assetCatalogVersion: "paper-grade-source-catalog-v1-20260830",
    rendererVersion: "paper-ink-authority-v1-20260830",
    pageCount: serverInkPages.length,
    imageCount: imageOrder.length,
    totalImageBytes: 1000,
    dataUrlChars: 2000,
    imageOrder,
    pageBindings,
  };
  return { ...core, canonicalDigest: await canonicalSha256(core) };
}

Deno.test("paper-mock-1 有獨立練習批改 policy，但永不進正式能力來源", async () => {
  const policy = paperGradeSourcePolicy("paper-mock-1");
  assert(policy);
  assertEquals(policy.calibrationEligible, false);
  assertEquals(policy.freshnessRequired, false);
  assert(!CAPABILITY_FRESH_SOURCE_IDS.has("paper-mock-1"));
  assertEquals(policy.pageCount, 6);
  assertEquals(
    PAPER_RUNTIME_SOURCE_ASSET_VERSIONS["paper-mock-1"],
    "private-publisher-paper-mock-1-pages-2-4-20260718-v1",
  );
  assert(
    /^[a-f0-9]{64}$/.test(PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS["paper-mock-1"]),
  );
  const key = paperGradeAnswerKey("paper-mock-1", undefined);
  assert(key);
  assertEquals(key.length, 20);
  assertEquals(key.reduce((sum, item) => sum + item.points, 0), 100);
  const accepted = await paperGradeAcceptedSubmitAttempt({
    attempt_id: "paper-submit-mock1-practice-proof",
    run_id: "paper-run-1784325851509",
    source_id: "paper-mock-1",
    status: "accepted",
    remaining_ms: 1000,
    ink_snapshot_sha256: "a".repeat(64),
    submitted_at: 2_000,
    accepted_at: new Date(2_001).toISOString(),
    canceled_at: null,
    run_created_app_version: "0830b",
    run_created_at: 1_000,
    paper_layout_version: 2,
    source_page_count: 6,
    decision_reason: "accepted-first-for-run",
    winner_attempt_id: null,
    page_manifest: acceptedPageManifest(
      "paper-run-1784325851509",
      "paper-mock-1",
    ),
  });
  assert(accepted);
  assertEquals(paperGradeSourcePolicy("paper-mock-2"), null);
});

function capabilityState(
  scores: number[],
  sourceIds = [
    "paper-official-110-trial",
    "paper-official-111",
    "paper-official-112",
    "paper-official-113",
    "paper-official-114",
    "paper-official-115",
    "paper-regional-ra4109",
  ],
) {
  const paperRuns: Array<Record<string, unknown>> = [];
  const extMocks: Array<Record<string, unknown>> = [];
  scores.forEach((score, index) => {
    let remaining = score;
    const questions = Array.from({ length: 20 }, (_, questionIndex) => {
      const points = Math.min(5, remaining);
      remaining -= points;
      return {
        no: questionIndex + 1,
        status: points === 5 ? "correct" : "incorrect",
        points,
        maxPoints: 5,
      };
    });
    const submittedAt = 2_000_000 + index * 100_000;
    const runId = `paper-run-${1700000000000 + index}`;
    const sourceId = sourceIds[index];
    paperRuns.push({
      id: runId,
      sourceId,
      createdAt: submittedAt - 20_000,
      runCreatedAppVersion: "0830b",
      status: "awaiting-correction",
      calibrationEligible: true,
      freshnessConfirmedAt: submittedAt - 10_000,
      submittedAt,
      score,
      aiGrade: { score, gradedAt: submittedAt + 10_000, questions },
    });
    extMocks.push({
      paperRunId: runId,
      sourceId,
      calibrationEligible: true,
      questions: 20,
      total: 100,
      ts: submittedAt,
      freshnessConfirmedAt: submittedAt - 10_000,
      score,
    });
  });
  return { learningBaselineResetAt: 1_000_000, paperRuns, extMocks };
}

async function capabilityReceiptEnvelopes(
  state: Record<string, unknown>,
) {
  const envelopes = [];
  for (const rawRun of state.paperRuns as Array<Record<string, unknown>>) {
    const grade = rawRun.aiGrade as Record<string, unknown>;
    const questions = grade.questions as Array<Record<string, unknown>>;
    const sourceId = String(rawRun.sourceId);
    const pageCount = paperRuntimePageCount(sourceId);
    const sourceAssetVersion = PAPER_RUNTIME_SOURCE_ASSET_VERSIONS[sourceId];
    const sourceContentDigest = PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[sourceId];
    if (!pageCount || !sourceAssetVersion || !sourceContentDigest) continue;
    const submitAttemptCore = {
      authority: "supabase-immutable-paper-submit-attempt-v2",
      attemptId: `paper-submit-${String(rawRun.id).slice(-13)}-proof`,
      runId: String(rawRun.id),
      sourceId,
      status: "accepted",
      decisionReason: "accepted-first-for-run",
      remainingMs: 1_000,
      inkSnapshotSha256: "8".repeat(64),
      submittedAt: Number(rawRun.submittedAt),
      acceptedAt: new Date(Number(rawRun.submittedAt) + 1).toISOString(),
      runCreatedAppVersion: String(rawRun.runCreatedAppVersion),
      runCreatedAt: Number(rawRun.createdAt),
      paperLayoutVersion: 2,
      sourcePageCount: pageCount,
      freshnessConfirmedAt: rawRun.freshnessConfirmedAt,
      calibrationEligible: true,
      sourceAssetVersion,
      sourceContentDigest,
      pageManifest: acceptedPageManifest(
        String(rawRun.id),
        sourceId,
        Array.from({ length: pageCount }, () => "8".repeat(64)),
      ),
    };
    const submitAttempt = {
      ...submitAttemptCore,
      canonicalDigest: await canonicalSha256(submitAttemptCore),
    };
    rawRun.submitAttempt = {
      ...submitAttempt,
      acceptedAt: Number(rawRun.submittedAt) + 1,
    };
    const statusCounts: Record<string, number> = {
      correct: 0,
      incorrect: 0,
      uncertain: 0,
      unanswered: 0,
    };
    questions.forEach((row) => statusCounts[String(row.status)]++);
    const gradeSummary = {
      questionCount: 20,
      awardedPoints: grade.score,
      maxPoints: 100,
      statusCounts,
      questions,
    };
    const serverInkPages = Array.from({ length: pageCount }, (_, page) => ({
      page,
      qid: `paper:${rawRun.id}:v2:${page}`,
      clientId: `ink-${rawRun.id}-${page}`,
      sha256: "b".repeat(64),
      revision: 1,
      updatedAt: new Date(Number(rawRun.submittedAt) - 1).toISOString(),
      strokeCount: page === 0 ? 1 : 0,
      deletedCount: 0,
    }));
    const modelInputBinding = await modelInputFixture(sourceId, serverInkPages);
    const core = {
      kind: "matha-paper-grade-receipt-v1",
      schemaVersion: 1,
      authority: "supabase-edge-service-role-grade-receipt",
      runId: rawRun.id,
      sourceId,
      sourceAssetVersion,
      sourceContentDigest,
      paperLayoutVersion: 2,
      runCreatedAt: rawRun.createdAt,
      runCreatedAppVersion: rawRun.runCreatedAppVersion,
      submittedAt: rawRun.submittedAt,
      freshnessConfirmedAt: rawRun.freshnessConfirmedAt,
      calibrationEligible: true,
      submitAttempt,
      submissionContentBindingSha256: "a".repeat(64),
      serverInkPages,
      modelInputBinding,
      gradeGeneration: 0,
      gradedAt: grade.gradedAt,
      requestId: `resp_testreceipt_${String(rawRun.id).slice(-6)}`,
      model: "gpt-5.5",
      rawGradeSha256: "c".repeat(64),
      gradeSummary,
    };
    const canonicalDigest = await canonicalSha256(core);
    const path = `grade-receipts/matha_${
      "d".repeat(32)
    }/${rawRun.id}/grade-${canonicalDigest}.json`;
    const metadata = {
      authority: "supabase-service-role-storage-readback",
      bucket: PAPER_AUDIT_PRIVATE_BUCKET,
      path,
      sha256: "e".repeat(64),
      canonicalDigest,
    };
    rawRun.serverGradeReceipt = metadata;
    (rawRun.aiGrade as Record<string, unknown>).serverGradeReceipt = metadata;
    envelopes.push({
      receipt: { ...core, canonicalDigest },
      privateReadback: {
        ...metadata,
        readbackVerifiedAt: new Date(Number(grade.gradedAt) + 1).toISOString(),
      },
    });
  }
  return envelopes;
}

async function capabilityVisualAttestationEnvelopes(
  state: Record<string, unknown>,
  receipts: Array<Record<string, unknown>>,
) {
  const envelopes = [];
  for (const rawRun of state.paperRuns as Array<Record<string, unknown>>) {
    const receiptEnvelope = receipts.find((rawEnvelope) => {
      const receipt = rawEnvelope.receipt as Record<string, unknown>;
      return receipt && receipt.runId === rawRun.id;
    });
    if (!receiptEnvelope) continue;
    const receipt = receiptEnvelope.receipt as Record<string, unknown>;
    const grade = rawRun.aiGrade as Record<string, unknown>;
    const attestation = await paperGradeVisualAttestation(
      receiptEnvelope,
      rawRun,
      {
        ownerStatement:
          "I reviewed every model-input page and confirm it is this paper run",
        gradeReceiptDigest: receipt.canonicalDigest,
        modelInputBindingSha256:
          (receipt.modelInputBinding as Record<string, unknown>)
            .canonicalDigest,
        submitAttemptDigest: (receipt.submitAttempt as Record<string, unknown>)
          .canonicalDigest,
        submitAttemptId: (receipt.submitAttempt as Record<string, unknown>)
          .attemptId,
        confirmedPages: (
          (receipt.modelInputBinding as Record<string, unknown>)
            .imageOrder as Array<Record<string, unknown>>
        ).map((image) => ({
          page: image.page,
          mediaType: image.mediaType,
          sha256: image.sha256,
        })),
      },
      Number(grade.gradedAt) + 2,
    );
    assert(attestation);
    const path = `grade-visual-attestations/matha_${
      "d".repeat(32)
    }/${rawRun.id}/attestation-${attestation.canonicalDigest}.json`;
    const metadata = {
      authority: "supabase-service-role-storage-readback",
      bucket: PAPER_AUDIT_PRIVATE_BUCKET,
      path,
      sha256: "9".repeat(64),
      canonicalDigest: attestation.canonicalDigest,
      runId: rawRun.id,
      sourceId: rawRun.sourceId,
      gradeReceiptDigest: attestation.gradeReceiptDigest,
      submitAttemptDigest: attestation.submitAttemptDigest,
      submitAttemptId: attestation.submitAttemptId,
      modelInputBindingSha256: attestation.modelInputBindingSha256,
      submissionContentBindingSha256:
        attestation.submissionContentBindingSha256,
      attestedAt: attestation.attestedAt,
    };
    rawRun.gradeInputVisualAttestation = metadata;
    grade.gradeInputVisualAttestation = metadata;
    envelopes.push({
      attestation,
      privateReadback: {
        ...metadata,
        readbackVerifiedAt: new Date(Number(attestation.attestedAt) + 1)
          .toISOString(),
      },
    });
  }
  return envelopes;
}

Deno.test("能力伺服器證據以同一組六回推導最後三回，不能由兩份清單各自湊數", async () => {
  const generatedAt = 4_000_000;
  const state = capabilityState([40, 55, 60, 65, 72, 80, 90]);
  const receipts = await capabilityReceiptEnvelopes(state);
  const visualAttestations = await capabilityVisualAttestationEnvelopes(
    state,
    receipts,
  );
  const evidence = await capabilityGoalServerEvidence(
    state,
    "0830b",
    generatedAt,
    receipts,
    visualAttestations,
  );
  assert(evidence);
  const freshRuns = evidence.freshRuns as Array<Record<string, unknown>>;
  const runs = evidence.runs as Array<Record<string, unknown>>;
  assertEquals(freshRuns.length, 6);
  assertEquals(
    freshRuns.map((row) => row.runId),
    [1, 2, 3, 4, 5, 6].map((index) => `paper-run-${1700000000000 + index}`),
  );
  assertEquals(
    runs.map((row) => row.runId),
    freshRuns.slice(-3).map((row) => row.runId),
  );
  assertEquals(runs.map((row) => row.score), [72, 80, 90]);
  assertEquals(evidence.stable, true);
  assertEquals(evidence.status, "stable");
  assertEquals(evidence.blockers, []);
  const unsigned = await capabilityGoalServerEvidence(
    capabilityState([72, 73, 74, 75, 76, 77]),
    "0830b",
    generatedAt,
  );
  assert(unsigned);
  assertEquals((unsigned.freshRuns as unknown[]).length, 0);
  const receiptOnlyState = capabilityState([72, 73, 74, 75, 76, 77]);
  const receiptOnly = await capabilityReceiptEnvelopes(receiptOnlyState);
  const noOwnerVisualProof = await capabilityGoalServerEvidence(
    receiptOnlyState,
    "0830b",
    generatedAt,
    receiptOnly,
  );
  assert(noOwnerVisualProof);
  assertEquals((noOwnerVisualProof.freshRuns as unknown[]).length, 0);
  assertEquals(
    await paperGradeVisualAttestation(
      receiptOnly[0],
      (receiptOnlyState.paperRuns as Array<Record<string, unknown>>)[0],
      {},
      4_000_000,
    ),
    null,
  );
  const restamped = await capabilityGoalServerEvidence(
    state,
    "0830c",
    generatedAt,
    receipts,
    visualAttestations,
  );
  assert(restamped);
  assertEquals((restamped.freshRuns as unknown[]).length, 0);
  assertEquals(restamped.stable, false);
  const { canonicalDigest: _, ...canonicalPayload } = evidence;
  assertEquals(
    evidence.canonicalDigest,
    await canonicalSha256(canonicalPayload),
  );
});

Deno.test("本人逐頁 self-attestation 必須完整綁定 receipt、accepted submit 與每頁 model input", async () => {
  const state = capabilityState([72]);
  const receipts = await capabilityReceiptEnvelopes(state);
  const run = (state.paperRuns as Array<Record<string, unknown>>)[0];
  const envelope = receipts[0];
  const receipt = envelope.receipt as Record<string, unknown>;
  const binding = receipt.modelInputBinding as Record<string, unknown>;
  const submitAttempt = receipt.submitAttempt as Record<string, unknown>;
  const confirmation = {
    ownerStatement:
      "I reviewed every model-input page and confirm it is this paper run",
    gradeReceiptDigest: receipt.canonicalDigest,
    modelInputBindingSha256: binding.canonicalDigest,
    submitAttemptDigest: submitAttempt.canonicalDigest,
    submitAttemptId: submitAttempt.attemptId,
    confirmedPages: (binding.imageOrder as Array<Record<string, unknown>>).map(
      (image) => ({
        page: image.page,
        mediaType: image.mediaType,
        sha256: image.sha256,
      }),
    ),
  };
  assert(
    await paperGradeVisualAttestation(envelope, run, confirmation, 4_000_000),
  );
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => value.ownerStatement = "I clicked a button",
    (value) => value.gradeReceiptDigest = "0".repeat(64),
    (value) => value.modelInputBindingSha256 = "0".repeat(64),
    (value) => value.submitAttemptDigest = "0".repeat(64),
    (value) => value.submitAttemptId = "paper-submit-wrong-proof-id",
    (value) => value.confirmedPages.pop(),
    (value) => value.confirmedPages[0].page = 2,
    (value) => value.confirmedPages[0].mediaType = "image/jpeg",
    (value) => value.confirmedPages[0].sha256 = "0".repeat(64),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(confirmation);
    mutate(candidate);
    assertEquals(
      await paperGradeVisualAttestation(envelope, run, candidate, 4_000_000),
      null,
    );
  }
});

Deno.test("能力伺服器證據對非正式來源、重複來源與不可重算題分 fail closed", async () => {
  const unknown = capabilityState([72, 73, 74, 75, 76, 77]);
  (unknown.paperRuns as Array<Record<string, unknown>>)[0].sourceId =
    "paper-client-invented";
  (unknown.extMocks as Array<Record<string, unknown>>)[0].sourceId =
    "paper-client-invented";
  const unknownReceipts = await capabilityReceiptEnvelopes(unknown);
  const unknownVisuals = await capabilityVisualAttestationEnvelopes(
    unknown,
    unknownReceipts,
  );
  const unknownEvidence = await capabilityGoalServerEvidence(
    unknown,
    "0830b",
    4_000_000,
    unknownReceipts,
    unknownVisuals,
  );
  assert(unknownEvidence);
  assertEquals(
    (unknownEvidence.freshRuns as unknown[]).length,
    5,
  );
  assertEquals(unknownEvidence.stable, false);

  const duplicateSources = [
    "paper-official-110-trial",
    "paper-official-111",
    "paper-official-112",
    "paper-official-113",
    "paper-official-114",
    "paper-official-114",
  ];
  const duplicateState = capabilityState(
    [72, 73, 74, 75, 76, 77],
    duplicateSources,
  );
  const duplicateReceipts = await capabilityReceiptEnvelopes(duplicateState);
  const duplicateVisuals = await capabilityVisualAttestationEnvelopes(
    duplicateState,
    duplicateReceipts,
  );
  const duplicateEvidence = await capabilityGoalServerEvidence(
    duplicateState,
    "0830b",
    4_000_000,
    duplicateReceipts,
    duplicateVisuals,
  );
  assert(duplicateEvidence);
  assertEquals((duplicateEvidence.freshRuns as unknown[]).length, 5);

  const aliasSource = "paper-official-111";
  const originalAliasDigest = PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[aliasSource];
  try {
    PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[aliasSource] =
      PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS["paper-official-110-trial"];
    const duplicateContentState = capabilityState([72, 73, 74, 75, 76, 77]);
    const duplicateContentReceipts = await capabilityReceiptEnvelopes(
      duplicateContentState,
    );
    const duplicateContentVisuals = await capabilityVisualAttestationEnvelopes(
      duplicateContentState,
      duplicateContentReceipts,
    );
    const duplicateContentEvidence = await capabilityGoalServerEvidence(
      duplicateContentState,
      "0830b",
      4_000_000,
      duplicateContentReceipts,
      duplicateContentVisuals,
    );
    assert(duplicateContentEvidence);
    assertEquals(
      (duplicateContentEvidence.freshRuns as unknown[]).length,
      5,
    );
  } finally {
    PAPER_RUNTIME_SOURCE_CONTENT_DIGESTS[aliasSource] = originalAliasDigest;
  }

  const badGrade = capabilityState([72, 73, 74, 75, 76, 77]);
  const badReceipts = await capabilityReceiptEnvelopes(badGrade);
  const badVisuals = await capabilityVisualAttestationEnvelopes(
    badGrade,
    badReceipts,
  );
  const badRun = (badGrade.paperRuns as Array<Record<string, unknown>>)[5];
  const grade = badRun.aiGrade as Record<string, unknown>;
  (grade.questions as Array<Record<string, unknown>>)[0].points = 4;
  const badEvidence = await capabilityGoalServerEvidence(
    badGrade,
    "0830b",
    4_000_000,
    badReceipts,
    badVisuals,
  );
  assert(badEvidence);
  assertEquals((badEvidence.freshRuns as unknown[]).length, 5);
  assertEquals(badEvidence.stable, false);
});

Deno.test("splitCsv 去空白、去空項", () => {
  assertEquals([...splitCsv(" a@x.io , ,b@x.io,")], ["a@x.io", "b@x.io"]);
  assertEquals(splitCsv(undefined).size, 0);
});

Deno.test("整卷批改權重最高；未知類型無權重（index.ts 呼叫端以 || 1 補預設）", () => {
  assert(requestWeights.paper_grade === 12);
  assert(requestWeights.paper_detail === 5);
  assert(requestWeights.paper_correction_grade === 3);
  for (const weight of Object.values(requestWeights)) {
    assert(
      Number.isInteger(weight) && weight >= 1 && weight <= 20,
      "權重須落在 claim_ai_request 的 1–20 夾擠範圍",
    );
  }
  assertEquals(requestWeights["nonsense"], undefined);
});

Deno.test("normalizeMessages：合法文字與圖片轉成 Responses 格式", () => {
  const out = normalizeMessages([
    { role: "user", content: "hi" },
    {
      role: "user",
      content: [
        { type: "text", text: "看這張" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGk=" },
        },
      ],
    },
  ]);
  assertEquals(out[0], { role: "user", content: "hi" });
  const parts = out[1].content as Array<Record<string, unknown>>;
  assertEquals(parts[0], { type: "input_text", text: "看這張" });
  assertEquals(parts[1].type, "input_image");
  assertEquals(parts[1].detail, "original");
  assert(String(parts[1].image_url).startsWith("data:image/png;base64,"));
});

Deno.test("normalizeMessages：拒絕壞 role、壞圖片、超量圖片與超長文字", () => {
  assertThrows(() => normalizeMessages([]));
  assertThrows(() => normalizeMessages([{ role: "system", content: "x" }]));
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "url", media_type: "image/png", data: "x" },
      }],
    }])
  );
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/svg+xml", data: "x" },
      }],
    }])
  );
  const nineImages = Array.from({ length: 9 }, () => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGk=" },
  }));
  assertThrows(() =>
    normalizeMessages([{ role: "user", content: nineImages }])
  );
  assertThrows(() =>
    normalizeMessages([{
      role: "user",
      content: "x".repeat(MAX_TEXT_CHARS + 1),
    }])
  );
});

Deno.test("outputText：串接 output_text、遇 refusal 直接丟錯", () => {
  assertEquals(
    outputText({
      output: [{
        type: "message",
        content: [
          { type: "output_text", text: "A" },
          { type: "output_text", text: "B" },
        ],
      }],
    }),
    "AB",
  );
  assertThrows(() =>
    outputText({
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    })
  );
  assertEquals(outputText({}), "");
});

const gateData = (due: string, state: Record<string, unknown> | undefined) => ({
  paperRuns: [{ id: "run-1", due, review: state ? { "3": state } : {} }],
});

Deno.test("paper_detail 解鎖：隔日且至少一次真實重想已保存", () => {
  assert(
    paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      3,
      "2026-07-18",
    ),
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-18", { attempts: 0, logs: [] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "空白訂正狀態不能解鎖",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-18", { attempts: 1, logs: [] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "只有計數、沒有 retry log 不能解鎖",
  );
});

Deno.test("paper_detail 解鎖：未到期、題目狀態或 run 不存在、題號超界都擋", () => {
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-19", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      3,
      "2026-07-18",
    ),
    "還沒到隔天",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", undefined),
      "run-1",
      3,
      "2026-07-18",
    ),
    "沒有該題訂正狀態",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-2",
      3,
      "2026-07-18",
    ),
    "run 不存在",
  );
  assert(
    !paperDetailGateAllows(
      gateData("2026-07-17", { attempts: 1, logs: [{ kind: "retry" }] }),
      "run-1",
      21,
      "2026-07-18",
    ),
    "題號超界",
  );
  assert(!paperDetailGateAllows(undefined, "run-1", 3, "2026-07-18"));
});

Deno.test("paper_key 偽造 app_state 仍鎖定；immutable accepted 同回收據才開放", () => {
  const runId = "paper-run-1784325851510";
  const accepted = {
    authority: "supabase-immutable-paper-submit-attempt-v2",
    attemptId: "paper-submit-key-gate-proof-0001",
    runId,
    sourceId: "paper-mock-3",
    status: "accepted",
    decisionReason: "accepted-first-for-run",
    remainingMs: 1000,
    inkSnapshotSha256: "a".repeat(64),
    submittedAt: 123,
    acceptedAt: "2026-08-29T05:00:00.000Z",
    runCreatedAppVersion: "0830b",
    runCreatedAt: 1_000,
    paperLayoutVersion: 2,
    sourcePageCount: 4,
  };
  const data = {
    paperRuns: [{
      id: runId,
      sourceId: "paper-mock-3",
      status: "grading",
      submittedAt: 123,
      submitAttempt: {
        attemptId: accepted.attemptId,
        status: "accepted",
        decisionReason: "accepted-first-for-run",
        inkSnapshotSha256: accepted.inkSnapshotSha256,
        submittedAt: accepted.submittedAt,
        runCreatedAppVersion: accepted.runCreatedAppVersion,
      },
    }],
  };
  assert(!paperKeyGateAllows(data, runId, "paper-mock-3", null));
  assert(paperAcceptedRunReceiptMatches(data, runId, "paper-mock-3", accepted));
  assert(paperKeyGateAllows(data, runId, "paper-mock-3", accepted));
  assert(!paperKeyGateAllows(data, runId, "paper-mock-2", accepted));
  assert(!paperKeyGateAllows(data, "missing", "paper-mock-3", accepted));
  assert(
    !paperKeyGateAllows(
      { paperRuns: [{ ...data.paperRuns[0], status: "active" }] },
      runId,
      "paper-mock-3",
      accepted,
    ),
  );
  assert(
    !paperKeyGateAllows(
      { paperRuns: [{ ...data.paperRuns[0], submittedAt: 0 }] },
      runId,
      "paper-mock-3",
      accepted,
    ),
  );
});

Deno.test("隔日訂正 receipt 綁定伺服器題號頁碼，別頁筆跡不可開鎖", async () => {
  const runId = "paper-run-1784325851511";
  const sourceId = "paper-mock-1";
  const questionNo = 3;
  const page = paperCorrectionQuestionPage(sourceId, questionNo);
  const strokeGeometry = {
    pts: [[0.1, 0.2, 0.5], [0.25, 0.35, 0.7]],
    c: "blue",
    w: 1.25,
  };
  const strokeDigest = await canonicalSha256(strokeGeometry);
  assertEquals(page, 0);
  assertEquals(paperCorrectionQuestionPage("paper-official-114", 3), 1);
  const core = {
    authority: "supabase-immutable-paper-correction-retry-v1",
    receiptId: "paper-correction-retry-proof-0000000001",
    runId,
    sourceId,
    questionNo,
    acceptedAttemptId: "paper-submit-correction-proof-0001",
    acceptedInkSnapshotSha256: "a".repeat(64),
    acceptedPageManifestSha256: "b".repeat(64),
    correctionPageManifest: [{
      page,
      qid: `paper:${runId}-correction:v2:${page}`,
      clientId: "correction-device-proof",
      revision: 7,
      cloudSha256: "c".repeat(64),
      updatedAt: "2026-08-30T05:00:00.000Z",
      serverUpdatedAt: "2026-08-30T05:00:00.500Z",
    }],
    correctionLiveStrokeIds: ["stroke-proof-1"],
    correctionNewStrokeIds: ["stroke-proof-1"],
    correctionLiveStrokeDigests: [strokeDigest],
    correctionNewStrokeDigests: [strokeDigest],
    correctionLiveStrokes: [{
      id: "stroke-proof-1",
      qno: questionNo,
      ...strokeGeometry,
      t0: 1788066000000,
      t1: 1788066001500,
      geometryDigest: strokeDigest,
    }],
    correctionNewStrokes: [{
      id: "stroke-proof-1",
      qno: questionNo,
      ...strokeGeometry,
      t0: 1788066000000,
      t1: 1788066001500,
      geometryDigest: strokeDigest,
    }],
    issuedAt: "2026-08-30T05:00:01.000Z",
  };
  const digest = await canonicalSha256(core);
  const receipt = { ...core, canonicalDigest: digest };
  assert(
    await paperCorrectionRetryReceipt({
      receipt,
      canonical_digest: digest,
    }),
  );

  const wrongPageCore = structuredClone(core);
  wrongPageCore.correctionPageManifest[0].page = 1;
  wrongPageCore.correctionPageManifest[0].qid =
    `paper:${runId}-correction:v2:1`;
  const wrongDigest = await canonicalSha256(wrongPageCore);
  assertEquals(
    await paperCorrectionRetryReceipt({
      receipt: { ...wrongPageCore, canonicalDigest: wrongDigest },
      canonical_digest: wrongDigest,
    }),
    null,
  );

  const wrongQuestionStrokeCore = structuredClone(core);
  wrongQuestionStrokeCore.correctionNewStrokes[0].qno = questionNo + 1;
  const wrongQuestionStrokeDigest = await canonicalSha256(
    wrongQuestionStrokeCore,
  );
  assertEquals(
    await paperCorrectionRetryReceipt({
      receipt: {
        ...wrongQuestionStrokeCore,
        canonicalDigest: wrongQuestionStrokeDigest,
      },
      canonical_digest: wrongQuestionStrokeDigest,
    }),
    null,
  );

  // Even a self-consistent outer receipt digest cannot bless geometry changed
  // after issuance: the per-stroke server geometry digest remains immutable.
  const mutatedGeometryCore = structuredClone(core);
  mutatedGeometryCore.correctionNewStrokes[0].pts[1][0] = 0.75;
  const mutatedGeometryDigest = await canonicalSha256(mutatedGeometryCore);
  assertEquals(
    await paperCorrectionRetryReceipt({
      receipt: {
        ...mutatedGeometryCore,
        canonicalDigest: mutatedGeometryDigest,
      },
      canonical_digest: mutatedGeometryDigest,
    }),
    null,
  );

  const mutatedLiveCore = structuredClone(core);
  mutatedLiveCore.correctionLiveStrokes[0].pts[0][1] = 0.9;
  const mutatedLiveDigest = await canonicalSha256(mutatedLiveCore);
  assertEquals(
    await paperCorrectionRetryReceipt({
      receipt: { ...mutatedLiveCore, canonicalDigest: mutatedLiveDigest },
      canonical_digest: mutatedLiveDigest,
    }),
    null,
  );

  const deletedLiveCore = structuredClone(core);
  deletedLiveCore.correctionLiveStrokes = [];
  const deletedLiveDigest = await canonicalSha256(deletedLiveCore);
  assertEquals(
    await paperCorrectionRetryReceipt({
      receipt: { ...deletedLiveCore, canonicalDigest: deletedLiveDigest },
      canonical_digest: deletedLiveDigest,
    }),
    null,
  );
});

Deno.test("真機驗收 v2 必須通過服務端筆跡讀回、真當機、全頁滑動與實體 PDF metadata", async () => {
  const runId = "paper-run-1234567890123";
  const inkRows: Array<Record<string, unknown>> = [];
  const pages = [];
  for (let page = 0; page < 4; page++) {
    const clientId = "ink-paper-" + runId + "-" + page + "-device-1";
    const qid = "paper:" + runId + ":v2:" + page;
    const strokes = {
      paper: true,
      revision: page + 1,
      s: page === 0 ? [{ id: "stroke-1", pts: [[0.1, 0.2], [0.2, 0.3]] }] : [],
      deleted: [],
    };
    const sha256 = await canonicalSha256(strokes);
    pages.push({
      page,
      qid,
      clientId,
      revision: page + 1,
      updatedAt: "2026-08-29T05:00:00.000Z",
      localSha256: sha256,
      cloudSha256: sha256,
      matched: true,
    });
    inkRows.push({
      client_id: clientId,
      qid,
      t0: 100 + page,
      proc: {
        overlay: true,
        mode: "paper-source",
        page,
        revision: page + 1,
      },
      strokes,
      created_at: "2026-08-29T04:00:00.000Z",
      updated_at: "2026-08-29T05:00:00.000Z",
    });
  }
  const run: any = {
    id: runId,
    sourceId: "paper-mock-3",
    paperLayoutVersion: 2,
    createdAt: 100,
    runCreatedAppVersion: "0830b",
    submittedAt: 2_000,
    status: "awaiting-correction",
    d: "2026-08-29",
    calibrationEligible: true,
    freshnessConfirmedAt: 123,
    aiGrade: {
      model: "gpt-5.5",
      requestId: "resp_runtime_test",
      promptVersion: "paper-grade-first-pass-v3",
      gradedAt: 3_500,
      score: 100,
      questions: Array.from({ length: 20 }, (_, index) => ({
        no: index + 1,
        status: "correct",
        points: 5,
        maxPoints: 5,
      })),
    },
    runtimeAudit: {
      schema: 2,
      appVersion: "0830b",
      runId,
      sourceId: "paper-mock-3",
      createdAt: 100,
      startedAt: 200,
      submittedAt: 2_000,
      activeElapsedMs: 6_000_000,
      sessions: 2,
      crashRecoveries: 1,
      recoveryEvents: [{
        checkpointUpdatedAt: 1_000,
        recoveredAt: 1_500,
        sourceId: "paper-mock-3",
        page: 2,
        remainingMs: 3_000_000,
        inkVerified: true,
        checkpointInkSha256: "b".repeat(64),
        recoveredInkSha256: "b".repeat(64),
        pageCount: 4,
        strokeCount: 20,
        deletedCount: 1,
      }],
      strokesCommitted: 20,
      initialPage: 0,
      visitedPages: [0, 1, 2, 3],
      pageSwitches: [
        { at: 1, from: 0, to: 1, method: "swipe", ms: 120, painted: true },
        { at: 2, from: 1, to: 2, method: "swipe", ms: 180, painted: true },
        { at: 3, from: 2, to: 3, method: "swipe", ms: 220, painted: true },
      ],
      localSaveMs: [120, 180],
      localSaveFailures: 0,
      localSaveFailureIds: [],
      pendingAtSubmit: 0,
      submitDurability: {
        journalDrained: true,
        allPagesPersisted: true,
        cloudFlushed: true,
        revisionsUnchanged: true,
        pendingAtSubmit: 0,
        readbackVerifiedAt: 3_000,
        expectedPages: 4,
        verifiedPages: 4,
        pages,
      },
      maxSingleCanvasPixels: 10_000_000,
      maxLiveCanvasCount: 3,
      pdfArtifact: {
        format: "application/pdf",
        magic: "%PDF-",
        eof: "%%EOF",
        sha256: "a".repeat(64),
        bytes: 40_000,
        pageCount: 4,
        kind: "graded",
        generatedAt: 4_000,
        storageVerified: true,
        bucket: PAPER_AUDIT_PRIVATE_BUCKET,
        path: "",
        serverVerifiedAt: "2026-08-29T06:00:00.000Z",
      },
      device: {
        userAgent: "Mozilla/5.0 (Linux; Android 14)",
        platform: "Linux armv8l",
        screenWidth: 1315,
        screenHeight: 821,
        dpr: 2,
      },
      deviceAttestation: {
        confirmed: true,
        model: "Samsung Galaxy Tab S10 Ultra",
        source: "user-confirmation",
        confirmedAt: "2026-08-29T04:00:00.000Z",
        browserReportedModel: "SM-X920",
      },
    },
  };
  const state = { paperRuns: [run] };

  const receiptRun = structuredClone(run);
  receiptRun.status = "grading";
  const receiptState = { paperRuns: [receiptRun] };
  const acceptedManifest = pages.map((page) => ({
    page: Number(page.page),
    qid: String(page.qid),
    clientId: String(page.clientId),
    revision: Number(page.revision),
    cloudSha256: String(page.cloudSha256),
    updatedAt: String(page.updatedAt),
  }));
  const submissionReadback = await paperGradeSubmissionReadback(
    receiptState,
    runId,
    inkRows,
    acceptedManifest,
  );
  assert(submissionReadback);
  const acceptedInkSnapshotSha256 = submissionReadback.inkSnapshotSha256;
  const acceptedSubmitAttempt = {
    attempt_id: "paper-submit-grade-receipt-proof",
    run_id: runId,
    source_id: "paper-mock-3",
    status: "accepted",
    remaining_ms: 1_000,
    ink_snapshot_sha256: acceptedInkSnapshotSha256,
    submitted_at: 2_000,
    accepted_at: new Date(2_001).toISOString(),
    canceled_at: null,
    run_created_app_version: "0830b",
    run_created_at: 100,
    freshness_confirmed_at: 1_500,
    paper_layout_version: 2,
    source_page_count: 4,
    decision_reason: "accepted-first-for-run",
    winner_attempt_id: null,
    page_manifest: acceptedManifest,
  };
  receiptRun.submitAttempt = {
    attemptId: acceptedSubmitAttempt.attempt_id,
    runId,
    sourceId: "paper-mock-3",
    status: "accepted",
    remainingMs: 1_000,
    inkSnapshotSha256: acceptedInkSnapshotSha256,
    submittedAt: 2_000,
    acceptedAt: 2_001,
    runCreatedAppVersion: "0830b",
    decisionReason: "accepted-first-for-run",
    winnerAttemptId: "",
    pageManifest: acceptedManifest,
  };
  const answerKey = Array.from({ length: 20 }, () => ({
    type: "single" as const,
    ans: [0],
    points: 5,
  }));
  const rawGrade = {
    questions: Array.from({ length: 20 }, (_, index) => ({
      no: index + 1,
      status: "correct",
      hasFinalAnswer: true,
      finalAnswer: "",
      selectedOptions: [1],
      points: 5,
    })),
  };
  const serverSummary = paperGradeServerSummary(rawGrade, answerKey);
  assert(serverSummary);
  assertEquals(serverSummary.awardedPoints, 100);
  const modelInputBinding = await modelInputFixture(
    "paper-mock-3",
    submissionReadback.serverInkPages,
  );
  const receipt = await paperGradeServerReceipt(
    receiptState,
    {
      paperRunId: runId,
      sourceId: "paper-mock-3",
      runCreatedAt: 100,
      runCreatedAppVersion: "0830b",
      submittedAt: 2_000,
      paperLayoutVersion: 2,
      submitAttemptId: acceptedSubmitAttempt.attempt_id,
      submitAttemptInkSnapshotSha256: acceptedInkSnapshotSha256,
    },
    rawGrade,
    answerKey,
    inkRows,
    acceptedSubmitAttempt,
    modelInputBinding,
    "resp_grade_receipt_12345",
    "gpt-5.5",
    4_000,
  );
  assert(receipt);
  const withoutMutableAppState = await paperGradeServerReceipt(
    { paperRuns: [] },
    {
      paperRunId: runId,
      sourceId: "paper-mock-3",
      runCreatedAt: 100,
      runCreatedAppVersion: "0830b",
      submittedAt: 2_000,
      paperLayoutVersion: 2,
      submitAttemptId: acceptedSubmitAttempt.attempt_id,
      submitAttemptInkSnapshotSha256: acceptedInkSnapshotSha256,
    },
    rawGrade,
    answerKey,
    inkRows,
    acceptedSubmitAttempt,
    modelInputBinding,
    "resp_grade_receipt_12345",
    "gpt-5.5",
    4_000,
  );
  assert(withoutMutableAppState);
  assertEquals(withoutMutableAppState.canonicalDigest, receipt.canonicalDigest);
  const mutatedRows = structuredClone(inkRows);
  const mutatedStrokes = mutatedRows[0].strokes as Record<string, unknown>;
  (mutatedStrokes.s as unknown[]).push({
    id: "post-accepted-stroke",
    pts: [[0.3, 0.4], [0.4, 0.5]],
  });
  const mutatedSha256 = await canonicalSha256(mutatedStrokes);
  const mutatedState = structuredClone(receiptState);
  const mutatedPages = (mutatedState.paperRuns[0] as any).runtimeAudit
    .submitDurability.pages;
  mutatedPages[0].localSha256 = mutatedSha256;
  mutatedPages[0].cloudSha256 = mutatedSha256;
  assertEquals(
    await paperGradeServerReceipt(
      mutatedState,
      {
        paperRunId: runId,
        sourceId: "paper-mock-3",
        runCreatedAt: 100,
        runCreatedAppVersion: "0830b",
        submittedAt: 2_000,
        paperLayoutVersion: 2,
        submitAttemptId: acceptedSubmitAttempt.attempt_id,
        submitAttemptInkSnapshotSha256: acceptedInkSnapshotSha256,
      },
      rawGrade,
      answerKey,
      mutatedRows,
      acceptedSubmitAttempt,
      modelInputBinding,
      "resp_grade_receipt_12345",
      "gpt-5.5",
      4_000,
    ),
    null,
  );
  const receiptPath = `grade-receipts/matha_${
    "3".repeat(32)
  }/${runId}/grade-${receipt.canonicalDigest}.json`;
  assert(
    await verifyPaperGradeReceiptReadback({
      receipt,
      privateReadback: {
        authority: "supabase-service-role-storage-readback",
        bucket: PAPER_AUDIT_PRIVATE_BUCKET,
        path: receiptPath,
        sha256: "4".repeat(64),
        canonicalDigest: receipt.canonicalDigest,
        readbackVerifiedAt: new Date(4_001).toISOString(),
      },
    }),
  );
  assertEquals(
    await paperGradeServerReceipt(
      { paperRuns: [{ ...receiptRun, runCreatedAppVersion: "0829z" }] },
      {
        paperRunId: runId,
        sourceId: "paper-mock-3",
        runCreatedAt: 100,
        runCreatedAppVersion: "0829z",
        submittedAt: 2_000,
        paperLayoutVersion: 2,
        submitAttemptId: acceptedSubmitAttempt.attempt_id,
        submitAttemptInkSnapshotSha256: acceptedInkSnapshotSha256,
      },
      rawGrade,
      answerKey,
      inkRows,
      { ...acceptedSubmitAttempt, run_created_app_version: "0829z" },
      modelInputBinding,
      "resp_grade_receipt_12345",
      "gpt-5.5",
      4_000,
    ),
    null,
  );
  const binding = await paperPdfContentBinding(state, runId, "graded");
  assert(binding);
  Object.assign(run.runtimeAudit.pdfArtifact, {
    contentBindingVersion: binding.schemaVersion,
    contentBindingSha256: binding.contentBindingSha256,
    sourceAssetVersion: binding.sourceAssetVersion,
    gradeBindingSha256: binding.gradeBindingSha256,
    path: "runtime-audits/matha_" + "b".repeat(32) + "/pdf/" + runId +
      "/graded-" + binding.contentBindingSha256 + "-" + "a".repeat(64) +
      ".pdf",
  });
  run.runtimeAudit.pdfPixelQa = {
    confirmed: true,
    source: "owner-visual-review",
    reviewer: "authenticated-owner",
    pdfSha256: "a".repeat(64),
    contentBindingSha256: binding.contentBindingSha256,
    confirmedAt: "2026-08-29T07:00:00.000Z",
  };
  const refs = paperRuntimeAuditInkReferences(state, runId);
  assert(refs);
  assertEquals(refs.references.length, 4);
  const serverPdf = {
    ...run.runtimeAudit.pdfArtifact,
    storageVerified: true,
  };
  const evidence = await paperRuntimeAuditEvidence(
    state,
    runId,
    inkRows,
    serverPdf,
  );
  assert(evidence);
  assertEquals(evidence.kind, "matha-paper-runtime-audit-v2");
  assertEquals(evidence.summary.passed, true);
  assertEquals(evidence.summary.pageP95Ms, 220);
  assertEquals(evidence.inkReadback.verifiedPages, 4);
  assertEquals(evidence.inkReadback.pages[0].matched, true);
  assertEquals("unrelatedPrivateState" in evidence, false);

  const legacy = structuredClone(run);
  legacy.runtimeAudit.schema = 1;
  legacy.runtimeAudit.pendingAtSubmit = 0;
  legacy.runtimeAudit.pdfPreparedAt = 4_000;
  assert(
    paperRuntimeAuditLegacyReadOnlyEvidence({ paperRuns: [legacy] }, runId),
    "既有 v1 檔仍可唯讀解析",
  );
  assertEquals(
    await paperRuntimeAuditEvidence(
      { paperRuns: [legacy] },
      runId,
      inkRows,
      serverPdf,
    ),
    null,
  );

  const rejectedMutations: Array<[string, (value: any) => void]> = [
    ["舊 v1 只讀相容但不能新封存", (value) => value.runtimeAudit.schema = 1],
    [
      "未滿 100 分鐘",
      (value) => value.runtimeAudit.activeElapsedMs = 5_998_999,
    ],
    ["沒有實際筆畫", (value) => value.runtimeAudit.strokesCommitted = 0],
    ["沒有真當機恢復", (value) => value.runtimeAudit.crashRecoveries = 0],
    ["只重新開啟兩次不能冒充當機", (value) => {
      value.runtimeAudit.sessions = 3;
      value.runtimeAudit.crashRecoveries = 0;
    }],
    ["恢復事件沒有 checkpoint 綁定", (value) => {
      value.runtimeAudit.recoveryEvents[0].checkpointUpdatedAt = 0;
    }],
    ["有頁面沒造訪", (value) => value.runtimeAudit.visitedPages = [0, 1, 2]],
    ["沒有足夠滑動翻頁", (value) => {
      value.runtimeAudit.pageSwitches[0].method = "button";
    }],
    [
      "滑動翻頁 P95 過慢",
      (value) => value.runtimeAudit.pageSwitches[2].ms = 800,
    ],
    ["翻頁尚未 paint 完成", (value) => {
      value.runtimeAudit.pageSwitches[1].painted = false;
    }],
    ["本機保存過慢", (value) => value.runtimeAudit.localSaveMs[1] = 2_001],
    ["本機保存失敗", (value) => value.runtimeAudit.localSaveFailures = 1],
    ["journal 未 drain", (value) => {
      value.runtimeAudit.submitDurability.journalDrained = false;
    }],
    ["雲端未 flush", (value) => {
      value.runtimeAudit.submitDurability.cloudFlushed = false;
    }],
    ["交卷仍有待保存", (value) => {
      value.runtimeAudit.submitDurability.pendingAtSubmit = 1;
    }],
    ["讀回早於交卷", (value) => {
      value.runtimeAudit.submitDurability.readbackVerifiedAt = 1_999;
    }],
    ["Canvas 過大", (value) => {
      value.runtimeAudit.maxSingleCanvasPixels = 12_000_001;
    }],
    ["同時 Canvas 過多", (value) => value.runtimeAudit.maxLiveCanvasCount = 4],
    ["PDF 只有時間戳不算 artifact", (value) => {
      delete value.runtimeAudit.pdfArtifact;
      value.runtimeAudit.pdfPreparedAt = 4_000;
    }],
    ["PDF hash 不合法", (value) => {
      value.runtimeAudit.pdfArtifact.sha256 = "not-a-hash";
    }],
    ["PDF 頁數不完整", (value) => {
      value.runtimeAudit.pdfArtifact.pageCount = 3;
    }],
    ["PDF 內容綁定漂移", (value) => {
      value.runtimeAudit.pdfArtifact.contentBindingSha256 = "c".repeat(64);
    }],
    ["沒有本人逐頁像素核對", (value) => {
      delete value.runtimeAudit.pdfPixelQa;
    }],
    ["像素核對綁到別份 PDF", (value) => {
      value.runtimeAudit.pdfPixelQa.pdfSha256 = "c".repeat(64);
    }],
    ["不是校準 run", (value) => value.calibrationEligible = false],
    ["未交卷", (value) => value.status = "active"],
    ["不是 Android", (value) => {
      value.runtimeAudit.device.userAgent = "Windows";
    }],
    ["型號不符", (value) => {
      value.runtimeAudit.deviceAttestation.browserReportedModel = "SM-T000";
    }],
    ["不是本人確認", (value) => {
      value.runtimeAudit.deviceAttestation.source = "agent-claim";
    }],
  ];
  for (const [label, mutate] of rejectedMutations) {
    const candidate = structuredClone(run);
    mutate(candidate);
    assert(
      await paperRuntimeAuditEvidence(
        { paperRuns: [candidate] },
        runId,
        inkRows,
        serverPdf,
      ) === null,
      label,
    );
  }

  const alteredRows = structuredClone(inkRows);
  (alteredRows[0].strokes as any).s.push({ id: "server-only-change" });
  assertEquals(
    await paperRuntimeAuditEvidence(state, runId, alteredRows, serverPdf),
    null,
  );
  assertEquals(
    await paperRuntimeAuditEvidence(state, runId, inkRows.slice(1), serverPdf),
    null,
  );
  assertEquals(
    await paperRuntimeAuditEvidence(state, runId, inkRows),
    null,
  );
  assertEquals(
    await paperRuntimeAuditEvidence(state, runId, inkRows, {
      ...serverPdf,
      sha256: "c".repeat(64),
    }),
    null,
  );
});

Deno.test("正式 PDF 解析與私有路徑綁定皆 fail-closed", async () => {
  const page = "1 0 obj\n<< /Type /Page >>\nendobj\n";
  const text = "%PDF-1.4\n2 0 obj\n<< /Type /Pages >>\nendobj\n" +
    page.repeat(4) + "%" + "x".repeat(1100) + "\n%%EOF\n";
  const bytes = new TextEncoder().encode(text);
  const inspected = await inspectPaperPdf(bytes);
  assert(inspected);
  assertEquals(inspected.pageCount, 4);
  assertEquals(
    await inspectPaperPdf(new TextEncoder().encode(text.slice(1))),
    null,
  );
  assertEquals(
    await inspectPaperPdf(new TextEncoder().encode(text + "trailing")),
    null,
  );

  const runId = "paper-run-1760000000000";
  const userHash = "matha_" + "b".repeat(32);
  const run: any = {
    id: runId,
    sourceId: "paper-mock-3",
    paperLayoutVersion: 2,
    createdAt: 50,
    submittedAt: 100,
    status: "awaiting-correction",
    runtimeAudit: {
      schema: 2,
      appVersion: "0830b",
      runId,
      sourceId: "paper-mock-3",
      submittedAt: 100,
      pendingAtSubmit: 0,
      submitDurability: {
        journalDrained: true,
        allPagesPersisted: true,
        cloudFlushed: true,
        revisionsUnchanged: true,
        pendingAtSubmit: 0,
        readbackVerifiedAt: 150,
        expectedPages: 4,
        verifiedPages: 4,
        pages: Array.from({ length: 4 }, (_, page) => ({
          page,
          qid: `paper:${runId}:v2:${page}`,
          clientId: `ink-paper-${runId}-${page}-device-1`,
          localSha256: "c".repeat(64),
          cloudSha256: "c".repeat(64),
          matched: true,
        })),
      },
      pdfArtifact: {
        ...inspected,
        kind: "answer",
        generatedAt: 200,
        storageVerified: true,
        bucket: PAPER_AUDIT_PRIVATE_BUCKET,
        path: "",
        serverVerifiedAt: "2026-08-29T06:00:00.000Z",
      },
    },
  };
  const state = { paperRuns: [run] };
  const binding = await paperPdfContentBinding(state, runId, "answer");
  assert(binding);
  Object.assign(run.runtimeAudit.pdfArtifact, {
    contentBindingVersion: binding.schemaVersion,
    contentBindingSha256: binding.contentBindingSha256,
    sourceAssetVersion: binding.sourceAssetVersion,
    gradeBindingSha256: null,
    path: "runtime-audits/" + userHash + "/pdf/" + runId + "/answer-" +
      binding.contentBindingSha256 + "-" + inspected.sha256 + ".pdf",
  });
  assert(paperPdfStoreGate(state, runId, "answer"));
  assert(await paperRuntimeAuditPdfReference(state, runId, userHash));
  const wrongPath = structuredClone(run);
  wrongPath.runtimeAudit.pdfArtifact.path = "runtime-audits/other/file.pdf";
  assertEquals(
    await paperRuntimeAuditPdfReference(
      { paperRuns: [wrongPath] },
      runId,
      userHash,
    ),
    null,
  );
  const notSubmitted = structuredClone(run);
  notSubmitted.submittedAt = 0;
  assertEquals(
    paperPdfStoreGate({ paperRuns: [notSubmitted] }, runId, "graded"),
    null,
  );
  const noGrade = structuredClone(run);
  assertEquals(
    paperPdfStoreGate({ paperRuns: [noGrade] }, runId, "graded"),
    null,
  );
});

Deno.test("真機 snapshot canonical hash 不受 JSON object key 次序影響", async () => {
  assertEquals(
    canonicalJson({ b: 2, a: [3, { z: 1, y: 0 }] }),
    '{"a":[3,{"y":0,"z":1}],"b":2}',
  );
  assertEquals(
    await canonicalSha256({ b: 2, a: 1 }),
    await canonicalSha256({ a: 1, b: 2 }),
  );
});

Deno.test("paper_solution 只接受同一來源且已完成隔日重想的題", () => {
  const state = gateData("2026-07-17", {
    attempts: 1,
    logs: [{ kind: "retry", direction: "先重畫圖再建式" }],
  });
  const runs = state.paperRuns as Array<Record<string, unknown>>;
  runs[0].sourceId = "paper-mock-1";
  assert(
    paperSolutionGateAllows(
      state,
      "run-1",
      "paper-mock-1",
      3,
      "2026-07-18",
    ),
  );
  assert(
    !paperSolutionGateAllows(
      state,
      "run-1",
      "paper-mock-2",
      3,
      "2026-07-18",
    ),
  );
  assertEquals(paperSolutionFiles("paper-mock-1", 12), [
    "paper-mock-1/q12-a.png",
    "paper-mock-1/q12-b.png",
  ]);
  assertEquals(paperSolutionFiles("paper-mock-1", 10), []);
  assertEquals(paperSolutionFiles("../paper-mock-1", 12), []);
  assertEquals(paperSolutionFiles("paper-official-110-trial", 1), [
    "paper-official-110-trial/page-01-c7d733fea66b.png",
  ]);
  assertEquals(paperSolutionFiles("paper-official-110-trial", 20), [
    "paper-official-110-trial/page-07-081146b891af.png",
    "paper-official-110-trial/page-08-4ab3b0649c85.png",
  ]);
  assertEquals(paperSolutionFiles("paper-regional-ra4109", 7), [
    "paper-regional-ra4109/solution-page-01-7efbca7b2c8d.png",
    "paper-regional-ra4109/solution-page-02-01b2aa5a2a31.png",
  ]);
  assertEquals(paperSolutionFiles("paper-regional-ra1103", 20), [
    "paper-regional-ra1103/solution-page-02-ddac60812621.png",
  ]);
  assertEquals(
    absoluteStorageSignedUrl(
      "https://example.supabase.co",
      "/object/sign/matha-solutions/q.png?token=x",
    ),
    "https://example.supabase.co/storage/v1/object/sign/matha-solutions/q.png?token=x",
  );
  assertThrows(() =>
    absoluteStorageSignedUrl(
      "https://example.supabase.co",
      "//evil.example/q.png",
    )
  );
});

Deno.test("PAPER_ANSWER_KEYS_JSON 嚴格驗證題型、答案與配分", () => {
  const parsed = parsePaperAnswerKeys(JSON.stringify({
    "paper-mock-3": [
      { type: "single", ans: [3], points: 5 },
      { type: "fill", ans: ["13/6"], display: "13/6", points: 5 },
      {
        type: "constructed",
        ans: ["體積 10；最遠距離 √94"],
        display: "體積 10；最遠距離 √94",
        points: 8,
        rubric: [
          { label: "求出體積" },
          { label: "比較各頂點距離" },
        ],
      },
    ],
  }));
  assertEquals(parsed["paper-mock-3"][0].ans, [3]);
  assertEquals(parsed["paper-mock-3"][1].display, "13/6");
  assertEquals(parsed["paper-mock-3"][2].rubric?.[1].label, "比較各頂點距離");
  assertThrows(() => parsePaperAnswerKeys(undefined));
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"single","ans":[8],"points":5}]}',
    )
  );
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"fill","ans":[],"points":5}]}',
    )
  );
  assertThrows(() =>
    parsePaperAnswerKeys(
      '{"paper-mock-3":[{"type":"constructed","ans":["10"],"points":8,"rubric":[]}]}',
    )
  );
});

Deno.test("taipeiDate 回傳台北時區的 YYYY-MM-DD", () => {
  const value = taipeiDate();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value));
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assertEquals(value, expected);
});

Deno.test("safetyIdentifier 穩定且不含原始 user id", async () => {
  const a = await safetyIdentifier("user-123");
  const b = await safetyIdentifier("user-123");
  const c = await safetyIdentifier("user-456");
  assertEquals(a, b);
  assert(a !== c);
  assert(a.startsWith("matha_"));
  assert(!a.includes("user-123"));
});

Deno.test("結構化 schema 每一層物件都關閉額外欄位，整卷必含 finalAnswer", () => {
  // 遞迴檢查：任何巢狀層（markSchema、stuckSchema、paper_grade 題目物件…）漏設
  // additionalProperties:false 都會讓 strict json_schema 部署失敗或放行雜欄位
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties) {
      assertEquals(obj.additionalProperties, false);
      assert(Array.isArray(obj.required), `${path} 缺 required`);
      for (const [key, child] of Object.entries(obj.properties)) {
        walk(child, `${path}.${key}`);
      }
    }
    if (obj.type === "array") walk(obj.items, `${path}[]`);
  };
  for (const [name, schema] of Object.entries(responseSchemas)) {
    walk(schema, name);
  }
  const paper = responseSchemas.paper_grade.properties.questions.items;
  assert(paper.required.includes("finalAnswer"));
  assert(paper.required.includes("selectedOptions"));
  assert(paper.required.includes("topic"));
  const correction = responseSchemas.paper_correction_grade;
  assertEquals(correction.required, ["status", "read"]);
  assertEquals(correction.properties.status.enum, [
    "correct",
    "incorrect",
    "unanswered",
    "uncertain",
  ]);
});
